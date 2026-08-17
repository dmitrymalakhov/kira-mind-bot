import { Api } from 'telegram';
import { initTelegramClient } from '../services/telegram';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { getActivePresetNameAsync } from '../ai/modelResolver';
import { config } from '../config';
import { getGramJsForwardSource } from './forwardedMessage';
import { parseLLMJson } from '../utils';
import type { MemoryStatus } from '../types';
import {
    assessFactEvidenceAttribution,
    filterFactsForEvidenceAttribution,
    filterUserFactsForThirdPartyEvents,
} from './factAttributionFilter';
import { containsMultipleAssertions } from './atomicAssertion';
import {
    PERSON_RELATION_TYPES,
    normalizePersonRelationDescriptor,
    type PersonRelationDescriptor,
} from './personRelation';

const BATCH_SIZE = 100;
const MAX_MESSAGES = 5000;

export type StudyChatPeriod = 'week' | 'month' | '3months' | 'year';

/**
 * Загружает сообщения из переписки с контактом за указанный период (через Telegram Client API).
 */
export async function getMessagesInDateRange(
    contactId: number,
    startDate: Date,
    endDate: Date
): Promise<Api.Message[]> {
    const client = await initTelegramClient();
    if (!client) return [];

    const results: Api.Message[] = [];
    let offsetDate: Date | undefined = new Date(endDate.getTime() + 86400000); // чуть позже endDate

    while (results.length < MAX_MESSAGES) {
        const batch = await client.getMessages(contactId, {
            limit: BATCH_SIZE,
            offsetDate: offsetDate ? Math.floor(offsetDate.getTime() / 1000) : undefined,
        });
        if (!batch || batch.length === 0) break;

        for (const msg of batch) {
            const msgDate = new Date((msg.date || 0) * 1000);
            if (msgDate < startDate) return results; // дальше только старее
            if (msgDate <= endDate) results.push(msg);
        }
        const last = batch[batch.length - 1];
        offsetDate = new Date((last.date || 0) * 1000);
        if (offsetDate <= startDate) break;
    }
    return results;
}

/**
 * Форматирует сообщения в текст переписки: "Я: ..." / "ContactName: ..." (по fromId).
 */
export function formatConversation(
    messages: Api.Message[],
    contactId: number,
    contactName: string
): string {
    const ownerId = String(config.allowedUserId || '');
    const sorted = Array.from(messages).sort(
        (a, b) => (a.date || 0) - (b.date || 0)
    );
    const lines: string[] = [];
    for (const msg of sorted) {
        // Пропускаем медиа-сообщения без текста — они только шумят в контексте
        const text = msg.message?.trim();
        if (!text) continue;
        const fromId = msg.fromId && 'userId' in msg.fromId ? String(msg.fromId.userId) : '';
        // Telegram помечает исходящий forward как out=true, хотя текст
        // принадлежит автору исходного сообщения. Forward никогда не должен
        // становиться репликой владельца или доказательством его факта.
        const isForwarded = Boolean((msg as Api.Message & { fwdFrom?: unknown }).fwdFrom);
        const carrierIsOwn = Boolean(msg.out || fromId === ownerId);
        const isOwn = !isForwarded && carrierIsOwn;
        const sender = isForwarded
            ? `${carrierIsOwn ? 'Я' : contactName} (переслал сообщение от ${getGramJsForwardSource((msg as Api.Message & { fwdFrom?: unknown }).fwdFrom)})`
            : isOwn ? 'Я' : contactName;
        const date = new Date((msg.date || 0) * 1000).toLocaleString('ru-RU');
        lines.push(`[${date}] ${sender}: ${text}`);
    }
    return lines.join('\n');
}

export interface ExtractedFactAboutUser {
    content: string;
    domain: string;
    importance: number;
    tags: string[];
    /** Оценка уверенности извлечения: насколько факт поддержан перепиской. */
    confidence?: number;
    /** Короткая опора из переписки, не обязательно дословная цитата. */
    evidence?: string;
    /** Как получен факт: прямо сказан, пересказан другим, выведен или неоднозначен. */
    inferenceLevel?: InferenceLevel;
    /** Диагностические пометки quality-gate, не предназначены для показа пользователю. */
    qualityWarnings?: string[];
    /** Временная природа факта: устойчивое, текущее состояние, план, событие и т.п. */
    temporalScope?: TemporalScope;
    /** Статус актуальности для долговременной памяти. */
    status?: MemoryStatus;
    /** С какого времени факт считается применимым. */
    validFrom?: Date;
    /** До какого времени факт применим, если это известно. */
    validTo?: Date;
    /** Кому принадлежит факт: 'user' — владелец бота ("Я"), 'contact' — собеседник */
    subject: 'user' | 'contact';
    /** Имя собеседника (заполняется только когда subject = 'contact') */
    contactName?: string;
    /** Один канонический предикат; не домен и не составное описание. */
    predicate?: string;
    /** Объект того же атомарного утверждения, согласованный с content. */
    object?: string;
    /** Доказуемая бинарная связь со вторым человеком для social graph. */
    personRelation?: PersonRelationDescriptor;
}

/** Forward-only evidence cannot establish a fact about the owner or contact. */
export function isForwardOnlyEvidence(evidence?: string): boolean {
    const lines = String(evidence || '')
        .split(/\r?\n/u)
        .map(line => line.trim())
        .filter(Boolean);
    if (lines.length === 0) return false;

    const forwarded = lines.filter(line => /переслал сообщение от|пересланное сообщение/iu.test(line));
    return forwarded.length > 0 && forwarded.length === lines.length;
}

export type StudyChatAnalysisProgress =
    | {
        stage: 'chunks_ready';
        chunksTotal: number;
        charactersTotal: number;
    }
    | {
        stage: 'batch_done';
        chunksDone: number;
        chunksTotal: number;
        rawFactsCount: number;
    }
    | {
        stage: 'raw_facts_ready';
        rawFactsCount: number;
    }
    | {
        stage: 'synthesis_start';
        rawFactsCount: number;
    }
    | {
        stage: 'synthesis_done';
        factsCount: number;
    };

export type StudyChatAnalysisProgressHandler = (
    progress: StudyChatAnalysisProgress
) => void | Promise<void>;

export type TemporalScope =
    | 'stable'
    | 'preference'
    | 'routine'
    | 'current_state'
    | 'future_plan'
    | 'past_event'
    | 'relationship'
    | 'unknown';

export type InferenceLevel =
    | 'direct'
    | 'reported'
    | 'inferred'
    | 'ambiguous';

export interface FactExtractionOptions {
    mode?: 'default' | 'reflection';
}

// ─── Константы ────────────────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 12000;  // ~150–200 сообщений на чанк, чтобы не превышать контекст gpt-5.4-nano
const CHUNK_OVERLAP_LINES = 30; // строки-перекрытие между чанками для контекстности

const VALID_DOMAINS = new Set(['work', 'health', 'family', 'finance', 'education', 'hobbies', 'travel', 'social', 'home', 'personal', 'entertainment', 'general']);
const MAX_EVIDENCE_CHARS = 280;
const MAX_CRITIC_CONTEXT_CHARS = 30_000;
const FACT_CRITIC_BATCH_SIZE = 18;

function clamp01(value: unknown, fallback: number): number {
    return typeof value === 'number' && Number.isFinite(value)
        ? Math.min(1, Math.max(0, value))
        : fallback;
}

