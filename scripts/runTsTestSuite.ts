import { spawn } from "node:child_process";
import path from "node:path";

const SUITES = {
    ai: [
        "testAiModelPresets.ts",
        "testAiRuntimeRouting.ts",
    ],
    memory: [
        "testSessionStorage.ts",
        "testReflectionMemoryFilter.ts",
        "testLegacyPersonalitySanitizer.ts",
        "testContactCommunicationContext.ts",
        "testContactMemoryMatching.ts",
        "testMemoryGapDetector.ts",
        "testConversationSelfMemoryFallback.ts",
        "testKiraSelfMemory.ts",
        "testTodayImportance.ts",
        "testProactiveMemoryEvidence.ts",
    ],
    interaction: [
        "testVoiceReply.ts",
        "testRussianSpeechNumbers.ts",
        "testSpeechTextPreparation.ts",
        "testGroupChatContext.ts",
        "testIncomingTelegramQueue.ts",
        "testChatPromptWatchers.ts",
    ],
    all: [
        "testAiModelPresets.ts",
        "testAiRuntimeRouting.ts",
        "testSessionStorage.ts",
        "testVoiceReply.ts",
        "testRussianSpeechNumbers.ts",
        "testSpeechTextPreparation.ts",
        "testGroupChatContext.ts",
        "testReflectionMemoryFilter.ts",
        "testLegacyPersonalitySanitizer.ts",
        "testContactCommunicationContext.ts",
        "testContactMemoryMatching.ts",
        "testMemoryGapDetector.ts",
        "testConversationSelfMemoryFallback.ts",
        "testKiraSelfMemory.ts",
        "testTodayImportance.ts",
        "testProactiveMemoryEvidence.ts",
        "testIncomingTelegramQueue.ts",
        "testChatPromptWatchers.ts",
    ],
} satisfies Record<string, string[]>;

type SuiteName = keyof typeof SUITES;

const suiteName = (process.argv[2] as SuiteName | undefined) ?? "all";
const suite = SUITES[suiteName];

if (!suite) {
    console.error(`Unknown suite "${suiteName}". Available suites: ${Object.keys(SUITES).join(", ")}`);
    process.exit(1);
}

async function run(): Promise<void> {
    for (const fileName of suite) {
        console.log(`\n==> ${fileName}`);
        await runTsScript(fileName);
    }
}

function runTsScript(fileName: string): Promise<void> {
    const scriptPath = path.join(process.cwd(), "scripts", fileName);
    return new Promise((resolve, reject) => {
        const child = spawn("ts-node", [scriptPath], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: process.env,
            shell: process.platform === "win32",
        });

        child.on("exit", (code, signal) => {
            if (signal) {
                reject(new Error(`Test ${fileName} terminated with signal ${signal}`));
                return;
            }
            if (code && code !== 0) {
                reject(new Error(`Test ${fileName} failed with code ${code}`));
                return;
            }
            resolve();
        });
    });
}

run().catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
});
