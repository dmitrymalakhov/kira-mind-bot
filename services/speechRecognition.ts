import * as dotenv from "dotenv";
import * as fs from 'fs';
import * as path from 'path';
import fetch from 'node-fetch';
import openai from "../openai";

// Загрузка переменных окружения
dotenv.config({ path: `.env.${process.env.NODE_ENV}` });


/**
 * Конвертирует голосовое сообщение из формата OGG в MP3
 * @param oggFilePath Путь к файлу OGG
 * @returns Путь к конвертированному MP3 файлу
 */
export async function convertOggToMp3(oggFilePath: string): Promise<string> {
    try {
        // Здесь должна быть логика конвертации OGG в MP3
        // Для этого можно использовать ffmpeg или другие библиотеки
        // В данной реализации возвращаем тот же файл, предполагая что OpenAI может принять OGG
        // TODO: добавить реальную конвертацию при необходимости
        return oggFilePath;
    } catch (error) {
        console.error("Error converting OGG to MP3:", error);
        throw error;
    }
}

/**
 * Распознает речь из аудиофайла
 * @param audioFilePath Путь к аудиофайлу
 * @returns Распознанный текст
 */
export async function transcribeAudio(audioFilePath: string): Promise<string> {
    try {
        // В Node.js среде OpenAI SDK принимает файловый поток
        // Используем createReadStream для создания потока из файла
        const audioFileStream = fs.createReadStream(audioFilePath);

        // Отправляем запрос на транскрипцию в OpenAI
        const transcription = await openai.audio.transcriptions.create({
            file: audioFileStream,
            model: "whisper-1",
            language: "ru",
            response_format: "text",
        });

        return transcription;
    } catch (error) {
        console.error("Error transcribing audio:", error);
        throw error;
    }
}

/**
 * Загружает голосовое сообщение из Telegram
 * @param fileUrl URL файла из Telegram API
 * @param destPath Путь для сохранения файла
 * @returns Путь к сохраненному файлу
 */
export async function downloadVoiceMessage(fileUrl: string, destPath: string): Promise<string> {
    try {
        const response = await fetch(fileUrl);
        const arrayBuffer = await response.arrayBuffer();
        const buffer = Buffer.from(arrayBuffer);

        fs.writeFileSync(destPath, buffer);
        return destPath;
    } catch (error) {
        console.error("Error downloading voice message:", error);
        throw error;
    }
}