function normalizeText(value: unknown, max: number): string | undefined {
    const text = String(value ?? '').replace(/\s+/g, ' ').trim();
    return text ? text.slice(0, max) : undefined;
}

function normalizeEvidence(value: unknown, max: number): string | undefined {
    const text = String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map(line => line.replace(/[\t ]+/gu, ' ').trim())
        .filter(Boolean)
        .join('\n')
        .trim();
    return text ? text.slice(0, max) : undefined;
}

function normalizeTags(values: unknown): string[] {
    if (!Array.isArray(values)) return [];
    return [...new Set(
        values
            .map((tag) => String(tag).trim().toLowerCase())
            .filter((tag) => tag.length > 0 && tag.length <= 60)
    )].slice(0, 10);
}

function normalizeDomain(value: unknown): string {
    const rawDomain = String(value ?? '').trim().toLowerCase();
    return VALID_DOMAINS.has(rawDomain) ? rawDomain : 'general';
}

function normalizeInferenceLevel(value: unknown, confidence: number, evidence?: string): InferenceLevel {
    const normalized = String(value ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'direct':
        case 'reported':
        case 'inferred':
        case 'ambiguous':
            return normalized;
    }
    if (confidence < 0.45) return 'ambiguous';
    if (/вывод|похоже|кажется|судя по|можно понять/i.test(evidence ?? '')) return 'inferred';
    return 'direct';
}

function normalizeTemporalScope(value: unknown, content = ''): TemporalScope {
    const normalized = String(value ?? '').trim().toLowerCase();
    switch (normalized) {
        case 'stable':
        case 'preference':
        case 'routine':
        case 'current_state':
        case 'future_plan':
        case 'past_event':
        case 'relationship':
            return normalized;
    }

    const lc = content.toLowerCase();
    if (/люб(ит|лю)|нравится|предпочита|не любит|обожает|терпеть не может/.test(lc)) return 'preference';
    if (/обычно|регулярно|кажд(ый|ая|ое)|по утрам|по вечерам|привыч/.test(lc)) return 'routine';
    if (/планир|собира[ею]тся|хоч[уе]т|предстоит|дедлайн|будет|надо будет|обещал/.test(lc)) return 'future_plan';
    if (/уже|сходил|сходила|купил|купила|прилетел|прилетела|вернулся|вернулась|завершил|завершила/.test(lc)) return 'past_event';
    if (/сейчас|теперь|работает|жив[её]т|болеет|находится|занимается/.test(lc)) return 'current_state';
    if (/жена|муж|партн[её]р|сын|дочь|родител|коллега|друг|подруга/.test(lc)) return 'relationship';
    return 'unknown';
}

function normalizeStatus(value: unknown, temporalScope: TemporalScope, content: string): MemoryStatus | undefined {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (['active', 'planned', 'done', 'superseded', 'expired', 'unknown'].includes(normalized)) {
        return normalized as MemoryStatus;
    }
    if (temporalScope === 'future_plan') return 'planned';
    if (temporalScope === 'past_event') return 'done';
    if (temporalScope === 'unknown' && /кажется|возможно|неясно|под вопросом/i.test(content)) return 'unknown';
    return 'active';
}

function parseDateMaybe(value: unknown): Date | undefined {
    const text = String(value ?? '').trim();
    if (!text || /^null$/i.test(text)) return undefined;
    const date = new Date(text);
    return Number.isFinite(date.getTime()) ? date : undefined;
}

function normalizeSupportedPersonRelation(
    value: unknown,
    context: {
        subject: 'user' | 'contact';
        content: string;
        evidence?: string;
        contactName?: string;
    },
): PersonRelationDescriptor | undefined {
    const relation = normalizePersonRelationDescriptor(value, {
        subject: context.subject,
        evidence: context.evidence,
        ownerName: config.ownerName,
        contactName: context.contactName,
    });
    if (!relation || relation.targetRole === 'third_party') return relation;

    const targetAssessment = assessFactEvidenceAttribution({
        content: context.content,
        subject: relation.targetRole,
        evidence: context.evidence,
        personRelation: relation,
    }, config.ownerName, context.contactName);
    return targetAssessment.status === 'supported' ? relation : undefined;
}

function normalizeFactLike(
    f: any,
    subject: 'user' | 'contact',
    contactName?: string,
): ExtractedFactAboutUser {
    const confidence = clamp01(f?.confidence, 0.62);
    const tags = normalizeTags(f?.tags);
    const content = String(f.content).replace(/\s+/g, ' ').trim();
    const evidence = normalizeEvidence(f.evidence, MAX_EVIDENCE_CHARS);
    const inferenceLevel = normalizeInferenceLevel(f?.inferenceLevel, confidence, evidence);
    const personRelation = normalizeSupportedPersonRelation(f?.personRelation, {
        subject,
        content,
        evidence,
        contactName,
    });
    const temporalScope = personRelation ? 'relationship' : normalizeTemporalScope(f?.temporalScope, content);
    const status = normalizeStatus(f?.status, temporalScope, content);
    if (confidence < 0.55) tags.push('weak-evidence');
    if (confidence >= 0.78) tags.push('supported');
    tags.push(`inference:${inferenceLevel}`);
    if (inferenceLevel === 'inferred' || inferenceLevel === 'ambiguous') tags.push('needs-caution');
    tags.push(`temporal_scope:${temporalScope}`);
    if (status && status !== 'active') tags.push(`status:${status}`);
    return {
        content,
        predicate: personRelation?.type ?? normalizeText(f?.predicate, 100) ?? normalizeDomain(f.domain),
        object: personRelation
            ? personRelation.targetName
                ?? (personRelation.targetRole === 'contact' ? contactName : config.ownerName)
                ?? content
            : normalizeText(f?.object, 320) ?? content,
        subject,
        domain: normalizeDomain(f.domain),
        importance: clamp01(f.importance, 0.5),
        confidence,
        evidence,
        inferenceLevel,
        temporalScope,
        status,
        validFrom: parseDateMaybe(f?.validFrom),
        validTo: parseDateMaybe(f?.validTo),
        tags: [...new Set(tags)],
        personRelation,
    };
}

// ─── Разбивка по строкам с перекрытием ────────────────────────────────────────

function splitIntoChunks(text: string): string[] {
    const lines = text.split('\n');
    const chunks: string[] = [];
    let currentLines: string[] = [];
    let currentSize = 0;

    for (const line of lines) {
        currentLines.push(line);
        currentSize += line.length + 1;

        if (currentSize >= CHUNK_MAX_CHARS) {
            chunks.push(currentLines.join('\n'));
            // Перекрытие: последние N строк идут в следующий чанк
            currentLines = currentLines.slice(-CHUNK_OVERLAP_LINES);
            currentSize = currentLines.reduce((s, l) => s + l.length + 1, 0);
        }
    }
    if (currentLines.length > 0) {
        chunks.push(currentLines.join('\n'));
    }
    return chunks;
}

// ─── Извлечение сырых фактов из одного чанка — два отдельных прохода ──────────
//
// Ключевой принцип: каждый проход извлекает факты только об ОДНОМ человеке.
// Это снижает риск смешивания атрибуции между участниками, но не заменяет
// deterministic evidence-gate: модель всё равно может вернуть факт не в тот
// проход, поэтому speaker label проверяется до синтеза и после critic-а.
//  - Проход 1: только факты о владельце (subject всегда 'user')
//  - Проход 2: только факты о собеседнике (subject всегда 'contact')
// Оба запроса выполняются параллельно.

