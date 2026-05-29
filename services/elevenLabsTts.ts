import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto";
import { execFile } from "child_process";
import { promisify } from "util";
import { ElevenLabs, ElevenLabsClient } from "@elevenlabs/elevenlabs-js";
import { config } from "../config";
import { prepareTextForSpeech } from "../utils/speechText";

const TEMP_DIR = path.join(process.cwd(), "temp");
const execFileAsync = promisify(execFile);
const ELEVEN_LABS_TTS_RETRY_DELAYS_MS = [500, 1500];

let resolvedVoiceId: string | null = null;
let elevenLabsClient: ElevenLabsClient | null = null;
let ffmpegAvailable: boolean | null = null;

export interface GeneratedSpeechFile {
    filePath: string;
    filename: string;
    outputFormat: string;
}

export interface TelegramVoiceFile {
    filePath: string;
    filename: string;
    cleanupPaths: string[];
}

export function getMissingElevenLabsConfig(): string[] {
    const missing: string[] = [];
    if (!config.elevenLabsApiKey) missing.push("ELEVENLABS_API_KEY");
    if (!config.elevenLabsVoiceId && !config.elevenLabsVoiceName) {
        missing.push("ELEVENLABS_VOICE_ID");
    }
    return missing;
}

export function isElevenLabsTtsConfigured(): boolean {
    return getMissingElevenLabsConfig().length === 0;
}

function getOutputExtension(outputFormat: string): string {
    if (outputFormat.startsWith("mp3_")) return "mp3";
    if (outputFormat.startsWith("opus_")) return "ogg";
    if (outputFormat.startsWith("pcm_")) return "pcm";
    if (outputFormat.startsWith("ulaw_")) return "ulaw";
    if (outputFormat.startsWith("alaw_")) return "alaw";
    return "audio";
}

function needsFfmpegForTelegramVoice(outputFormat: string): boolean {
    return !outputFormat.startsWith("opus_");
}

async function hasFfmpeg(): Promise<boolean> {
    if (ffmpegAvailable !== null) return ffmpegAvailable;

    try {
        await execFileAsync("ffmpeg", ["-version"], { timeout: 3000 });
        ffmpegAvailable = true;
    } catch {
        ffmpegAvailable = false;
    }

    return ffmpegAvailable;
}

function ensureTempDir(): void {
    if (!fs.existsSync(TEMP_DIR)) {
        fs.mkdirSync(TEMP_DIR, { recursive: true });
    }
}

function getElevenLabsClient(): ElevenLabsClient {
    if (!elevenLabsClient) {
        elevenLabsClient = new ElevenLabsClient({
            apiKey: config.elevenLabsApiKey,
        });
    }
    return elevenLabsClient;
}

export async function getTelegramVoiceReadinessIssue(text: string): Promise<string | null> {
    const missing = getMissingElevenLabsConfig();
    if (missing.length > 0) {
        return `Голосовой ответ пока не настроен: добавь ${missing.join(", ")} в env.`;
    }

    const preparedText = prepareTextForSpeech(text);
    if (!preparedText) {
        return "Голосовой ответ не отправлен: после очистки текста не осталось содержимого для озвучки.";
    }

    if (preparedText.length > config.elevenLabsMaxTextChars) {
        return `Голосовой ответ не отправлен: текст слишком длинный (${preparedText.length}/${config.elevenLabsMaxTextChars}).`;
    }

    if (needsFfmpegForTelegramVoice(config.elevenLabsOutputFormat) && !(await hasFfmpeg())) {
        return "Голосовой ответ пока недоступен: для Telegram voice нужен ffmpeg, потому что ElevenLabs отдаёт не OGG/Opus.";
    }

    return null;
}

async function resolveVoiceId(): Promise<string> {
    if (config.elevenLabsVoiceId) return config.elevenLabsVoiceId;
    if (resolvedVoiceId) return resolvedVoiceId;

    const voiceName = config.elevenLabsVoiceName?.trim();
    if (!voiceName) {
        throw new Error("ELEVENLABS_VOICE_ID is not configured");
    }

    let nextPageToken: string | null | undefined;
    do {
        const data = await getElevenLabsClient().voices.search({
            search: voiceName,
            pageSize: 100,
            ...(nextPageToken ? { nextPageToken } : {}),
        });
        const voice = data.voices?.find((item) => item.name?.toLowerCase() === voiceName.toLowerCase());
        if (voice?.voiceId) {
            resolvedVoiceId = voice.voiceId;
            return resolvedVoiceId;
        }

        nextPageToken = data.hasMore ? data.nextPageToken : null;
    } while (nextPageToken);

    throw new Error(`ElevenLabs voice "${voiceName}" was not found. Set ELEVENLABS_VOICE_ID explicitly.`);
}

function buildVoiceSettings(): ElevenLabs.VoiceSettings | undefined {
    const settings: ElevenLabs.VoiceSettings = {};
    if (config.elevenLabsVoiceStability !== undefined) settings.stability = config.elevenLabsVoiceStability;
    if (config.elevenLabsVoiceSimilarityBoost !== undefined) settings.similarityBoost = config.elevenLabsVoiceSimilarityBoost;
    if (config.elevenLabsVoiceStyle !== undefined) settings.style = config.elevenLabsVoiceStyle;
    if (config.elevenLabsVoiceSpeed !== undefined) settings.speed = config.elevenLabsVoiceSpeed;
    if (config.elevenLabsVoiceUseSpeakerBoost !== undefined) settings.useSpeakerBoost = config.elevenLabsVoiceUseSpeakerBoost;
    return Object.keys(settings).length > 0 ? settings : undefined;
}

