import modelPresetRegistry from '../admin-panel/src/ai-model-presets.json';

/**
 * Поддерживаемые текстовые AI-провайдеры runtime-слоя.
 *
 * Значение используется в task-aware резолвере, чтобы выбрать нужный клиент
 * и понять, требуется ли OpenAI fallback для API, которые пока не абстрагированы.
 */
export type AiProvider = 'openai' | 'openrouter' | 'gemini';

/**
 * Ключ задачи, для которой подбирается модель из preset registry.
 *
 * Эти ключи являются стабильным контрактом между:
 * - runtime-резолвом моделей;
 * - админкой с настройкой preset-ов;
 * - wrapper-ами `createChatCompletionForTask` / `createResponseForTask`;
 * - прикладным кодом, который выбирает модель по назначению, а не по строке.
 */
export type AiTaskKey =
    | 'defaultText'
    | 'intentClassification'
    | 'intentDedup'
    | 'conversation'
    | 'memoryExtraction'
    | 'memoryConsolidation'
    | 'messageAnalysis'
    | 'webSearchReasoning'
    | 'browserPlanning'
    | 'browserVision'
    | 'embedding'
    | 'transcription';

/**
 * Ссылка на конкретную модель конкретного провайдера.
 *
 * Это минимальная единица конфигурации в preset registry:
 * runtime сначала выбирает `provider`, затем соответствующий `model`.
 */
export interface AiModelRef {
    provider: AiProvider;
    model: string;
}

/**
 * Канонические имена preset-ов, доступных для runtime-переключения.
 *
 * Значение хранится в БД/ENV как строка и затем валидируется через
 * {@link parseAiPresetName}.
 */
export type AiPresetName =
    | 'gpt-max'
    | 'gpt-balanced'
    | 'gpt-lean'
    | 'hybrid-openrouter-gpt'
    | 'hybrid-gemini-gpt'
    | 'gemini-direct-balanced';

/**
 * Полная конфигурация одного AI preset-а.
 *
 * Каждый preset обязан задать модель для каждой задачи из {@link AiTaskKey},
 * чтобы runtime мог детерминированно резолвить `provider + model` без локальных override.
 */
export interface AiPresetConfig {
    name: AiPresetName;
    title: string;
    description: string;
    models: Record<AiTaskKey, AiModelRef>;
}

/**
 * Внутренняя форма JSON registry, загружаемого из admin-panel.
 */
interface AiPresetRegistry {
    presetNames: AiPresetName[];
    presets: Record<AiPresetName, AiPresetConfig>;
}

const registry = modelPresetRegistry as AiPresetRegistry;
const LEGACY_AI_PRESET_ALIASES: Readonly<Record<string, AiPresetName>> = {
    'hybrid-deepseek-gpt': 'hybrid-openrouter-gpt',
};

/**
 * Упорядоченный список допустимых имён preset-ов.
 *
 * Используется для валидации строковых значений из ENV, БД и внешних форм.
 */
export const AI_PRESET_NAMES = registry.presetNames;

/**
 * Словарь всех preset-ов по их каноническому имени.
 */
export const aiPresets = registry.presets;

/** Готовый shortcut к preset-у `gpt-max`. */
export const gptMaxPreset = aiPresets['gpt-max'];
/** Готовый shortcut к preset-у `gpt-balanced`. */
export const gptBalancedPreset = aiPresets['gpt-balanced'];
/** Готовый shortcut к preset-у `gpt-lean`. */
export const gptLeanPreset = aiPresets['gpt-lean'];
/** Готовый shortcut к hybrid preset-у `openrouter + openai fallback`. */
export const hybridOpenRouterGptPreset = aiPresets['hybrid-openrouter-gpt'];
/** Готовый shortcut к hybrid preset-у `gemini + openai fallback`. */
export const hybridGeminiGptPreset = aiPresets['hybrid-gemini-gpt'];
/** Готовый shortcut к direct preset-у `gemini only`. */
export const geminiDirectBalancedPreset = aiPresets['gemini-direct-balanced'];

/**
 * Валидирует произвольную строку как имя известного AI preset-а.
 *
 * @param raw Сырое значение из ENV, БД или пользовательского ввода.
 * @returns Каноническое имя preset-а, если оно известно runtime, иначе `null`.
 */
export function parseAiPresetName(raw: string | undefined | null): AiPresetName | null {
    if (!raw) return null;
    const normalized = LEGACY_AI_PRESET_ALIASES[raw] ?? raw;
    return AI_PRESET_NAMES.includes(normalized as AiPresetName) ? normalized as AiPresetName : null;
}