const EXTRACTION_SYSTEM = `Ты анализируешь переписку и извлекаешь факты об одном конкретном человеке.
Отвечай ТОЛЬКО валидным JSON с полем facts. Никакого текста вне JSON.`;

const DOMAIN_LIST = 'work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general';
const PERSON_RELATION_TYPES_FOR_PROMPT = PERSON_RELATION_TYPES.join('|');

function buildEvidenceAttributionRules(ownerName: string, contactName: string): string {
    return `
КРИТИЧНО ПРО АВТОРА И EVIDENCE:
- Каждая строка переписки имеет собственного автора. Соседняя реплика не наследует автора предыдущей.
- evidence копируй как 1–3 минимальные исходные строки целиком, обязательно вместе с датой и speaker label: "[дата] Я: ..." или "[дата] ${contactName}: ...". Несколько строк оставляй на отдельных строках.
- Никогда не удаляй, не меняй и не придумывай speaker label; не переписывай первое лицо от имени другого участника.
- "${contactName}: я/мне/у меня ..." доказывает факт о ${contactName}, но не о ${ownerName}.
- "Я: я/мне/у меня ..." доказывает факт о ${ownerName}, но не о ${contactName}.
- "${contactName}: ты/тебе/у тебя ..." может доказывать факт о ${ownerName}; "Я: ты/тебе/у тебя ..." — о ${contactName}.
- "мой брат", "моя мама", "твой коллега" описывает третье лицо. Не превращай событие родственника/коллеги в событие говорящего или адресата.
- Если ни одна сохранённая строка evidence однозначно не поддерживает нужного человека, не возвращай факт.`;
}

function buildPersonRelationExtractionRules(ownerName: string, contactName: string): string {
    return `
СВЯЗИ МЕЖДУ ЛЮДЬМИ:
- Если атомарный факт явно описывает, кем один человек приходится другому, добавь personRelation.
- type используй только из списка: ${PERSON_RELATION_TYPES_FOR_PROMPT}.
- targetRole=user означает ${ownerName}; targetRole=contact означает ${contactName}; targetRole=third_party означает другого названного человека.
- Для third_party поле targetName обязательно и должно быть дословно скопировано из evidence. Не создавай человека по роли без имени ("брат", "коллега").
- Не добавляй personRelation для организаций, проектов, городов или абстрактных групп.
- Связь должна быть прямо поддержана evidence; совместное упоминание двух людей само по себе не означает знакомство.
- Примеры типов: супруги=spouse_of, партнёры=partner_of, родитель=parent_of, ребёнок=child_of, друг=friend_of, коллега=coworker_of, руководитель=manager_of, подчинённый=reports_to, познакомились через человека=introduced_by.
- predicate для такого факта должен совпадать с personRelation.type, temporalScope должен быть relationship.`;
}

function buildReflectionExtractionRules(ownerName: string, contactName: string): string {
    return `
РЕЖИМ ФОНОВОЙ РЕФЛЕКСИИ: будь заметно строже обычного анализа.
Сохраняй только то, что с высокой вероятностью пригодится через недели или месяцы:
- устойчивые предпочтения, привычки, роли, отношения, место работы/жизни;
- важные решения, долгосрочные планы, обязательства, дедлайны;
- значимые события про здоровье, семью, финансы, переезд, работу;
- повторяющийся паттерн поведения, если он явно виден из нескольких реплик.

НЕ извлекай в фоновой рефлексии:
- одноразовые рабочие статусы: "${ownerName} занимается задачей", "портирует", "перегоняет файл", "распознаёт фото/слайды";
- детали инструментов, моделей, ChatGPT, файлов, ошибок обработки, времени распознавания, если это не устойчивое правило о том, как помогать ${ownerName};
- пересказ просьб обработать/распознать/объединить/отправить материалы без результата или долгосрочного решения;
- временное местонахождение вида "пока в городе", если это не переезд, поездка с явными датами или важное событие;
- одноразовое настроение/стресс из-за текущей задачи, если нет устойчивого паттерна или риска.

Если сомневаешься, не извлекай факт. Для слабых одноразовых наблюдений ставь importance ниже 0.45, чтобы они не попали в память.`;
}

/** Промпт для извлечения фактов о владельце бота ("Я") */
function buildUserFactsPrompt(
    chunk: string,
    contactName: string,
    periodLabel: string,
    options: FactExtractionOptions = {}
): string {
    const ownerName = config.ownerName || 'пользователь';
    const reflectionRules = options.mode === 'reflection'
        ? buildReflectionExtractionRules(ownerName, contactName)
        : '';
    return `Переписка ${ownerName} ("Я") с ${contactName}. Период: ${periodLabel}.

Твоя задача: извлечь факты ТОЛЬКО о ${ownerName}.
Каждый элемент facts — ровно одно атомарное утверждение subject/predicate/object. Не склеивай отношения, работу, знакомство и хронологию в одну запись.

Источники фактов о ${ownerName}:
1. Строки "[дата] Я: ..." — что ${ownerName} говорит о себе напрямую
2. Строки "[дата] ${contactName}: ..." — когда контакт говорит о ${ownerName} или обращается к нему
   Примеры: "ты всегда задерживаешься", "${ownerName}, ты же программист?", "ты столько работаешь"
3. Строки с пометкой "переслал сообщение от ..." — чужой пересланный материал; используй его только для понимания соседних реплик и никогда как доказательство факта о ${ownerName}
${buildEvidenceAttributionRules(ownerName, contactName)}
${buildPersonRelationExtractionRules(ownerName, contactName)}

Имена/обращения к ${ownerName}: "${ownerName}", сокращения его имени, "ты" в контексте обращения к нему.

Что искать:
- Работа: должность, компания, график, проекты, коллеги
- Семья и отношения: партнёр, дети, родители, их имена и ситуации
- Здоровье: самочувствие, привычки, проблемы, спорт
- Хобби и интересы: что любит, чем занимается в свободное время
- Финансы: траты, планы покупок, статус
- Характер и поведение: паттерны, реакции, ценности
- Планы и желания: куда хочет поехать, что купить, что сделать — но только планы, которые ${ownerName} инициирует сам или прямо называет своими
- Косвенные выводы: "опять не сплю" → проблемы со сном

НЕ включай: факты о ${contactName} или третьих лицах.
НЕ включай: содержание строк с пометкой «переслал сообщение от ...» — у них отдельный исходный автор, и они не являются доказательством факта о ${ownerName}.
НЕ включай: тривиальное ("написал сообщение"), единичные оговорки без контекста.
ВАЖНО ПРО АТРИБУЦИЮ СОБЫТИЙ: если событие/праздник/ДР/годовщина/встреча/игра/поездка инициированы собеседником или принадлежат ему (его ДР, его отпуск, его корпоратив), а ${ownerName} лишь приглашён/вписан/идёт как гость — это факт О СОБЕСЕДНИКЕ, не о ${ownerName}. Не превращай приглашение в факт о владельце.
Пример: "${contactName}: хочу собрать встречу на свой праздник, ты как?" → это событие ${contactName}, НЕ ${ownerName}; не извлекай «у ${ownerName} личный праздник».
Если переписка старше 6 месяцев — снижай importance для планов и временных состояний.
Для каждого факта укажи temporalScope:
- stable/preference/routine/relationship — устойчивое знание
- current_state — актуальное на момент переписки состояние, может устареть
- future_plan — план, обещание, дедлайн, ожидание
- past_event — завершённое событие
- unknown — неясно
status: active для устойчивого/текущего, planned для future_plan, done для past_event, unknown если не уверен.
validFrom/validTo — ISO-даты или null; не выдумывай точную дату, если её нет.
inferenceLevel:
- direct — ${ownerName} сам явно сказал это о себе, или контакт явно обратился к нему с этим фактом
- reported — факт о ${ownerName} сообщает собеседник, но ${ownerName} сам это не подтверждает в фрагменте
- inferred — аккуратный вывод из нескольких реплик, не дословный факт
- ambiguous — атрибуция/смысл неясны; confidence должен быть низким
${reflectionRules}

Переписка:
${chunk}

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Факт о ${ownerName}, одно предложение от третьего лица",
      "predicate": "один атомарный предикат",
      "object": "объект этого предиката",
      "personRelation": {
        "type": "${PERSON_RELATION_TYPES_FOR_PROMPT}",
        "targetRole": "contact|third_party",
        "targetName": "точное имя из evidence; только для third_party"
      },
      "domain": "work",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "короткая фраза/опора из переписки",
      "inferenceLevel": "direct|reported|inferred|ambiguous",
      "temporalScope": "stable|preference|routine|current_state|future_plan|past_event|relationship|unknown",
      "status": "active|planned|done|unknown",
      "validFrom": "ISO date или null",
      "validTo": "ISO date или null",
      "tags": ["тег"]
    }
  ]
}
Если фактов нет — {"facts": []}.`;
}

