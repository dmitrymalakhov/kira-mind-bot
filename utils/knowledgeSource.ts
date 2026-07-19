import type { ConversationReplyContext, KnowledgeSourceDecision } from '../types';

const SELF_RE = /(?:кто\s+ты|расскажи\s+(?:о|про)\s+себя|тво[яйёе]\s+(?:жизн|биограф|истори|цель|памят))/iu;
const PERSONAL_RE = /(?:обо?\s+мне|про\s+меня|(?:что|как)\s+мне(?:\s+сейчас)?\s+(?:делать|поступить|сказать|ответить|решить|справиться)|(?:как|что)\s+(?:поговорить|обсудить|сказать|ответить)[\s\S]{0,60}(?:жен|муж|мам|пап|друг|подруг|коллег)|у\s+меня|со\s+мной|мо(?:й|я|ё|и|его|ей|их)\s+(?:жен|муж|мам|пап|друг|подруг|работ|здоров|план|напомин|отнош|семь|коллег)|что\s+ты\s+(?:знаешь|помнишь)\s+(?:обо?\s+мне|про\s+))/iu;
const PERSONAL_HEALTH_RE = /(?:мо(?:и|их|его|ей)\s+(?:анализ|симптом|диагноз|лекарств)|про\s+мо[её]\s+здоровье|что\s+у\s+меня\s+(?:болит|с\s+давлением))/iu;
const PERSONAL_OWNER_REF = String.raw`(?<![\p{L}\p{N}])(?:я|мам[ауы]|пап[ауы]|жен[ауы]|муж(?:а)?|друг(?:а)?|подруг[ауы]|коллег[ауы]|мо(?:й|я|ё|и|его|ей|их)\s+(?:мам[а-яё]*|пап[а-яё]*|жен[а-яё]*|муж[а-яё]*|друг[а-яё]*|подруг[а-яё]*|коллег[а-яё]*|семь[а-яё]*|реб[её]н[а-яё]*|сын[а-яё]*|доч[а-яё]*))(?![\p{L}\p{N}])`;
const PERSONAL_STATE_VERB = String.raw`(?:принима(?:ю|ет|ют)|работа(?:ю|ет|ют)|леч(?:усь|ится|атся)|боле(?:ю|ет|ют)|планиру(?:ю|ет|ют))`;
const PERSONAL_LIFE_STATE_RE = new RegExp(
    String.raw`(?:${PERSONAL_STATE_VERB}[\s\S]{0,40}${PERSONAL_OWNER_REF}|${PERSONAL_OWNER_REF}[\s\S]{0,40}${PERSONAL_STATE_VERB}|должност[\p{L}]*[\s\S]{0,30}(?:у\s+(?:меня|моего|моей|мамы|папы|жены|мужа|друга|подруги)|мо(?:й|я|ё|и|его|ей|их)))`,
    'iu',
);
const EXPLICIT_PERSONAL_MEMORY_RE = /(?:что\s+ты\s+(?:знаешь|помнишь)|что\s+известно)[\s\S]{0,80}(?:обо?\s+мне|про\s+меня|мо(?:й|я|ё|и|его|ей|их)|у\s+нас|нашей|нашего)/iu;
const PERSONAL_RULES_RE = /правил[\p{L}]*[\s\S]{0,40}(?:в\s+(?:моей|нашей)\s+семье|в\s+моих\s+отношениях|между\s+нами)/iu;
const CURRENT_CUE_RE = /(?:текущ(?:ий|ая|ее|ие|его|ей|ем)|сейчас|сегодня|свеж(?:ий|ая|ие|ее)|последн(?:ий|яя|ие|ее|их)|актуальн|что\s+происходит|кто\s+играет)/iu;
const EXTERNAL_ENTITY_RE = /(?:чемпионат|турнир|матч|команд[аы]|лиг[аеи]|новост|фильм|сериал|книг|компан|продукт|модел[ьи]|город|стран|ресторан|магазин|сервис|сайт|оператор|провайдер|интернет|связь|доставк|рынок|курс\s+валют|выбор[ыо]|правительств|поезд|самол[её]т|рейс|транспорт|выстав|концерт|театр|музей|лекарств|препарат|программ|библиотек|фреймворк|typescript|javascript|node(?:\.js)?|релиз|верс(?:ия|ии|ию))/iu;
const VOLATILE_EXTERNAL_RE = /(?:расписани|результат|сч[её]т|новост|цен[аы]|сколько\s+стоит|наличи|закон|правил[ао]|должност|президент|директор|гендир|ceo|афиш|билет|мероприяти|рейтинг|погод|курс\s+валют|кто\s+возглавля|кто\s+руковод)/iu;
const STRONG_EXTERNAL_CURRENT_RE = /(?:новост|цен[аы]|сколько\s+стоит|наличи|закон|правил[ао]|должност|президент|директор|гендир|ceo|афиш|билет|мероприяти|погод|курс\s+валют|кто\s+возглавля|кто\s+руковод)/iu;
const EXTERNAL_RECOMMENDATION_RE = /(?:порекомендуй|посоветуй|подбери|что\s+выбрать|куда\s+(?:сходить|поехать))/iu;
const INTERPERSONAL_ADVICE_RE = /(?:что\s+выбрать|как\s+лучше|стоит\s+ли|порекомендуй|посоветуй)[\s\S]{0,100}(?:поговорить|промолчать|сказать|ответить|обсудить|помириться)[\s\S]{0,60}(?:жен|муж|мам|пап|друг|подруг|коллег)/iu;
const CURRENT_EXTERNAL_FORM_RE = /(?:последн|актуальн|свеж)[\s\S]{0,40}(?:верс|релиз|обновлен)|(?:верс|релиз|обновлен)[\s\S]{0,40}(?:сейчас|последн|актуальн|свеж)/iu;
const PERSON_MEMORY_RE = /(?:что\s+(?:ты\s+)?(?:знаешь|помнишь)|что\s+известно|расскажи\s+(?:мне\s+)?(?:что\s+(?:ты\s+)?(?:знаешь|помнишь)\s+)?)(?:о|об|про)\s+(?:мо(?:его|ю|их)|друга|подругу|жену|мужа|маму|папу|коллегу|@[a-z0-9_]{3,32})/iu;
const EXPLICIT_REMINDER_RE = /(?:^|\s)(?:напомни|напоминай|не\s+дай\s+забыть|не\s+забудь|создай\s+напоминание)(?=\s|$|[,.!?;:])/iu;
const EXTERNAL_LOOKUP_WITH_ACTION_RE = /(?:най(?:ди|ти)|узна(?:й|ть)|пров(?:ерь|ерить)|посмотр(?:и|еть)|скажи|покажи|како(?:й|е|ая|ие)|кто|сколько|где|когда)[\s\S]{0,100}(?:сейчас|сегодня|актуальн|последн|свеж|расписани|результат|цен[аы]|наличи|погод|новост)/iu;
const EXTERNAL_REMINDER_DEPENDENCY_RE = /(?:^|\s)(?:к|ко)\s+(?:начал|старт|выход|открыт|публикац)[\s\S]{0,80}(?:матч|турнир|чемпионат|кубок|рейс|поезд|самол[её]т|концерт|выстав|релиз)|(?:когда\s+(?:начн|будет|пройдет)|(?:следующ|ближайш)[\p{L}-]*[\s\S]{0,40})(?:матч|турнир|чемпионат|кубок|рейс|поезд|самол[её]т|концерт|выстав|релиз)/iu;
const CONTEXTUAL_EXTERNAL_QUESTION_RE = /^(?:а\s+)?(?:когда|во\s+сколько|где|кто\s+играет|кто\s+участвует|какой\s+следующий|что\s+дальше)(?:\s|[?!.]|$)/iu;
const STANDALONE_TIME_SENSITIVE_RE = /(?:когда|во\s+сколько|какой\s+следующий|кто\s+играет)[\s\S]{0,80}(?:матч|игр[аы]|рейс|поезд|самол[её]т|выстав|концерт|турнир|чемпионат)|(?:матч|игр[аы]|рейс|поезд|самол[её]т|выстав|концерт|турнир|чемпионат)[\s\S]{0,80}(?:когда|во\s+сколько|следующ|ближайш|откро|начн|вылет)/iu;

