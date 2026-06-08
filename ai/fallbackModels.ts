import type { AiModelRef, AiTaskKey } from './modelPresets';

export function getFallbackModel(taskKey: AiTaskKey): AiModelRef {
    if (
        taskKey === 'intentClassification' ||
        taskKey === 'intentDedup' ||
        taskKey === 'memoryExtraction' ||
        taskKey === 'browserPlanning'
    ) {
        return {
            provider: 'openai',
            model: 'gpt-5.4-nano',
        };
    }

    if (taskKey === 'browserVision') {
        return {
            provider: 'openai',
            model: 'gpt-4o',
        };
    }

    return {
        provider: 'openai',
        model: 'gpt-5.4-mini',
    };
}