/** Промпт для извлечения фактов о собеседнике (контакте) */
function buildContactFactsPrompt(
    chunk: string,
    contactName: string,
    periodLabel: string,
    options: FactExtractionOptions = {}
): string {
    const ownerName = config.ownerName || 'пользователь';
    const reflectionRules = options.mode === 'reflection'
        ? buildReflectionExtractionRules(ownerName, contactName)
        : '';
    return `Переписка ${ownerName} ("Я") с ${contactName}. Период: ${periodLabel}.

Твоя задача: извлечь факты ТОЛЬКО о ${contactName}.
Каждый элемент facts — ровно одно атомарное утверждение subject/predicate/object. Не склеивай отношения, работу, знакомство и хронологию в одну запись.

Источники фактов о ${contactName}:
1. Строки "[дата] ${contactName}: ..." — что ${contactName} говорит о себе
   Примеры: "я устала", "у меня встреча", "мне не нравится", "я работаю в..."
2. Строки "[дата] Я: ..." — когда ${ownerName} говорит о ${contactName} или обращается к нему/ней
   Примеры: "ты постоянно переживаешь", "ты же работаешь в X?", "ты всегда так делаешь"
3. Строки с пометкой "переслал сообщение от ..." — чужой пересланный материал; используй его только для понимания соседних реплик и никогда как доказательство факта о ${contactName}
${buildEvidenceAttributionRules(ownerName, contactName)}
${buildPersonRelationExtractionRules(ownerName, contactName)}

Что искать о ${contactName}:
- Работа и занятия
- Семья и отношения
- Интересы и привычки
- Характер и поведение: паттерны, реакции
- Здоровье и самочувствие
- Отношение к ${ownerName} и ситуациям
- События и инициативы контакта: его праздник/годовщина/встреча/игра/поездка, которые он инициирует или которые принадлежат ему (например «хочу собрать встречу на свой праздник») — это факты о ${contactName}

НЕ включай: факты о ${ownerName}.
НЕ включай: содержание строк с пометкой «переслал сообщение от ...» — у них отдельный исходный автор, и они не являются доказательством факта о ${contactName}.
НЕ включай: тривиальное, единичные случайные фразы без контекста.
КРИТИЧНО ПРО СУБЪЕКТА: владелец чата ${contactName} не становится субъектом события автоматически.
Фраза с пропущенным субъектом вроде «в понедельник будут делать операцию» — не факт о ${contactName}, если в текущем или предыдущем сообщении нет доказуемого antecedent.
Событие про бабушку, родственника, коллегу или иное третье лицо не переписывай как событие самого ${contactName}.
Если субъект не доказан, не извлекай contact-факт. Не дополняй evidence именем, которого не было в исходной реплике.
Если переписка старше 6 месяцев — снижай importance для планов и временных состояний.
Для каждого факта укажи temporalScope:
- stable/preference/routine/relationship — устойчивое знание
- current_state — актуальное на момент переписки состояние, может устареть
- future_plan — план, обещание, дедлайн, ожидание
- past_event — завершённое событие
- unknown — неясно
status: active для устойчивого/текущего, planned для future_plan, done для past_event, unknown если не уверен.
validFrom/validTo — ISO-даты или null; не выдумывай точную дату, если её нет.
inferenceLevel:
- direct — ${contactName} сам/сама явно сказал(а) это о себе, или ${ownerName} явно обращается к нему/ней с этим фактом
- reported — факт о ${contactName} сообщает ${ownerName} или третья сторона, но контакт сам не подтверждает в фрагменте
- inferred — аккуратный вывод из нескольких реплик, не дословный факт
- ambiguous — атрибуция/смысл неясны; confidence должен быть низким
${reflectionRules}

Переписка:
${chunk}

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Факт о ${contactName}, одно предложение от третьего лица",
      "predicate": "один атомарный предикат",
      "object": "объект этого предиката",
      "personRelation": {
        "type": "${PERSON_RELATION_TYPES_FOR_PROMPT}",
        "targetRole": "user|third_party",
        "targetName": "точное имя из evidence; только для third_party"
      },
      "domain": "work",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "короткая фраза/опора из переписки",
      "inferenceLevel": "direct|reported|inferred|ambiguous",
      "temporalScope": "stable|preference|routine|current_state|future_plan|past_event|relationship|unknown",
      "status": "active|planned|done|unknown",
      "validFrom": "ISO date или null",
      "validTo": "ISO date или null",
      "tags": ["тег"]
    }
  ]
}
Если фактов нет — {"facts": []}.`;
}

function parseFacts(
    text: string,
    subject: 'user' | 'contact',
    contactName: string,
): ExtractedFactAboutUser[] {
    const data = parseLLMJson<{ facts?: unknown[] }>(text);
    if (!data || !Array.isArray(data.facts)) return [];
    return data.facts
        .filter((f: any) => f?.content && f?.domain)
        .map((f: any) => normalizeFactLike(f, subject, contactName))
        .filter((fact) => fact.content.length >= 8);
}

interface ChunkExtractionResult {
    facts: ExtractedFactAboutUser[];
    partialFailure: boolean;
}

