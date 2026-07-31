import type { ConversationReplyContext, MessageHistory, SessionData } from '../types';

const PROACTIVE_SOURCE_QUESTION_RE = /(?:откуда\s+ты\s+(?:это\s+)?(?:взял[ао]?|знаешь)|на\s+основе\s+чего\s+ты\s+(?:это\s+)?(?:написал[ао]?|сказал[ао]?|решил[ао]?)|из\s+какой\s+(?:памяти|записи|подсказки)|какой\s+(?:именно\s+)?факт\s+ты\s+использовал[ао]?|о\s+ком\s+(?:была|эта)\s+подсказка|что\s+ты\s+имел[ао]?\s+в\s+виду\s+в\s+(?:этой\s+)?подсказке|^(?:какую?|какой|какое|какие)\s+(?:ещ[её]\s+)?[\p{L}\p{N}_-]+\??$|^что\s+за\s+[\p{L}\p{N}_-]+\??$|^о\s+ч[её]м\s+ты\??$|^что\s+ты\s+имеешь\s+в\s+виду\??$)/iu;
const LEGACY_KIRA_LIFE_STATIC_FALLBACK_SOURCE =
    'Безопасный резервный текст после отклонения исходного кандидата';

export const IMMEDIATE_PROACTIVE_CONTEXT_TTL_MS = 10 * 60 * 1000;

export function isProactiveSourceQuestion(message: string): boolean {
    return PROACTIVE_SOURCE_QUESTION_RE.test(message.trim());
}

function followsLatestProactiveMessage(
    message: string,
    history: MessageHistory[],
    insight: NonNullable<SessionData['lastProactiveInsight']>,
): boolean {
    const latest = history[0];
    const previous = history[1];
    return latest?.role === 'user' && latest.content.trim() === message.trim()
        && previous?.role === 'bot' && previous.content.trim() === insight.message.trim();
}

function isFreshProactiveInsight(
    insight: SessionData['lastProactiveInsight'],
    now: number,
): insight is NonNullable<SessionData['lastProactiveInsight']> {
    if (!insight?.messageId) return false;
    const ageMs = now - Number(insight.createdAt || 0);
    return ageMs >= 0 && ageMs <= 3 * 24 * 60 * 60 * 1000;
}

export function resolveProactiveSourceQuestion(params: {
    message: string;
    replyContext?: ConversationReplyContext;
    history?: MessageHistory[];
    insight?: SessionData['lastProactiveInsight'];
    now?: number;
}): NonNullable<SessionData['lastProactiveInsight']> | undefined {
    const { message, replyContext, history = [], insight, now = Date.now() } = params;
    if (!isProactiveSourceQuestion(message)) return undefined;

    if (replyContext) {
        const replyInsight = replyContext.proactiveInsight;
        if (isFreshProactiveInsight(replyInsight, now) && replyInsight.messageId === replyContext.messageId) {
            return replyInsight;
        }
        // Backward compatibility для старых session-записей без per-message provenance.
        if (isFreshProactiveInsight(insight, now) && insight.messageId === replyContext.messageId) {
            return insight;
        }
        return undefined;
    }

    if (!isFreshProactiveInsight(insight, now)) return undefined;
    const ageMs = now - insight.createdAt;
    if (ageMs > IMMEDIATE_PROACTIVE_CONTEXT_TTL_MS) return undefined;
    return followsLatestProactiveMessage(message, history, insight) ? insight : undefined;
}

export function buildProactiveSourceExplanation(
    insight: NonNullable<SessionData['lastProactiveInsight']>,
): string {
    const sourceMemories = Array.isArray(insight.sourceMemories)
        ? insight.sourceMemories
        : [];
    const hasLegacyStaticFallbackSource = insight.kind === 'kiraLife'
        && insight.generationOutcome === 'fallback'
        && sourceMemories.length === 1
        && sourceMemories[0] === LEGACY_KIRA_LIFE_STATIC_FALLBACK_SOURCE;
    const sources = (hasLegacyStaticFallbackSource ? [] : sourceMemories)
        .slice(0, 5)
        .map((source, index) => `${index + 1}. ${source}`)
        .join('\n');
    const webSources = Array.isArray(insight.webSources)
        ? insight.webSources
            .slice(0, 5)
            .map((source, index) => `${index + 1}. ${source}`)
            .join('\n')
        : '';

    if (insight.kind === 'kiraLife') {
        if (insight.generationOutcome === 'fallback') {
            if (!sources) {
                return [
                    'Это было безопасное резервное сообщение Kira Life.',
                    '',
                    `Сообщение: «${insight.message}»`,
                    '',
                    'Разговорная формулировка и событие не прошли локальную проверку, поэтому был использован нейтральный текст без источников.',
                ].join('\n');
            }
            return [
                'Это было собственное событие Kira Life в безопасной резервной форме.',
                '',
                `Сообщение: «${insight.message}»`,
                '',
                'Разговорная формулировка не прошла проверку атрибуции или reviewer был недоступен, поэтому вместо неё было отправлено само событие.',
                '',
                `Событие, использованное в сообщении:\n${sources}`,
                ...(webSources
                    ? ['', `Актуальные детали события были проверены по веб-источникам:\n${webSources}`]
                    : []),
            ].join('\n');
        }
        if (!sources) {
            return 'Источник той подсказки не сохранился, поэтому честно объяснить её происхождение нельзя. Это ошибка в логике проактивных сообщений.';
        }
        return [
            'Это сообщение было сгенерировано из моей внутренней линии жизни, а не из твоей памяти.',
            '',
            `Сообщение: «${insight.message}»`,
            '',
            `События, на которых оно строилось:\n${sources}`,
            ...(webSources
                ? ['', `Актуальные детали были проверены по веб-источникам:\n${webSources}`]
                : []),
            '',
            'Если в сообщении появилась задача, обещание или дедлайн, которых ты не называла, это моя ошибка: такого вывода из этих событий делать было нельзя.',
        ].join('\n');
    }

    if (!sources) {
        return 'Источник той подсказки не сохранился, поэтому честно объяснить её происхождение нельзя. Это ошибка в логике проактивных сообщений.';
    }

    return [
        'Это сообщение было сформировано из проактивной памяти, а не из текущей переписки.',
        '',
        `Моя подсказка была: «${insight.message}»`,
        '',
        `Факты, на которые я опиралась:\n${sources}`,
        '',
        'Если эти факты не подтверждают вывод, значит связь памяти с сообщением была определена неверно.',
    ].join('\n');
}
