export type ReflectionTemporalScope =
    | 'stable'
    | 'preference'
    | 'routine'
    | 'current_state'
    | 'future_plan'
    | 'past_event'
    | 'relationship'
    | 'unknown';

export interface ReflectionFactLike {
    content: string;
    tags?: string[];
    importance?: number;
    confidence?: number;
    temporalScope?: ReflectionTemporalScope;
    memoryKind?: string;
}

const REFLECTION_MIN_CONFIDENCE = 0.55;

function factTemporalScope(fact: ReflectionFactLike): ReflectionTemporalScope {
    if (fact.temporalScope) return fact.temporalScope;
    const tag = fact.tags?.find(value => value.startsWith('temporal_scope:'));
    const value = tag?.split(':')[1];
    switch (value) {
        case 'stable':
        case 'preference':
        case 'routine':
        case 'current_state':
        case 'future_plan':
        case 'past_event':
        case 'relationship':
        case 'unknown':
            return value;
        default:
            return 'unknown';
    }
}

function isReflectionTechnicalNoise(fact: ReflectionFactLike): boolean {
    const content = fact.content.toLowerCase();
    const hasTechnicalMarker =
        /chat\s*gpt|chatgpt|gpt|pro[-\s]?модел|llm|модель|инструмент|уроборос|распозна|портир|перегон|файл|фотограф|слайд|обработк|донастро|загрузил|загрузила|отказал|кринж/iu
            .test(content);
    if (!hasTechnicalMarker) return false;

    const hasDurableWorkflowSignal =
        /обычно|регулярно|часто|предпочита|правило|стандарт|всегда|важно помогать|нужно помогать|устойчив/iu
            .test(content);
    return !hasDurableWorkflowSignal;
}

function isReflectionOneOffActivity(fact: ReflectionFactLike): boolean {
    const content = fact.content.toLowerCase();
    if (/занимается\s+(?:рабочей\s+)?задач|считает\s+.*сложн|готов\s+.*донастро|до сих пор\s+распозна/iu.test(content)) {
        return true;
    }
    if (/(?:попросил|попросила|предложил|предложила|написал|написала|сообщил|сообщила|назвал|назвала)\b.*(?:распозна|объедин|файл|фотограф|слайд|инструмент|chat\s*gpt|chatgpt|gpt|загруз|обработ)/iu.test(content)) {
        return true;
    }
    return false;
}

function isReflectionTemporaryState(fact: ReflectionFactLike): boolean {
    const temporalScope = factTemporalScope(fact);
    if (temporalScope !== 'current_state') return false;

    const content = fact.content.toLowerCase();
    if (/находится\s+в(?:\s|$)/iu.test(content) && !/больниц|клиник|реанимац|командировк|переех|переезд|жив[её]т/iu.test(content)) {
        return true;
    }
    if (!/сейчас|пока|временно|до сих пор|находится|занимается|работает над|пытается|сегодня/iu.test(content)) {
        return false;
    }

    return (fact.importance ?? 0) < 0.78;
}

export function isReflectionFactWorthSaving(fact: ReflectionFactLike): boolean {
    const importance = fact.importance ?? 0;
    const confidence = fact.confidence ?? 0.62;
    if (confidence < REFLECTION_MIN_CONFIDENCE) return false;

    switch (factTemporalScope(fact)) {
        case 'stable':
        case 'preference':
        case 'routine':
        case 'relationship':
            return importance >= 0.48;
        case 'future_plan':
            return importance >= 0.68;
        case 'past_event':
            return importance >= 0.70;
        case 'current_state':
            return importance >= 0.78;
        case 'unknown':
        default:
            return importance >= 0.72 && confidence >= 0.70;
    }
}

export function isReflectionMemoryNoiseCandidate(fact: ReflectionFactLike): boolean {
    if (fact.memoryKind === 'episode' || fact.tags?.includes('memory-episode')) return false;
    return isReflectionTechnicalNoise(fact) ||
        isReflectionOneOffActivity(fact) ||
        isReflectionTemporaryState(fact);
}
