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
    personRelation?: {
        targetRole: 'user' | 'contact' | 'third_party';
    };
}

export interface WrongAttributionVerdict {
    reason: 'third_party_event';
    /** Опорные совпадения — для отладки/логирования. */
    triggers: string[];
}

export const ATTRIBUTION_PENALTY_CONFIDENCE = 0.3;

export type EvidenceAttributionStatus = 'supported' | 'mismatch' | 'unknown';

export interface EvidenceAttributionAssessment {
    status: EvidenceAttributionStatus;
    supportingSegments: number;
    oppositeSegments: number;
}

interface EvidenceSegment {
    speaker: 'user' | 'contact' | 'unknown';
    body: string;
    forwarded: boolean;
}

const FIRST_PERSON_SELF_RE =
    /(?<![а-яёa-z])(?:я|мне|меня|мной|мною|у\s+меня|со\s+мной|обо\s+мне|для\s+меня)(?![а-яёa-z])/iu;

const SECOND_PERSON_SELF_RE =
    /(?<![а-яёa-z])(?:ты|тебе|тебя|тобой|у\s+тебя|с\s+тобой|о\s+тебе|для\s+тебя)(?![а-яёa-z])/iu;

const POSSESSIVE_THIRD_PARTY_RE =
    /(?<![а-яёa-z])(?:у\s+меня|у\s+тебя|мо(?:й|я|ё|е|и|его|ему|ей|их)|тво(?:й|я|ё|е|и|его|ему|ей|их))\s+(?:мам\w*|пап\w*|бабуш\w*|дедуш\w*|брат\w*|сестр\w*|сын\w*|доч\w*|реб[её]н\w*|муж\w*|жен\w*|партн[её]р\w*|друг\w*|подруг\w*|коллег\w*|начальник\w*|врач\w*)/giu;

const FIRST_PERSON_RELATION_RE =
    /(?<![а-яёa-z])(?:мо(?:й|я|ё|и)|у\s+меня)\s+(?:[а-яёa-z-]+\s+){0,2}(?:мам\w*|пап\w*|бабуш\w*|дедуш\w*|брат\w*|сестр\w*|сын\w*|доч\w*|реб[её]н\w*|муж\w*|жен\w*|супруг\w*|партн[её]р\w*|друг\w*|подруг\w*|коллег\w*|начальник\w*|руководител\w*|клиент\w*|сосед\w*)/iu;

const SECOND_PERSON_RELATION_RE =
    /(?<![а-яёa-z])(?:тво(?:й|я|ё|и)|у\s+тебя)\s+(?:[а-яёa-z-]+\s+){0,2}(?:мам\w*|пап\w*|бабуш\w*|дедуш\w*|брат\w*|сестр\w*|сын\w*|доч\w*|реб[её]н\w*|муж\w*|жен\w*|супруг\w*|партн[её]р\w*|друг\w*|подруг\w*|коллег\w*|начальник\w*|руководител\w*|клиент\w*|сосед\w*)/iu;

function normalizeParticipantLabel(value: string): string {
    return value
        .trim()
        .replace(/^[«"']+|[»"']+$/gu, '')
        .replace(/\s+/gu, ' ')
        .toLocaleLowerCase('ru-RU');
}

function resolveSpeaker(
    rawSpeaker: string,
    ownerName?: string,
    contactName?: string,
): EvidenceSegment['speaker'] {
    const speaker = normalizeParticipantLabel(rawSpeaker);
    const owner = normalizeParticipantLabel(ownerName || '');
    const contact = normalizeParticipantLabel(contactName || '');

    if (speaker === 'я' || (owner && speaker === owner)) return 'user';
    if (speaker === 'контакт' || speaker === 'собеседник' || (contact && speaker === contact)) return 'contact';
    return 'unknown';
}

function splitEvidence(value: string): string[] {
    return value
        .replace(/\r\n?/gu, '\n')
        // Older normalized facts may have lost the newline between two dated
        // evidence clauses. Recover that boundary when the next speaker label
        // is still present.
        .split(/\n+|\s+(?=\[[^\]\n]{1,80}\]\s*[^:\n]{1,100}:)/gu)
        .map(segment => segment.trim())
        .filter(Boolean);
}

function parseEvidenceSegments(
    evidence: string,
    ownerName?: string,
    contactName?: string,
): EvidenceSegment[] {
    return splitEvidence(evidence).map((segment) => {
        const match = /^(?:\[[^\]]+\]\s*)?([^:\n]{1,100})\s*:\s*(.+)$/u.exec(segment);
        if (!match) {
            return { speaker: 'unknown', body: segment, forwarded: false };
        }
        return {
            speaker: resolveSpeaker(match[1], ownerName, contactName),
            body: match[2].trim(),
            forwarded: /переслал(?:а)?\s+сообщение\s+от|пересланное\s+сообщение/iu.test(match[1]),
        };
    });
}

