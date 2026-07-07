import assert from 'assert';
import { aiPresets, isTrueFullAiPreset, parseAiPresetName } from '../ai/modelPresets';
import { getFallbackModel } from '../ai/fallbackModels';
import { resolveModelForTask } from '../ai/modelResolver';
import { buildPresetTitle, formatGenerativeUsageSummary, formatServiceSummary, getGenerativeProviderCounts } from '../ai/presetSummary';

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
    assert.deepStrictEqual(resolveModelForTask('messageAnalysis'), {
        provider: 'gemini',
        model: 'gemini-3-flash-preview',
    });
    assert.deepStrictEqual(resolveModelForTask('memoryExtraction'), {
        provider: 'openai',
        model: 'gpt-5.4-nano',
    });
    assert.deepStrictEqual(resolveModelForTask('intentClassification'), {
        provider: 'openai',
        model: 'gpt-5.4-nano',
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

withPreset('gemini-full', () => {
    assert.deepStrictEqual(resolveModelForTask('webSearchReasoning'), {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
    });
    assert.deepStrictEqual(resolveModelForTask('browserVision'), {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
    });
    assert.deepStrictEqual(resolveModelForTask('embedding'), {
        provider: 'gemini',
        model: 'gemini-embedding-2',
    });
    assert.deepStrictEqual(resolveModelForTask('transcription'), {
        provider: 'gemini',
        model: 'gemini-3.5-flash',
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

withPreset('glm-full', () => {
    assert.deepStrictEqual(resolveModelForTask('webSearchReasoning'), {
        provider: 'zai',
        model: 'glm-5.2',
    });
    assert.deepStrictEqual(resolveModelForTask('browserVision'), {
        provider: 'zai',
        model: 'glm-5v-turbo',
    });
    assert.deepStrictEqual(resolveModelForTask('transcription'), {
        provider: 'zai',
        model: 'glm-asr-2512',
    });
});

withPreset('hybrid-deepseek-gpt', () => {
    assert.strictEqual(parseAiPresetName(process.env.AI_MODEL_PRESET), 'hybrid-openrouter-gpt');
    assert.deepStrictEqual(resolveModelForTask('conversation'), {
        provider: 'openrouter',
        model: 'openrouter/auto',
    });
});

withPreset('hybrid-gemini-extended', () => {
    assert.strictEqual(parseAiPresetName(process.env.AI_MODEL_PRESET), 'hybrid-gemini-gpt');
    assert.deepStrictEqual(resolveModelForTask('conversation'), aiPresets['hybrid-gemini-gpt'].models.conversation);
});

withPreset('gemini-direct-balanced', () => {
    assert.strictEqual(parseAiPresetName(process.env.AI_MODEL_PRESET), 'hybrid-gemini-gpt');
    assert.deepStrictEqual(resolveModelForTask('webSearchReasoning'), aiPresets['hybrid-gemini-gpt'].models.webSearchReasoning);
});

assert.deepStrictEqual(getFallbackModel('conversation'), {
    provider: 'openai',
    model: 'gpt-5.4-mini',
});
assert.deepStrictEqual(getFallbackModel('browserVision'), {
    provider: 'openai',
    model: 'gpt-4o',
});
assert.deepStrictEqual(getFallbackModel('embedding'), {
    provider: 'openai',
    model: 'text-embedding-3-small',
});
assert.deepStrictEqual(getFallbackModel('transcription'), {
    provider: 'openai',
    model: 'whisper-1',
});

withPreset('invalid-preset', () => {
    assert.strictEqual(parseAiPresetName(process.env.AI_MODEL_PRESET), null);
    assert.deepStrictEqual(resolveModelForTask('intentClassification'), aiPresets['gpt-balanced'].models.intentClassification);
});

assert.strictEqual(aiPresets['gpt-max'].title, buildPresetTitle(aiPresets['gpt-max'].models, 'Максимум качества'));
assert.strictEqual(aiPresets['gpt-balanced'].title, buildPresetTitle(aiPresets['gpt-balanced'].models, 'Надёжный баланс'));
assert.strictEqual(aiPresets['gpt-lean'].title, buildPresetTitle(aiPresets['gpt-lean'].models, 'Экономный'));
assert.strictEqual(aiPresets['hybrid-gemini-gpt'].title, buildPresetTitle(aiPresets['hybrid-gemini-gpt'].models, 'Рекомендуемый баланс'));
assert.strictEqual(aiPresets['gemini-full'].title, buildPresetTitle(aiPresets['gemini-full'].models, 'Только Gemini'));
assert.strictEqual(aiPresets['glm-full'].title, buildPresetTitle(aiPresets['glm-full'].models, 'Только GLM'));
assert.strictEqual(aiPresets['hybrid-openrouter-gpt'].title, buildPresetTitle(aiPresets['hybrid-openrouter-gpt'].models, 'Экспериментальный'));
assert.strictEqual(aiPresets['glm-balanced'].title, buildPresetTitle(aiPresets['glm-balanced'].models, 'Экспериментальный'));

assert.deepStrictEqual(
    getGenerativeProviderCounts(aiPresets['hybrid-gemini-gpt'].models).map(({ label, count }) => `${label}:${count}`),
    ['Gemini:5', 'GPT:5'],
);
assert.deepStrictEqual(
    getGenerativeProviderCounts(aiPresets['hybrid-openrouter-gpt'].models).map(({ label, count }) => `${label}:${count}`),
    ['GPT:6', 'OpenRouter Auto:4'],
);
assert.strictEqual(formatGenerativeUsageSummary(aiPresets['hybrid-gemini-gpt'].models), 'Gemini 5 · GPT 5');
assert.strictEqual(formatServiceSummary(aiPresets['hybrid-gemini-gpt'].models), 'OpenAI Embeddings · Whisper');
assert.strictEqual(formatServiceSummary(aiPresets['gemini-full'].models), 'Gemini Embeddings · Gemini Transcription');
assert.strictEqual(formatServiceSummary(aiPresets['glm-full'].models), 'OpenAI Embeddings · GLM Transcription');
assert.strictEqual(isTrueFullAiPreset('gemini-full'), true);
assert.strictEqual(isTrueFullAiPreset('glm-full'), true);
assert.strictEqual(isTrueFullAiPreset('gpt-balanced'), false);

console.log('AI model preset smoke tests passed');