interface KnowledgeRoutableClassification {
    intent: string;
    confidenceLevel?: string;
    ambiguityReason?: string;
    clarificationQuestion?: string;
    details?: Record<string, unknown>;
}

export function shouldInterruptPendingContactMemory(
    decision: KnowledgeSourceDecision,
    isBrowserTaskLike: boolean,
): boolean {
    return isBrowserTaskLike || decision.requiresWeb;
}

export function applyKnowledgeSourceDecision<T extends KnowledgeRoutableClassification>(
    classification: T,
    decision: KnowledgeSourceDecision,
): {
    classification: T & {
        details: Record<string, unknown> & {
            knowledgeSource: KnowledgeSourceDecision['source'];
            requestedFacets: KnowledgeSourceDecision['requestedFacets'];
        };
    };
    primaryIntentOverridden: boolean;
} {
    const knowledgeDetails = {
        ...(classification.details ?? {}),
        knowledgeSource: decision.source,
        requestedFacets: decision.requestedFacets,
    };
    const knowledgeOnlyIntent = ['РАЗГОВОР', 'ВЕБ_ПОИСК', 'НЕОПРЕДЕЛЕНО'].includes(classification.intent);
    const routed = knowledgeOnlyIntent
        ? {
            ...classification,
            intent: 'ВЕБ_ПОИСК',
            confidenceLevel: 'ВЫСОКИЙ',
            ambiguityReason: undefined,
            clarificationQuestion: undefined,
            details: knowledgeDetails,
        }
        : {
            ...classification,
            details: knowledgeDetails,
        };
    return {
        classification: routed as T & {
            details: Record<string, unknown> & {
                knowledgeSource: KnowledgeSourceDecision['source'];
                requestedFacets: KnowledgeSourceDecision['requestedFacets'];
            };
        },
        primaryIntentOverridden: knowledgeOnlyIntent,
    };
}