async function extractRawFactsFromChunk(
    chunk: string,
    contactName: string,
    periodLabel: string,
    options: FactExtractionOptions = {}
): Promise<ChunkExtractionResult> {
    // Два параллельных запроса — каждый про одного человека
    const [userResp, contactResp] = await Promise.allSettled([
        createChatCompletionForTask('memoryExtraction', {
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: buildUserFactsPrompt(chunk, contactName, periodLabel, options) },
            ],
            temperature: 1,
        }),
        createChatCompletionForTask('memoryExtraction', {
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: buildContactFactsPrompt(chunk, contactName, periodLabel, options) },
            ],
            temperature: 1,
        }),
    ]);

    // Если оба вызова упали — значит LLM недоступен (неверная модель, API-ошибка и т.п.)
    // Бросаем реальную ошибку вместо тихого возврата пустого массива
    if (userResp.status === 'rejected' && contactResp.status === 'rejected') {
        const reason = userResp.reason?.message || String(userResp.reason);
        throw new Error(`LLM недоступен при анализе переписки: ${reason}`);
    }

    if (userResp.status === 'rejected') {
        console.error('[studyChatFlow] LLM user-facts call failed:', userResp.reason);
    }
    if (contactResp.status === 'rejected') {
        console.error('[studyChatFlow] LLM contact-facts call failed:', contactResp.reason);
    }

    const userFacts = userResp.status === 'fulfilled'
        ? parseFacts(userResp.value.choices[0]?.message?.content?.trim() || '', 'user', contactName)
        : [];

    const contactFacts = contactResp.status === 'fulfilled'
        ? parseFacts(contactResp.value.choices[0]?.message?.content?.trim() || '', 'contact', contactName)
        : [];

    return {
        facts: [...userFacts, ...contactFacts],
        partialFailure: userResp.status === 'rejected' || contactResp.status === 'rejected',
    };
}

// ─── Синтез: консолидация каждой группы отдельно ─────────────────────────────
//
// Синтез запускается раздельно для фактов о пользователе и фактов о контакте.
// LLM никогда не видит смешанный список — это исключает любую возможность
// переатрибуции фактов между людьми на этапе консолидации.

const SYNTHESIS_SYSTEM = `Ты синтезируешь и консолидируешь факты об одном конкретном человеке.
Отвечай ТОЛЬКО валидным JSON с полем facts. Никакого текста вне JSON.`;

function buildSynthesisPrompt(facts: ExtractedFactAboutUser[], personName: string): string {
    const factsText = facts
        .map((f, i) => [
            `${i + 1}. [${f.domain}]`,
            `importance=${f.importance.toFixed(2)}`,
            `confidence=${(f.confidence ?? 0.62).toFixed(2)}`,
            `inferenceLevel=${f.inferenceLevel ?? 'direct'}`,
            `temporalScope=${f.temporalScope ?? 'unknown'}`,
            `status=${f.status ?? 'active'}`,
            `content="${f.content}"`,
            f.predicate ? `predicate="${f.predicate}"` : '',
            f.object ? `object="${f.object}"` : '',
            f.evidence ? `evidence="${f.evidence}"` : '',
            f.validFrom ? `validFrom=${f.validFrom.toISOString()}` : '',
            f.validTo ? `validTo=${f.validTo.toISOString()}` : '',
        ].filter(Boolean).join(' | '))
        .join('\n');

    return `Все факты ниже — только о ${personName}. Консолидируй их.

Факты:
${factsText}

Задача:
1. Дедуплицируй только варианты одного и того же subject/predicate/object. Разные предикаты никогда не объединяй.
2. Если факт встречается в нескольких вариантах → это паттерн → повысь importance
3. Убери тривиальные факты (importance < 0.3 без явной ценности)
4. Каждая запись должна содержать ровно одно атомарное утверждение; не добавляй вторую характеристику через запятую или союз.
5. Уточняй домен если нужно
6. Сохраняй evidence и confidence. Если обобщаешь несколько слабых намёков в паттерн — confidence не выше 0.65.
7. Не превращай одноразовое настроение в черту характера.
8. Сохраняй temporalScope/status: план не должен стать устойчивой чертой, а past_event не должен стать current_state.
9. Сохраняй inferenceLevel: direct можно укреплять, inferred/ambiguous требуют меньшей confidence и осторожной формулировки.
10. evidence копируй из кандидатов без изменения: сохрани исходные даты, speaker label и переносы строк. Не меняй автора и не объединяй реплики разных людей в одну безымянную фразу.
11. Если evidence не содержит строки, которая однозначно подтверждает факт именно о ${personName}, отбрось кандидат.

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Финальный факт, одним предложением",
      "predicate": "один атомарный предикат",
      "object": "объект этого предиката",
      "domain": "${DOMAIN_LIST}",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "самая короткая опора из исходных фактов",
      "inferenceLevel": "direct|reported|inferred|ambiguous",
      "temporalScope": "stable|preference|routine|current_state|future_plan|past_event|relationship|unknown",
      "status": "active|planned|done|unknown",
      "validFrom": "ISO date или null",
      "validTo": "ISO date или null",
      "tags": ["тег1", "тег2"]
    }
  ]
}`;
}

/** Синтезирует одну группу фактов (только user или только contact) */
async function synthesizeGroup(
    facts: ExtractedFactAboutUser[],
    subject: 'user' | 'contact',
    personName: string
): Promise<ExtractedFactAboutUser[]> {
    if (facts.length === 0) return [];
    // Бинарные связи уже атомарны и несут проверенные endpoint-ы. Не отдаём их
    // генеративному синтезу, который может потерять targetRole/targetName или
    // незаметно поменять направление связи.
    const relationFacts = deduplicatePersonRelations(facts.filter(fact => fact.personRelation));
    const synthesisCandidates = facts.filter(fact => !fact.personRelation);
    if (synthesisCandidates.length === 0) return relationFacts;
    // Запускаем синтез даже для небольших групп — он сливает семантически похожие факты
    // и поднимает importance для повторяющихся паттернов
    if (synthesisCandidates.length === 1) return [...relationFacts, ...synthesisCandidates];

    try {
        const resp = await createChatCompletionForTask('messageAnalysis', {
            messages: [
                { role: 'system', content: SYNTHESIS_SYSTEM },
                { role: 'user', content: buildSynthesisPrompt(synthesisCandidates, personName) },
            ],
            temperature: 1,
        });

        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ facts?: unknown[] }>(text);
        if (!data || !Array.isArray(data.facts)) {
            return [...relationFacts, ...deduplicateExact(synthesisCandidates)];
        }

        const synthesized = data.facts
            .filter((f: any) => f?.content && f?.domain)
            .map((f: any) => normalizeFactLike(f, subject))
            .filter((fact) => fact.content.length >= 8);
        // При нарушении атомарности не теряем исходные проверяемые факты и не
        // сохраняем склейку, придуманную этапом синтеза.
        const ordinaryFacts = synthesized.some(fact => containsMultipleAssertions(fact.content))
            ? deduplicateExact(synthesisCandidates)
            : synthesized;
        return [...relationFacts, ...ordinaryFacts];
    } catch (e) {
        console.error(`synthesizeGroup(${subject}) error:`, e);
        return [...relationFacts, ...deduplicateExact(synthesisCandidates)];
    }
}

async function synthesizeFacts(
    rawFacts: ExtractedFactAboutUser[],
    contactName: string,
    options: { sequential?: boolean } = {}
): Promise<ExtractedFactAboutUser[]> {
    if (rawFacts.length === 0) return [];

    const ownerName = config.ownerName || 'пользователь';
    const userFacts = rawFacts.filter(f => f.subject === 'user');
    const contactFacts = rawFacts.filter(f => f.subject === 'contact');

    if (options.sequential) {
        const synthUser = await synthesizeGroup(userFacts, 'user', ownerName);
        const synthContact = await synthesizeGroup(contactFacts, 'contact', contactName);
        return [...synthUser, ...synthContact];
    }

    // Оба синтеза параллельно, каждый про одного человека
    const [synthUser, synthContact] = await Promise.all([
        synthesizeGroup(userFacts, 'user', ownerName),
        synthesizeGroup(contactFacts, 'contact', contactName),
    ]);

    return [...synthUser, ...synthContact];
}

