import assert from "node:assert/strict";
import { describe, test } from "node:test";
import {
    AI_PRESET_NAMES,
    aiPresets,
    AiTaskKey,
    parseAiPresetName,
} from "../ai/modelPresets";
import { getFallbackModel } from "../ai/fallbackModels";
import { getEnvAiPresetName } from "../services/aiRuntimeConfigService";

const TASK_KEYS: AiTaskKey[] = [
    "defaultText",
    "intentClassification",
    "intentDedup",
    "conversation",
    "memoryExtraction",
    "memoryConsolidation",
    "messageAnalysis",
    "webSearchReasoning",
    "browserPlanning",
    "browserVision",
    "embedding",
    "transcription",
];

describe("AI preset registry", () => {
    test("contains unique preset names", () => {
        assert.equal(new Set(AI_PRESET_NAMES).size, AI_PRESET_NAMES.length);
        assert.ok(AI_PRESET_NAMES.length > 0);
    });

    test("keeps registry keys and embedded names consistent", () => {
        assert.deepEqual(Object.keys(aiPresets), [...AI_PRESET_NAMES]);
        for (const presetName of AI_PRESET_NAMES) {
            assert.equal(aiPresets[presetName].name, presetName);
            assert.ok(aiPresets[presetName].title.trim());
            assert.ok(aiPresets[presetName].description.trim());
        }
    });

    test("defines every task exactly once in every preset", () => {
        for (const presetName of AI_PRESET_NAMES) {
            assert.deepEqual(Object.keys(aiPresets[presetName].models), TASK_KEYS, presetName);
        }
    });

    test("uses only supported providers and non-empty model IDs", () => {
        const providers = new Set(["openai", "openrouter", "gemini", "zai"]);
        for (const preset of Object.values(aiPresets)) {
            for (const [task, ref] of Object.entries(preset.models)) {
                assert.equal(providers.has(ref.provider), true, `${preset.name}:${task}:${ref.provider}`);
                assert.ok(ref.model.trim(), `${preset.name}:${task}`);
            }
        }
    });

    test("validates preset names strictly", () => {
        for (const presetName of AI_PRESET_NAMES) assert.equal(parseAiPresetName(presetName), presetName);
        for (const value of [undefined, null, "", "gpt-balanced ", "GPT-BALANCED", "unknown"]) {
            assert.equal(parseAiPresetName(value), null, String(value));
        }
    });

    test("keeps OpenAI-only presets on OpenAI", () => {
        for (const name of ["gpt-max", "gpt-balanced", "gpt-lean"] as const) {
            assert.equal(Object.values(aiPresets[name].models).every((ref) => ref.provider === "openai"), true, name);
        }
    });

    test("keeps capability fallbacks on OpenAI outside true-full presets", () => {
        for (const name of ["gpt-max", "gpt-balanced", "gpt-lean", "hybrid-openrouter-gpt", "hybrid-gemini-gpt", "glm-balanced"] as const) {
            const preset = aiPresets[name];
            assert.equal(preset.models.embedding.provider, "openai", preset.name);
            assert.equal(preset.models.transcription.provider, "openai", preset.name);
        }
        assert.equal(aiPresets["gemini-full"].models.embedding.provider, "gemini");
        assert.equal(aiPresets["gemini-full"].models.transcription.provider, "gemini");
        assert.equal(aiPresets["glm-full"].models.embedding.provider, "openai");
        assert.equal(aiPresets["glm-full"].models.transcription.provider, "zai");
    });
});

describe("AI model fallback and environment selection", () => {
    test("uses nano for lightweight structured tasks", () => {
        for (const task of ["intentClassification", "intentDedup", "memoryExtraction", "browserPlanning"] as AiTaskKey[]) {
            assert.deepEqual(getFallbackModel(task), { provider: "openai", model: "gpt-5.4-nano" });
        }
    });

    test("uses a vision-capable fallback for browser screenshots", () => {
        assert.deepEqual(getFallbackModel("browserVision"), { provider: "openai", model: "gpt-4o" });
    });

    test("uses mini for remaining text task types", () => {
        const nanoTasks = new Set<AiTaskKey>(["intentClassification", "intentDedup", "memoryExtraction", "browserPlanning"]);
        for (const task of TASK_KEYS.filter((key) => !nanoTasks.has(key) && !["browserVision", "embedding", "transcription"].includes(key))) {
            assert.deepEqual(getFallbackModel(task), { provider: "openai", model: "gpt-5.4-mini" }, task);
        }
    });

    test("uses task-specific fallbacks for embeddings and transcription", () => {
        assert.deepEqual(getFallbackModel("embedding"), { provider: "openai", model: "text-embedding-3-small" });
        assert.deepEqual(getFallbackModel("transcription"), { provider: "openai", model: "whisper-1" });
    });

    test("uses a valid environment preset and falls back for invalid values", () => {
        const previous = process.env.AI_MODEL_PRESET;
        try {
            process.env.AI_MODEL_PRESET = "gpt-lean";
            assert.equal(getEnvAiPresetName(), "gpt-lean");
            process.env.AI_MODEL_PRESET = "not-a-preset";
            assert.equal(getEnvAiPresetName(), "gpt-balanced");
            delete process.env.AI_MODEL_PRESET;
            assert.equal(getEnvAiPresetName(), "gpt-balanced");
        } finally {
            if (previous === undefined) delete process.env.AI_MODEL_PRESET;
            else process.env.AI_MODEL_PRESET = previous;
        }
    });
});