function facets(text: string): KnowledgeSourceDecision['requestedFacets'] {
    const result: KnowledgeSourceDecision['requestedFacets'] = [];
    if (/факт|что\s+знаешь|расскажи|интересн/iu.test(text)) result.push('facts');
    if (/текущ|сейчас|что\s+происходит|ход\s+/iu.test(text)) result.push('current_state');
    if (/расписани|когда\s+(?:игра|матч)|ближайш.*матч/iu.test(text)) result.push('schedule');
    if (/результат|сч[её]т|кто\s+выиграл|таблиц/iu.test(text)) result.push('results');
    if (/(?:чемпионат|турнир|матч|лиг[аеи]|кубок)/iu.test(text)) {
        if (!result.includes('current_state')) result.push('current_state');
        if (!result.includes('schedule')) result.push('schedule');
        if (!result.includes('results')) result.push('results');
    }
    if (result.length === 0) result.push('facts');
    if (!result.includes('sources')) result.push('sources');
    return result;
}

export function decideKnowledgeSource(
    userText: string,
    replyContext?: ConversationReplyContext,
    currentTopic?: string,
): KnowledgeSourceDecision {
    const text = userText.trim();
    const contextualTopic = [replyContext?.text, currentTopic].filter(Boolean).join(' ');
    if (SELF_RE.test(text)) {
        return { source: 'assistant_self', requiresWeb: false, requestedFacets: [], reason: 'assistant-self request' };
    }
    if (EXPLICIT_REMINDER_RE.test(text)) {
        const dependsOnExternalKnowledge = EXTERNAL_LOOKUP_WITH_ACTION_RE.test(text) || EXTERNAL_REMINDER_DEPENDENCY_RE.test(text);
        if (dependsOnExternalKnowledge) {
            return {
                source: 'external_current',
                requiresWeb: true,
                requestedFacets: facets(text),
                reason: 'reminder depends on current external knowledge',
            };
        }
        return { source: 'personal', requiresWeb: false, requestedFacets: [], reason: 'action-only personal reminder' };
    }
    if (
        PERSON_MEMORY_RE.test(text) ||
        EXPLICIT_PERSONAL_MEMORY_RE.test(text) ||
        PERSONAL_RULES_RE.test(text) ||
        PERSONAL_LIFE_STATE_RE.test(text) ||
        PERSONAL_HEALTH_RE.test(text) ||
        INTERPERSONAL_ADVICE_RE.test(text)
    ) {
        return { source: 'personal', requiresWeb: false, requestedFacets: [], reason: 'personal life or memory request' };
    }
    const hasCurrentCue = CURRENT_CUE_RE.test(text);
    const externalTopic = EXTERNAL_ENTITY_RE.test(text);
    const volatileExternalRequest = VOLATILE_EXTERNAL_RE.test(text);
    const externalRecommendation = EXTERNAL_RECOMMENDATION_RE.test(text) && !PERSONAL_RE.test(text);
    const contextualExternalQuestion = CONTEXTUAL_EXTERNAL_QUESTION_RE.test(text) && EXTERNAL_ENTITY_RE.test(contextualTopic);
    if (
        STRONG_EXTERNAL_CURRENT_RE.test(text) ||
        CURRENT_EXTERNAL_FORM_RE.test(text) ||
        STANDALONE_TIME_SENSITIVE_RE.test(text) ||
        contextualExternalQuestion ||
        (volatileExternalRequest && externalTopic) ||
        externalRecommendation ||
        (hasCurrentCue && externalTopic)
    ) {
        return {
            source: 'external_current',
            requiresWeb: true,
            requestedFacets: facets(`${text} ${contextualTopic}`),
            reason: 'current or volatile external knowledge',
        };
    }
    if (PERSONAL_RE.test(text)) {
        return { source: 'personal', requiresWeb: false, requestedFacets: [], reason: 'personal memory request' };
    }

    return {
        source: 'stable_general',
        requiresWeb: false,
        requestedFacets: facets(text).filter((facet) => facet !== 'sources'),
        reason: 'no current external signal',
    };
}

export function buildKnowledgeSourcePrompt(decision: KnowledgeSourceDecision): string {
    if (!decision.requiresWeb) return '';
    return [
        `Источник знаний: внешний актуальный интернет-поиск (${decision.reason}).`,
        `Нужно покрыть аспекты: ${decision.requestedFacets.join(', ')}.`,
        'Личная память может персонализировать запрос, но не заменяет актуальные данные.',
    ].join('\n');
}