function deduplicateExact(facts: ExtractedFactAboutUser[]): ExtractedFactAboutUser[] {
    const seen = new Set<string>();
    return facts.filter(f => {
        const key = f.content.toLowerCase().replace(/\s+/g, ' ').slice(0, 100);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
    });
}

function deduplicatePersonRelations(facts: ExtractedFactAboutUser[]): ExtractedFactAboutUser[] {
    const byRelation = new Map<string, ExtractedFactAboutUser>();
    for (const fact of facts) {
        const relation = fact.personRelation;
        if (!relation) continue;
        const key = [
            fact.subject,
            relation.type,
            relation.targetRole,
            relation.targetName?.toLocaleLowerCase('ru-RU') ?? '',
        ].join('|');
        const existing = byRelation.get(key);
        if (!existing || (fact.confidence ?? 0) > (existing.confidence ?? 0)) {
            byRelation.set(key, fact);
        } else if (fact.importance > existing.importance) {
            byRelation.set(key, { ...existing, importance: fact.importance });
        }
    }
    return [...byRelation.values()];
}

type FactCriticAction = 'keep' | 'rewrite' | 'drop';

interface FactCriticDecision {
    index?: number;
    action?: FactCriticAction;
    content?: string;
    domain?: string;
    importance?: number;
    confidence?: number;
    evidence?: string;
    inferenceLevel?: InferenceLevel;
    temporalScope?: TemporalScope;
    status?: MemoryStatus;
    validFrom?: string | null;
    validTo?: string | null;
    reason?: string;
    tags?: string[];
}

interface FactCriticResponse {
    decisions?: FactCriticDecision[];
}

function isTooGenericForLongTermMemory(fact: ExtractedFactAboutUser): boolean {
    const lc = fact.content.toLowerCase();
    if (fact.content.length < 14) return true;
    if (/^(пользователь|собеседник|контакт)\s+(общался|написал|спросил|ответил|обсуждал)/iu.test(lc)) return true;
    if (/^(он|она|контакт)\s+(общался|написал|спросил|ответил|обсуждал)/iu.test(lc)) return true;
    if (/переписывал[аи]сь|была переписка|в чате обсуждал/iu.test(lc) && (fact.importance ?? 0) < 0.65) return true;
    return false;
}

function deterministicQualityGate(
    facts: ExtractedFactAboutUser[],
    contactName?: string,
): ExtractedFactAboutUser[] {
    return filterUserFactsForThirdPartyEvents(
        filterFactsForEvidenceAttribution(
            deduplicateExact(facts),
            config.ownerName,
            contactName,
            { requireSupport: true },
        ),
        config.ownerName,
        contactName,
    )
        .map((fact) => {
            const confidence = clamp01(fact.confidence, 0.62);
            const personRelation = normalizeSupportedPersonRelation(fact.personRelation, {
                subject: fact.subject,
                content: fact.content,
                evidence: fact.evidence,
                contactName,
            });
            const warnings = [...(fact.qualityWarnings ?? [])];
            if (!fact.evidence && confidence < 0.75) warnings.push('no-evidence');
            if (isTooGenericForLongTermMemory(fact)) warnings.push('too-generic');
            const tags = [...new Set([
                ...normalizeTags(fact.tags),
                ...warnings.map((warning) => `quality:${warning}`),
                fact.inferenceLevel ? `inference:${fact.inferenceLevel}` : '',
                fact.inferenceLevel === 'inferred' || fact.inferenceLevel === 'ambiguous' ? 'needs-caution' : '',
                fact.temporalScope ? `temporal_scope:${fact.temporalScope}` : '',
                fact.status && fact.status !== 'active' ? `status:${fact.status}` : '',
                confidence < 0.55 ? 'weak-evidence' : '',
                confidence >= 0.78 ? 'supported' : '',
            ].filter(Boolean))];
            return {
                ...fact,
                confidence,
                tags,
                personRelation,
                qualityWarnings: warnings.length > 0 ? warnings : undefined,
            };
        })
        .filter((fact) => fact.importance >= 0.25)
        .filter((fact) => (fact.confidence ?? 0.62) >= 0.35)
        .filter((fact) => !fact.qualityWarnings?.includes('too-generic'))
        .filter((fact) => !containsMultipleAssertions(fact.content));
}

function buildCriticPrompt(
    conversationText: string,
    facts: ExtractedFactAboutUser[],
    contactName: string,
    periodLabel: string,
    options: FactExtractionOptions = {}
): string {
    const ownerName = config.ownerName || 'пользователь';
    const reflectionRules = options.mode === 'reflection'
        ? `
Дополнительные правила для фоновой рефлексии:
- drop для одноразовых технических/рабочих деталей про инструменты, ChatGPT, файлы, распознавание, портирование, обработку материалов.
- drop для "сейчас занимается задачей", "пока находится в городе", "долго обрабатывает", если нет долгосрочного значения.
- keep только если факт помогает будущему поведению ассистента, отражает устойчивое знание или важное событие.
- Для subject=contact делай drop, если evidence не содержит явного имени/обращения или первого лица собеседника. Источник-чата сам по себе не доказывает субъект.
- Фразу с пропущенным субъектом и событие про родственника нельзя переписывать как факт о владельце чата.
- rewrite допустим, если из технической детали можно аккуратно получить устойчивое правило помощи, явно поддержанное перепиской.`
        : '';
    const factsText = facts.map((fact, index) => [
        `${index}. subject=${fact.subject}`,
        `domain=${fact.domain}`,
        `importance=${fact.importance.toFixed(2)}`,
        `confidence=${(fact.confidence ?? 0.62).toFixed(2)}`,
        `inferenceLevel=${fact.inferenceLevel ?? 'direct'}`,
        `temporalScope=${fact.temporalScope ?? 'unknown'}`,
        `status=${fact.status ?? 'active'}`,
        `content="${fact.content}"`,
        fact.personRelation
            ? `personRelation=${fact.personRelation.type}->${fact.personRelation.targetRole}:${fact.personRelation.targetName ?? ''}`
            : '',
        fact.evidence ? `evidence="${fact.evidence}"` : '',
        fact.validFrom ? `validFrom=${fact.validFrom.toISOString()}` : '',
        fact.validTo ? `validTo=${fact.validTo.toISOString()}` : '',
    ].filter(Boolean).join('; ')).join('\n');

    return `Проверь качество фактов перед записью в долговременную память.
Владелец: ${ownerName}. Собеседник: ${contactName}. Период: ${periodLabel}.

Переписка:
${conversationText}

Кандидаты:
${factsText}

Правила проверки:
- keep: факт явно поддержан перепиской и полезен в будущем.
- rewrite: факт поддержан, но формулировка слишком широкая/путает атрибуцию/нужна осторожность.
- drop: факт не поддержан, слишком общий, тривиальный, пересказывает сам факт переписки, путает ${ownerName} и ${contactName}, или превращает один эпизод в черту характера.
- evidence обязано сохранять исходную строку вместе с датой и speaker label. Не удаляй и не меняй автора при keep/rewrite.
- Проверяй местоимение только внутри строки его автора: "${contactName}: я ..." относится к ${contactName}, "Я: я ..." — к ${ownerName}; "мой родственник" остаётся третьим лицом.
- Если evidence поддерживает другого участника или не позволяет доказать subject кандидата, делай drop, а не исправляй автора догадкой.
- КРИТИЧНО для subject=user: если факт описывает событие/праздник/ДР/годовщину/встречу/игру/поездку, проверь, ЧЕЙ это праздник/инициатива. Если инициатор и «именинник» — ${contactName}, а ${ownerName} лишь приглашён/вписан — это факт о ${contactName}, для subject=user делай drop (или rewrite в «приглашён на событие собеседника» с понижением confidence).
- Нельзя выводить устойчивую черту из одного слабого намёка. Лучше rewrite в узкий временный факт или lower confidence.
- Факты о планах, настроении и текущем состоянии должны иметь lower confidence, если не ясно, актуальны ли они после периода.
- Проверяй временную природу: future_plan=status planned, past_event=status done, current_state=актуально только на момент переписки.
- Если факт был правдой только во время переписки, не превращай его в stable.
- Проверяй inferenceLevel: direct сильнее, reported требует осторожности, inferred/ambiguous нельзя усиливать до высокой уверенности.
- Для personRelation проверяй оба конца связи. Не угадывай targetName и не меняй type/targetRole: если они не доказаны, делай drop.
- Верни решение для каждого index.
${reflectionRules}

JSON:
{
  "decisions": [
    {
      "index": 0,
      "action": "keep|rewrite|drop",
      "content": "только для rewrite",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "importance": 0.0-1.0,
      "confidence": 0.0-1.0,
      "evidence": "короткая опора",
      "inferenceLevel": "direct|reported|inferred|ambiguous",
      "temporalScope": "stable|preference|routine|current_state|future_plan|past_event|relationship|unknown",
      "status": "active|planned|done|unknown",
      "validFrom": "ISO date или null",
      "validTo": "ISO date или null",
      "reason": "коротко",
      "tags": ["дополнительные теги"]
    }
  ]
}`;
}

