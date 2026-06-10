import assert from 'assert';
import { aiPresets, parseAiPresetName } from '../ai/modelPresets';
import { getFallbackModel } from '../ai/fallbackModels';
import { resolveModelForTask } from '../ai/modelResolver';

function withPreset<T>(preset: string, fn: () => T): T {
    const previous = process.env.AI_MODEL_PRESET;
    process.env.AI_MODEL_PRESET = preset;
    try {
        return fn();
    } finally {
        if (previous === undefined) {
            delete process.env.AI_MODEL_PRESET;
        } else {
            process.env.AI_MODEL_PRESET = previous;
        }
    }
}

withPreset('hybrid-openrouter-gpt', () => {
    assert.deepStrictEqual(resolveModelForTask('intentClassification'), {
        provider: 'openai',
        model: 'gpt-5.4-nano',
    });
    assert.deepStrictEqual(resolveModelForTask('conversation'), {
        provider: 'openrouter',
        model: 'openrouter/auto',
    });
});

withPreset('hybrid-gemini-gpt', () => {
    assert.deepStrictEqual(resolveModelForTask('browserVision'), {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
    });
    assert.deepStrictEqual(resolveModelForTask('conversation'), {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
    });
});

withPreset('gemini-direct-balanced', () => {
    assert.deepStrictEqual(resolveModelForTask('embedding'), {
        provider: 'gemini',
        model: 'gemini-embedding-001',
    });
    assert.deepStrictEqual(resolveModelForTask('transcription'), {
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite',
    });
});

assert.deepStrictEqual(getFallbackModel('conversation'), {
    provider: 'openai',
    model: 'gpt-5.4-mini',
});
assert.deepStrictEqual(getFallbackModel('browserVision'), {
    provider: 'openai',
    model: 'gpt-4o',
});

withPreset('invalid-preset', () => {
    assert.strictEqual(parseAiPresetName(process.env.AI_MODEL_PRESET), null);
    assert.deepStrictEqual(resolveModelForTask('intentClassification'), aiPresets['gpt-balanced'].models.intentClassification);
});

console.log('AI model preset smoke tests passed');
