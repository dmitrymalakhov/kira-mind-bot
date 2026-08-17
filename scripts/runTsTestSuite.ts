import { spawn } from "node:child_process";
import path from "node:path";
import { buildSyntheticTestEnv } from './testEnv';

const SUITES = {
    ai: [
        "testAiModelPresets.ts",
        "testAiRuntimeConfigService.ts",
        "testAiRuntimeRouting.ts",
        "testAiUsageLogging.ts",
        "testProviderPolicy.ts",
        "testGeminiConcurrency.ts",
        "testWebSearchFailureFlow.ts",
        "testKiraLifeWebGrounding.ts",
    ],
    memory: [
        "testMemoryRetrieval.ts",
        "testQdrantHybridRetrieval.ts",
        "testQdrantMemoryProfileCompatibility.ts",
        "testSessionStorage.ts",
        "testReflectionMemoryFilter.ts",
        "testMemoryAudit.ts",
        "testQdrantMemoryAuditPagination.ts",
        "testFactAttributionFilter.ts",
        "testPersonRelation.ts",
        "testUserSynthesisFilter.ts",
        "testLegacyPersonalitySanitizer.ts",
        "testPersonalityGender.ts",
        "testContactCommunicationContext.ts",
        "testContactMemoryMatching.ts",
        "testMemoryGapDetector.ts",
        "testConversationSelfMemoryFallback.ts",
        "testKiraSelfMemory.ts",
        "testGeminiStudyChatFlow.ts",
        "testTodayImportance.ts",
        "testProactiveMemoryEvidence.ts",
        "testProactiveGrounding.ts",
        "testContextKnowledgeRouting.ts",
    ],
    interaction: [
        "testAssistantSelfPhoto.ts",
        "testVoiceReply.ts",
        "testRussianSpeechNumbers.ts",
        "testSpeechTextPreparation.ts",
        "testGroupChatContext.ts",
        "testIncomingTelegramQueue.ts",
        "testTelegramMessageEdit.ts",
        "testChatPromptWatchers.ts",
        "testRichMessage.ts",
        "testHelpMessage.ts",
    ],
    all: [
        "testAiModelPresets.ts",
        "testAiRuntimeConfigService.ts",
        "testAiRuntimeRouting.ts",
        "testAiUsageLogging.ts",
        "testProviderPolicy.ts",
        "testGeminiConcurrency.ts",
        "testWebSearchFailureFlow.ts",
        "testKiraLifeWebGrounding.ts",
        "testMemoryRetrieval.ts",
        "testQdrantHybridRetrieval.ts",
        "testQdrantMemoryProfileCompatibility.ts",
        "testSessionStorage.ts",
        "testVoiceReply.ts",
        "testRussianSpeechNumbers.ts",
        "testSpeechTextPreparation.ts",
        "testGroupChatContext.ts",
        "testReflectionMemoryFilter.ts",
        "testMemoryAudit.ts",
        "testQdrantMemoryAuditPagination.ts",
        "testFactAttributionFilter.ts",
        "testPersonRelation.ts",
        "testUserSynthesisFilter.ts",
        "testLegacyPersonalitySanitizer.ts",
        "testPersonalityGender.ts",
        "testContactCommunicationContext.ts",
        "testContactMemoryMatching.ts",
        "testMemoryGapDetector.ts",
        "testConversationSelfMemoryFallback.ts",
        "testKiraSelfMemory.ts",
        "testGeminiStudyChatFlow.ts",
        "testTodayImportance.ts",
        "testProactiveMemoryEvidence.ts",
        "testProactiveGrounding.ts",
        "testContextKnowledgeRouting.ts",
        "testAssistantSelfPhoto.ts",
        "testIncomingTelegramQueue.ts",
        "testTelegramMessageEdit.ts",
        "testChatPromptWatchers.ts",
        "testRichMessage.ts",
        "testHelpMessage.ts",
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
    const testEnv = buildSyntheticTestEnv();
    return new Promise((resolve, reject) => {
        const child = spawn("ts-node", [scriptPath], {
            cwd: process.cwd(),
            stdio: "inherit",
            env: testEnv,
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