function applyCriticDecision(
    fact: ExtractedFactAboutUser,
    decision: FactCriticDecision | undefined
): ExtractedFactAboutUser | null {
    if (!decision || !decision.action) {
        return fact;
    }
    const reason = normalizeText(decision.reason, 100);
    if (decision.action === 'drop') {
        return null;
    }

    const content = decision.action === 'rewrite'
        ? normalizeText(decision.content, 420)
        : fact.content;
    if (!content || content.length < 8) return fact;
    const confidence = clamp01(decision.confidence, fact.confidence ?? 0.62);
    const inferenceLevel = normalizeInferenceLevel(decision.inferenceLevel ?? fact.inferenceLevel, confidence, decision.evidence ?? fact.evidence);
    const temporalScope = normalizeTemporalScope(decision.temporalScope ?? fact.temporalScope, content);
    const status = normalizeStatus(decision.status ?? fact.status, temporalScope, content);
    const tags = [...new Set([
        ...normalizeTags(fact.tags),
        ...normalizeTags(decision.tags),
        decision.action === 'rewrite' ? 'critic-rewritten' : 'critic-reviewed',
        `inference:${inferenceLevel}`,
        inferenceLevel === 'inferred' || inferenceLevel === 'ambiguous' ? 'needs-caution' : '',
        `temporal_scope:${temporalScope}`,
        status && status !== 'active' ? `status:${status}` : '',
        confidence < 0.55 ? 'weak-evidence' : '',
    ].filter(Boolean))];

    return {
        ...fact,
        content,
        object: content !== fact.content ? content : fact.object,
        domain: normalizeDomain(decision.domain ?? fact.domain),
        importance: clamp01(decision.importance, fact.importance),
        confidence,
        evidence: normalizeEvidence(decision.evidence, MAX_EVIDENCE_CHARS) ?? fact.evidence,
        inferenceLevel,
        temporalScope,
        status,
        validFrom: parseDateMaybe(decision.validFrom) ?? fact.validFrom,
        validTo: parseDateMaybe(decision.validTo) ?? fact.validTo,
        tags,
        qualityWarnings: reason ? [...(fact.qualityWarnings ?? []), `critic:${reason}`] : fact.qualityWarnings,
    };
}

async function critiqueFactsAgainstConversation(
    conversationText: string,
    facts: ExtractedFactAboutUser[],
    contactName: string,
    periodLabel: string,
    options: FactExtractionOptions = {}
): Promise<ExtractedFactAboutUser[]> {
    const gated = deterministicQualityGate(facts, contactName);
    if (gated.length === 0) return [];

    if (conversationText.length > MAX_CRITIC_CONTEXT_CHARS) {
        return gated;
    }

    const reviewed: ExtractedFactAboutUser[] = [];
    for (let i = 0; i < gated.length; i += FACT_CRITIC_BATCH_SIZE) {
        const batch = gated.slice(i, i + FACT_CRITIC_BATCH_SIZE);
        try {
            const resp = await createChatCompletionForTask('memoryExtraction', {
                messages: [
                    {
                        role: 'system',
                        content: 'Ты строгий критик долговременной памяти. Отвечай только валидным JSON.',
                    },
                    { role: 'user', content: buildCriticPrompt(conversationText, batch, contactName, periodLabel, options) },
                ],
                temperature: 0,
                response_format: { type: 'json_object' },
            });
            const parsed = parseLLMJson<FactCriticResponse>(resp.choices[0]?.message?.content || '');
            const decisions = new Map<number, FactCriticDecision>();
            for (const decision of parsed?.decisions ?? []) {
                if (typeof decision.index === 'number') decisions.set(decision.index, decision);
            }

            for (let j = 0; j < batch.length; j++) {
                const next = applyCriticDecision(batch[j], decisions.get(j));
                if (next) reviewed.push(next);
            }
        } catch (e) {
            console.error('[studyChatFlow] fact critic failed:', e);
            reviewed.push(...batch);
        }
    }

    return deterministicQualityGate(reviewed, contactName);
}

function withTemporalDefaults(
    facts: ExtractedFactAboutUser[],
    startDate?: Date,
    endDate?: Date
): ExtractedFactAboutUser[] {
    const observedFrom = startDate && Number.isFinite(startDate.getTime()) ? startDate : undefined;
    const observedTo = endDate && Number.isFinite(endDate.getTime()) ? endDate : observedFrom;
    const observedAgeDays = observedTo
        ? Math.max(0, (Date.now() - observedTo.getTime()) / 86_400_000)
        : 0;

    return facts.map((fact) => {
        const temporalScope = fact.temporalScope ?? normalizeTemporalScope(undefined, fact.content);
        let status = fact.status ?? normalizeStatus(undefined, temporalScope, fact.content);
        let confidence = fact.confidence ?? 0.62;
        const tags = new Set(normalizeTags(fact.tags));
        const inferenceLevel = fact.inferenceLevel ?? normalizeInferenceLevel(undefined, confidence, fact.evidence);
        tags.add(`inference:${inferenceLevel}`);
        if (inferenceLevel === 'inferred' || inferenceLevel === 'ambiguous') {
            tags.add('needs-caution');
            confidence = Math.min(confidence, inferenceLevel === 'ambiguous' ? 0.50 : 0.68);
        }
        tags.add(`temporal_scope:${temporalScope}`);

        if (temporalScope === 'current_state' && observedAgeDays > 120) {
            status = 'unknown';
            confidence = Math.min(confidence, 0.58);
            tags.add('possibly-stale');
            tags.add('weak-evidence');
        }

        if (temporalScope === 'future_plan') status = status === 'done' ? 'done' : 'planned';
        if (temporalScope === 'past_event') status = 'done';
        if (status && status !== 'active') tags.add(`status:${status}`);

        return {
            ...fact,
            inferenceLevel,
            temporalScope,
            status,
            confidence,
            validFrom: fact.validFrom ?? observedFrom,
            validTo: fact.validTo ?? (temporalScope === 'past_event' ? observedTo : undefined),
            tags: [...tags],
        };
    });
}

