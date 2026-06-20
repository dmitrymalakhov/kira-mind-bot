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
    assert.deepStrictEqual(resolveModelForTask('intentClassification'), {
        provider: 'gemini',
        model: 'gemini-3.1-flash-lite',
    });
    assert.deepStrictEqual(resolveModelForTask('webSearchReasoning'), {
        provider: 'openai',
        model: 'gpt-5.4-mini',
    });
    assert.deepStrictEqual(resolveModelForTask('embedding'), {
        provider: 'openai',
        model: 'text-embedding-3-small',
    });
    assert.deepStrictEqual(resolveModelForTask('transcription'), {
        provider: 'openai',
        model: 'whisper-1',
    });
});

withPreset('glm-balanced', () => {
    assert.deepStrictEqual(resolveModelForTask('intentClassification'), {
        provider: 'openai',
        model: 'gpt-5.4-nano',
    });
    assert.deepStrictEqual(resolveModelForTask('intentDedup'), {
        provider: 'openai',
        model: 'gpt-5.4-nano',
    });
    assert.deepStrictEqual(resolveModelForTask('conversation'), {
        provider: 'zai',
        model: 'glm-5.2',
    });
    assert.deepStrictEqual(resolveModelForTask('browserPlanning'), {
        provider: 'zai',
        model: 'glm-5.2',
    });
    assert.deepStrictEqual(resolveModelForTask('browserVision'), {
        provider: 'openai',
        model: 'gpt-4o',
    });
    assert.deepStrictEqual(resolveModelForTask('embedding'), {
        provider: 'openai',
        model: 'text-embedding-3-small',
    });
});

withPreset('hybrid-deepseek-gpt', () => {
    assert.strictEqual(parseAiPresetName(process.env.AI_MODEL_PRESET), 'hybrid-openrouter-gpt');
    assert.deepStrictEqual(resolveModelForTask('conversation'), {
        provider: 'openrouter',
        model: 'openrouter/auto',
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