function getErrorStatus(error: unknown): number | undefined {
    const candidate = error as {
        status?: number;
        statusCode?: number;
        response?: { status?: number; statusCode?: number };
    };
    return candidate?.status ?? candidate?.statusCode ?? candidate?.response?.status ?? candidate?.response?.statusCode;
}

function isRetryableElevenLabsError(error: unknown): boolean {
    const status = getErrorStatus(error);
    if (status !== undefined) {
        return status === 408 || status === 409 || status === 425 || status === 429 || status >= 500;
    }

    const code = (error as NodeJS.ErrnoException)?.code;
    return code === "ECONNRESET" ||
        code === "ETIMEDOUT" ||
        code === "ECONNABORTED" ||
        code === "EAI_AGAIN" ||
        code === "ENOTFOUND";
}

function wait(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

async function convertTextToSpeechWithRetry(
    voiceId: string,
    preparedText: string,
    outputFormat: string
): Promise<ReadableStream<Uint8Array>> {
    let lastError: unknown;

    for (let attempt = 0; attempt <= ELEVEN_LABS_TTS_RETRY_DELAYS_MS.length; attempt += 1) {
        try {
            return await getElevenLabsClient().textToSpeech.convert(voiceId, {
                text: preparedText,
                modelId: config.elevenLabsModelId,
                outputFormat: outputFormat as ElevenLabs.TextToSpeechConvertRequestOutputFormat,
                voiceSettings: buildVoiceSettings(),
            });
        } catch (error) {
            lastError = error;
            const retryDelay = ELEVEN_LABS_TTS_RETRY_DELAYS_MS[attempt];
            if (retryDelay === undefined || !isRetryableElevenLabsError(error)) {
                throw error;
            }

            const status = getErrorStatus(error);
            console.warn(`[elevenlabs-tts] convert failed, retrying in ${retryDelay}ms`, {
                attempt: attempt + 1,
                status,
                code: (error as NodeJS.ErrnoException)?.code,
            });
            await wait(retryDelay);
        }
    }

    throw lastError instanceof Error ? lastError : new Error("ElevenLabs TTS conversion failed");
}

async function audioStreamToBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
    const reader = stream.getReader();
    const chunks: Uint8Array[] = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) chunks.push(value);
    }
    return Buffer.concat(chunks.map((chunk) => Buffer.from(chunk)));
}

export async function removeGeneratedVoiceFiles(filePaths: string[]): Promise<void> {
    const uniquePaths = [...new Set(filePaths.filter(Boolean))];
    for (const filePath of uniquePaths) {
        try {
            await fs.promises.unlink(filePath);
        } catch (error) {
            if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") {
                console.warn(`[elevenlabs-tts] failed to remove temp voice file: ${filePath}`, error);
            }
        }
    }
}

export async function withTelegramVoiceFile<T>(
    text: string,
    callback: (voice: TelegramVoiceFile) => Promise<T>
): Promise<T> {
    const speech = await generateSpeechFile(text);
    let cleanupPaths = [speech.filePath];

    try {
        const voice = await prepareTelegramVoiceFile(speech);
        cleanupPaths = voice.cleanupPaths;
        return await callback(voice);
    } finally {
        await removeGeneratedVoiceFiles(cleanupPaths);
    }
}

export async function prepareTelegramVoiceFile(speech: GeneratedSpeechFile): Promise<TelegramVoiceFile> {
    if (speech.outputFormat.startsWith("opus_") || speech.filename.endsWith(".ogg")) {
        return {
            filePath: speech.filePath,
            filename: speech.filename.endsWith(".ogg") ? speech.filename : speech.filename.replace(/\.[^.]+$/, ".ogg"),
            cleanupPaths: [speech.filePath],
        };
    }

    ensureTempDir();
    const filename = speech.filename.replace(/\.[^.]+$/, ".ogg");
    const filePath = path.join(TEMP_DIR, filename);

    await execFileAsync("ffmpeg", [
        "-y",
        "-i", speech.filePath,
        "-vn",
        "-ac", "1",
        "-ar", "48000",
        "-c:a", "libopus",
        "-b:a", "64k",
        filePath,
    ]);

    return {
        filePath,
        filename,
        cleanupPaths: [speech.filePath, filePath],
    };
}

export async function generateSpeechFile(text: string): Promise<GeneratedSpeechFile> {
    const missing = getMissingElevenLabsConfig();
    if (missing.length > 0) {
        throw new Error(`ElevenLabs TTS is not configured: ${missing.join(", ")}`);
    }

    const preparedText = prepareTextForSpeech(text);
    if (!preparedText) {
        throw new Error("Cannot generate speech from empty text");
    }
    if (preparedText.length > config.elevenLabsMaxTextChars) {
        throw new Error(`Text is too long for voice reply: ${preparedText.length}/${config.elevenLabsMaxTextChars}`);
    }

    const voiceId = await resolveVoiceId();
    const outputFormat = config.elevenLabsOutputFormat;
    const audioStream = await convertTextToSpeechWithRetry(voiceId, preparedText, outputFormat);

    ensureTempDir();

    const extension = getOutputExtension(outputFormat);
    const filename = `elevenlabs-${Date.now()}-${crypto.randomBytes(4).toString("hex")}.${extension}`;
    const filePath = path.join(TEMP_DIR, filename);
    const audio = await audioStreamToBuffer(audioStream);
    fs.writeFileSync(filePath, audio);

    return { filePath, filename, outputFormat };
}