// ─── Публичная функция ─────────────────────────────────────────────────────────

// Максимум параллельных LLM-вызовов для чанков (каждый чанк = 2 вызова)
const DEFAULT_CHUNK_CONCURRENCY = 4;
const GEMINI_FULL_CHUNK_CONCURRENCY = 1;

interface StudyChatExecutionMode {
    presetName: string;
    chunkConcurrency: number;
    sequentialSynthesis: boolean;
}

async function resolveStudyChatExecutionMode(): Promise<StudyChatExecutionMode> {
    const configuredGeminiConcurrency = Number(process.env.AI_STUDY_CHAT_GEMINI_CHUNK_CONCURRENCY);
    const geminiConcurrency = Number.isFinite(configuredGeminiConcurrency) && configuredGeminiConcurrency > 0
        ? Math.floor(configuredGeminiConcurrency)
        : GEMINI_FULL_CHUNK_CONCURRENCY;

    const presetName = await getActivePresetNameAsync();
    const isGeminiFull = presetName === 'gemini-full';
    return {
        presetName,
        chunkConcurrency: isGeminiFull ? geminiConcurrency : DEFAULT_CHUNK_CONCURRENCY,
        sequentialSynthesis: isGeminiFull,
    };
}

/**
 * Извлекает из текста переписки факты о пользователе (о "Я").
 *
 * Алгоритм:
 * 1. Разбивает текст на чанки по строкам с перекрытием (контекст не теряется)
 * 2. Извлекает сырые факты из чанков батчами (защита от rate-limit)
 * 3. Запускает синтез: умная дедупликация, буст повторяющихся тем, выводы
 */
export async function extractFactsAboutUserFromConversation(
    conversationText: string,
    contactName: string,
    startDate?: Date,
    endDate?: Date,
    onProgress?: StudyChatAnalysisProgressHandler,
    options: FactExtractionOptions = {}
): Promise<ExtractedFactAboutUser[]> {
    if (!conversationText.trim()) return [];

    const emitProgress = async (progress: StudyChatAnalysisProgress): Promise<void> => {
        if (!onProgress) return;
        try {
            await onProgress(progress);
        } catch (e) {
            console.error('[studyChatFlow] progress callback failed:', e);
        }
    };

    const chunks = splitIntoChunks(conversationText);
    const executionMode = await resolveStudyChatExecutionMode();
    const { chunkConcurrency, sequentialSynthesis } = executionMode;
    console.log(`[studyChatFlow] Анализ переписки: ${chunks.length} чанк(ов), ${conversationText.length} символов`);
    await emitProgress({
        stage: 'chunks_ready',
        chunksTotal: chunks.length,
        charactersTotal: conversationText.length,
    });

    // Формируем метку периода для промптов
    const periodLabel = startDate && endDate
        ? `${startDate.toLocaleDateString('ru-RU')} — ${endDate.toLocaleDateString('ru-RU')}`
        : 'неизвестный период';

    // Извлечение чанков батчами — не более chunkConcurrency параллельных пар запросов
    const chunkResults: PromiseSettledResult<ChunkExtractionResult>[] = [];
    let rawFactsCountSoFar = 0;
    for (let i = 0; i < chunks.length; i += chunkConcurrency) {
        const batch = chunks.slice(i, i + chunkConcurrency);
        const batchResults = await Promise.allSettled(
            batch.map(chunk => extractRawFactsFromChunk(chunk, contactName, periodLabel, options))
        );
        chunkResults.push(...batchResults);
        for (const result of batchResults) {
            if (result.status === 'fulfilled') rawFactsCountSoFar += result.value.facts.length;
        }
        await emitProgress({
            stage: 'batch_done',
            chunksDone: Math.min(i + batch.length, chunks.length),
            chunksTotal: chunks.length,
            rawFactsCount: rawFactsCountSoFar,
        });
    }

    const rawFacts: ExtractedFactAboutUser[] = [];
    let firstChunkError: string | undefined;
    let partiallyFailedChunks = 0;
    for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
            rawFacts.push(...result.value.facts);
            if (result.value.partialFailure) {
                partiallyFailedChunks += 1;
            }
        } else {
            const reason = result.reason?.message || String(result.reason);
            if (!firstChunkError) firstChunkError = reason;
            console.error('[studyChatFlow] Ошибка чанка:', reason);
        }
    }

    const rejectedChunks = chunkResults.filter((result) => result.status === 'rejected').length;
    const degradedChunks = rejectedChunks + partiallyFailedChunks;
    if (degradedChunks > 0 && rawFacts.length > 0) {
        console.warn('[studyChatFlow] degraded mode', {
            presetName: executionMode.presetName,
            chunkConcurrency,
            chunksTotal: chunks.length,
            failedChunks: rejectedChunks,
            partiallyFailedChunks,
            successfulChunks: chunkResults.length - rejectedChunks,
        });
    }

    // Все чанки упали — пробрасываем ошибку, чтобы пользователь увидел причину
    if (rawFacts.length === 0 && firstChunkError) {
        throw new Error(firstChunkError);
    }

    const attributableRawFacts = filterFactsForEvidenceAttribution(
        rawFacts,
        config.ownerName,
        contactName,
        { requireSupport: true },
    ).filter(fact => (fact.confidence ?? 0.62) >= 0.35);
    console.log(
        `[studyChatFlow] Сырых фактов извлечено: ${rawFacts.length}; ` +
        `после проверки автора: ${attributableRawFacts.length}`,
    );
    await emitProgress({ stage: 'raw_facts_ready', rawFactsCount: attributableRawFacts.length });

    // Синтез: консолидация + умная дедупликация
    await emitProgress({ stage: 'synthesis_start', rawFactsCount: attributableRawFacts.length });
    const finalFacts = await synthesizeFacts(attributableRawFacts, contactName, { sequential: sequentialSynthesis });
    console.log(`[studyChatFlow] Финальных фактов после синтеза: ${finalFacts.length}`);
    await emitProgress({ stage: 'synthesis_done', factsCount: finalFacts.length });

    const qualityCheckedFacts = await critiqueFactsAgainstConversation(
        conversationText,
        finalFacts,
        contactName,
        periodLabel,
        options
    );
    const temporallyGroundedFacts = withTemporalDefaults(qualityCheckedFacts, startDate, endDate);
    console.log(`[studyChatFlow] Фактов после quality-gate: ${temporallyGroundedFacts.length}`);

    // Проставляем contactName для фактов о собеседнике
    return temporallyGroundedFacts.map(f =>
        f.subject === 'contact' ? { ...f, contactName } : f
    );
}
