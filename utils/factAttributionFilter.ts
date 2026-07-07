/**
 * Фильтр ошибочной атрибуции чужих событий к владельцу.
 *
 * Проблема: при фоновой рефлексии/изучении чата с третьим лицом (контактом)
 * user-проход extraction может ошибочно приписать владельцу событие, которое
 * принадлежит собеседнику и в которое владельца лишь приглашают.
 * Пример: собеседник пишет о своём празднике и приглашает владельца →
 * модель ошибочно сохраняет это как событие пользователя с subject:'user'.
 *
 * Здесь — детерминированная эвристика (без LLM), которая ловит такие случаи
 * по сочетанию признаков: событийный триггер + нет маркера первого лица
 * владельца + есть признак контакта/приглашения. Срабатывает пост-фактум
 * в deterministicQualityGate, в том числе когда LLM-критик пропущен по длине
 * контекста, и понижает confidence ниже порога сохранения (0.35).
 */

/** Минимальный набор полей факта, нужный фильтру. */
export interface FactAttributionInput {
    content: string;
    subject: 'user' | 'contact';
    evidence?: string;
    confidence?: number;
    qualityWarnings?: string[];
}

export interface WrongAttributionVerdict {
    reason: 'third_party_event';
    /** Опорные совпадения — для отладки/логирования. */
    triggers: string[];
}

export const ATTRIBUTION_PENALTY_CONFIDENCE = 0.3;

/** Событийные триггеры: факт про такое событие проверяется на атрибуцию. */
const EVENT_TRIGGER_RE =
    /(?:дн[её]м\s+рождени|день\s+рождени|(?<![а-яёa-z])др(?![а-яёa-z])|годовщин|встреч[ауое]|созвон|вечеринк|праздник|игр[ауоеы]|отпуск|дедлайн|свадьб|корпоратив)/iu;

/** Маркеры первого лица владельца: факт прямо поддержан словами «я/мой/у меня». */
const FIRST_PERSON_OWNER_RE =
    /(?<![а-яёa-z])(?:я|у\s+меня|мо[йяеё]|мне|меня|нами|наш(?:его|ему|ая)?)(?![а-яёa-z])/iu;

/** Признаки приглашения/обращения собеседника к владельцу. */
const INVITATION_MARKER_RE =
    /ты\s+как|ты\s+пойд[ёе]ш|приглаша|собер[её]мс|заходи|давай\s+.{0,40}вместе|приходи|ж[дёе]м\s+тебя/iu;

function containsOwnerName(text: string, ownerName: string | undefined): boolean {
    if (!ownerName) return false;
    const name = ownerName.trim();
    if (name.length < 3) return false;
    // Граница по буквам, чтобы имя не совпало с более длинным словом внутри строки.
    const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![а-яёa-z])${escaped}(?![а-яёa-z])`, 'iu').test(text);
}

function hasContactMarker(text: string, contactName: string | undefined): boolean {
    if (contactName) {
        const name = contactName.trim();
        if (name.length >= 3) {
            const escaped = name.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            if (new RegExp(`(?<![а-яёa-z])${escaped}(?![а-яёa-z])`, 'iu').test(text)) return true;
        }
    }
    return INVITATION_MARKER_RE.test(text);
}

/**
 * Определяет, что факт с subject:'user' описывает чужое событие (контакта),
 * в которое владельца лишь приглашают. Возвращает verdict или null.
 *
 * Условие срабатывания (все вместе):
 *   1. fact.subject === 'user'
 *   2. в content есть событийный триггер
 *   3. НЕТ first-person owner-маркера в content+evidence
 *   4. НЕТ имени владельца в content+evidence
 *   5. есть признак контакта/приглашения (имя контакта или маркер приглашения)
 *      в content+evidence
 *
 * Контактные факты (subject:'contact') не анализируются — их атрибуция
 * определяется другим проходом.
 */
export function detectThirdPartyEventAttributedToUser(
    fact: FactAttributionInput,
    ownerName?: string,
    contactName?: string,
): WrongAttributionVerdict | null {
    if (fact.subject !== 'user') return null;

    const content = fact.content ?? '';
    const evidence = fact.evidence ?? '';
    const hay = `${content}\n${evidence}`;

    const triggerMatch = content.match(EVENT_TRIGGER_RE);
    if (!triggerMatch) return null;

    // Владелец прямо говорит о себе в факте или evidence / назван по имени →
    // считаем, что событие относится к нему, а не к контакту.
    if (FIRST_PERSON_OWNER_RE.test(hay)) return null;
    if (containsOwnerName(hay, ownerName)) return null;

    if (!hasContactMarker(hay, contactName)) return null;

    return {
        reason: 'third_party_event',
        triggers: [triggerMatch[0]],
    };
}

/**
 * Применяет атрибуцию к списку user-фактов: для фактов с вердиктом
 * понижает confidence ниже порога сохранения (0.35) и ставит warning
 * 'wrong-attribution', чтобы deterministicQualityGate их дропнул.
 *
 * Контактные факты возвращаются как есть.
 */
export function filterUserFactsForThirdPartyEvents<
    T extends FactAttributionInput,
>(facts: T[], ownerName?: string, contactName?: string): T[] {
    return facts.map((fact) => {
        const verdict = detectThirdPartyEventAttributedToUser(fact, ownerName, contactName);
        if (!verdict) return fact;

        const warnings = [...(fact.qualityWarnings ?? []), 'wrong-attribution'];
        return {
            ...fact,
            confidence: ATTRIBUTION_PENALTY_CONFIDENCE,
            qualityWarnings: Array.from(new Set(warnings)),
        };
    });
}