function escapeRegExp(value: string): string {
    return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function hasExplicitClauseSubject(text: string, name?: string): boolean {
    const normalizedName = String(name || '').trim();
    if (normalizedName.length < 2) return false;
    const escaped = escapeRegExp(normalizedName);
    return new RegExp(
        `(?:^|[.!?]\\s+|(?<![а-яёa-z])(?:что|а|но|и)\\s+)${escaped}(?:$|[\\s,—-])`,
        'iu',
    ).test(text);
}

function supportedSubjectsForSegment(
    segment: EvidenceSegment,
    ownerName?: string,
    contactName?: string,
): Set<'user' | 'contact'> {
    const supported = new Set<'user' | 'contact'>();
    if (segment.forwarded) return supported;

    if (hasExplicitClauseSubject(segment.body, ownerName)) supported.add('user');
    if (hasExplicitClauseSubject(segment.body, contactName)) supported.add('contact');

    // Do not let "my mother / you have a colleague" turn the relative's or
    // colleague's event into a fact about the speaker/addressee. A separate
    // explicit first/second-person clause later in the same evidence still
    // remains usable.
    const participantBody = segment.body.replace(POSSESSIVE_THIRD_PARTY_RE, '');

    if (segment.speaker === 'user') {
        if (FIRST_PERSON_SELF_RE.test(participantBody)) supported.add('user');
        if (SECOND_PERSON_SELF_RE.test(participantBody)) supported.add('contact');
    } else if (segment.speaker === 'contact') {
        if (FIRST_PERSON_SELF_RE.test(participantBody)) supported.add('contact');
        if (SECOND_PERSON_SELF_RE.test(participantBody)) supported.add('user');
    }

    return supported;
}

function addRelationSubjectsForSegment(
    supported: Set<'user' | 'contact'>,
    segment: EvidenceSegment,
): void {
    if (segment.forwarded) return;
    const hasFirstPersonRelation = FIRST_PERSON_RELATION_RE.test(segment.body);
    const hasSecondPersonRelation = SECOND_PERSON_RELATION_RE.test(segment.body);
    if (segment.speaker === 'user') {
        if (hasFirstPersonRelation) supported.add('user');
        if (hasSecondPersonRelation) supported.add('contact');
    } else if (segment.speaker === 'contact') {
        if (hasFirstPersonRelation) supported.add('contact');
        if (hasSecondPersonRelation) supported.add('user');
    }
}

/**
 * Checks that a fact's evidence actually supports its declared participant.
 * Speaker labels are authoritative: "Contact: I ..." supports the contact,
 * while "Me: I ..." supports the owner. Possessives such as "my mother" are
 * intentionally not treated as self-attribution because the event belongs to
 * the relative, not automatically to the speaker.
 */
export function assessFactEvidenceAttribution(
    fact: FactAttributionInput,
    ownerName?: string,
    contactName?: string,
): EvidenceAttributionAssessment {
    const evidence = String(fact.evidence || '').trim();
    if (!evidence) {
        return { status: 'unknown', supportingSegments: 0, oppositeSegments: 0 };
    }

    let supportingSegments = 0;
    let oppositeSegments = 0;
    const oppositeSubject = fact.subject === 'user' ? 'contact' : 'user';

    for (const segment of parseEvidenceSegments(evidence, ownerName, contactName)) {
        const supported = supportedSubjectsForSegment(segment, ownerName, contactName);
        if (fact.personRelation) addRelationSubjectsForSegment(supported, segment);
        if (supported.has(fact.subject)) supportingSegments++;
        if (supported.has(oppositeSubject)) oppositeSegments++;
    }

    return {
        status: supportingSegments > 0
            ? 'supported'
            : oppositeSegments > 0
                ? 'mismatch'
                : 'unknown',
        supportingSegments,
        oppositeSegments,
    };
}

/**
 * Penalizes facts whose declared subject is contradicted by the speaker-aware
 * evidence. With requireSupport=true, missing/ambiguous attribution is also
 * rejected instead of being guessed from the chat where it appeared.
 */
export function filterFactsForEvidenceAttribution<
    T extends FactAttributionInput,
>(
    facts: T[],
    ownerName?: string,
    contactName?: string,
    options: { requireSupport?: boolean } = {},
): T[] {
    return facts.map((fact) => {
        const assessment = assessFactEvidenceAttribution(fact, ownerName, contactName);
        const shouldPenalize = assessment.status === 'mismatch' ||
            (options.requireSupport === true && assessment.status !== 'supported');
        if (!shouldPenalize) return fact;

        const warning = assessment.status === 'mismatch'
            ? 'wrong-attribution'
            : 'unsupported-attribution';
        return {
            ...fact,
            confidence: ATTRIBUTION_PENALTY_CONFIDENCE,
            qualityWarnings: Array.from(new Set([...(fact.qualityWarnings ?? []), warning])),
        };
    });
}

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
