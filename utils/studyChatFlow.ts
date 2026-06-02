import { Api } from 'telegram';
import { initTelegramClient } from '../services/telegram';
import openai from '../openai';
import { config } from '../config';
import { parseLLMJson } from '../utils';
import type { MemoryStatus } from '../types';

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
        // msg.out надёжнее fromId: в личных чатах fromId для собственных сообщений бывает null
        const isOwn = msg.out || fromId === ownerId;
        const sender = isOwn ? 'Я' : contactName;
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

function normalizeFactLike(f: any, subject: 'user' | 'contact'): ExtractedFactAboutUser {
    const confidence = clamp01(f?.confidence, 0.62);
    const tags = normalizeTags(f?.tags);
    const content = String(f.content).replace(/\s+/g, ' ').trim();
    const evidence = normalizeText(f.evidence, MAX_EVIDENCE_CHARS);
    const inferenceLevel = normalizeInferenceLevel(f?.inferenceLevel, confidence, evidence);
    const temporalScope = normalizeTemporalScope(f?.temporalScope, content);
    const status = normalizeStatus(f?.status, temporalScope, content);
    if (confidence < 0.55) tags.push('weak-evidence');
    if (confidence >= 0.78) tags.push('supported');
    tags.push(`inference:${inferenceLevel}`);
    if (inferenceLevel === 'inferred' || inferenceLevel === 'ambiguous') tags.push('needs-caution');
    tags.push(`temporal_scope:${temporalScope}`);
    if (status && status !== 'active') tags.push(`status:${status}`);
    return {
        content,
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
// Это полностью устраняет проблему смешивания атрибуции между участниками:
//  - Проход 1: только факты о владельце (subject всегда 'user')
//  - Проход 2: только факты о собеседнике (subject всегда 'contact')
// Оба запроса выполняются параллельно.

const EXTRACTION_SYSTEM = `Ты анализируешь переписку и извлекаешь факты об одном конкретном человеке.
Отвечай ТОЛЬКО валидным JSON с полем facts. Никакого текста вне JSON.`;

const DOMAIN_LIST = 'work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general';

/** Промпт для извлечения фактов о владельце бота ("Я") */
function buildUserFactsPrompt(chunk: string, contactName: string, periodLabel: string): string {
    const ownerName = config.ownerName || 'пользователь';
    return `Переписка ${ownerName} ("Я") с ${contactName}. Период: ${periodLabel}.

Твоя задача: извлечь факты ТОЛЬКО о ${ownerName}.

Источники фактов о ${ownerName}:
1. Строки "[дата] Я: ..." — что ${ownerName} говорит о себе напрямую
2. Строки "[дата] ${contactName}: ..." — когда контакт говорит о ${ownerName} или обращается к нему
   Примеры: "ты всегда задерживаешься", "${ownerName}, ты же программист?", "ты столько работаешь"

Имена/обращения к ${ownerName}: "${ownerName}", сокращения его имени, "ты" в контексте обращения к нему.

Что искать:
- Работа: должность, компания, график, проекты, коллеги
- Семья и отношения: партнёр, дети, родители, их имена и ситуации
- Здоровье: самочувствие, привычки, проблемы, спорт
- Хобби и интересы: что любит, чем занимается в свободное время
- Финансы: траты, планы покупок, статус
- Характер и поведение: паттерны, реакции, ценности
- Планы и желания: куда хочет поехать, что купить, что сделать
- Косвенные выводы: "опять не сплю" → проблемы со сном

НЕ включай: факты о ${contactName} или третьих лицах.
НЕ включай: тривиальное ("написал сообщение"), единичные оговорки без контекста.
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

Переписка:
${chunk}

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Факт о ${ownerName}, одно предложение от третьего лица",
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
function buildContactFactsPrompt(chunk: string, contactName: string, periodLabel: string): string {
    const ownerName = config.ownerName || 'пользователь';
    return `Переписка ${ownerName} ("Я") с ${contactName}. Период: ${periodLabel}.

Твоя задача: извлечь факты ТОЛЬКО о ${contactName}.

Источники фактов о ${contactName}:
1. Строки "[дата] ${contactName}: ..." — что ${contactName} говорит о себе
   Примеры: "я устала", "у меня встреча", "мне не нравится", "я работаю в..."
2. Строки "[дата] Я: ..." — когда ${ownerName} говорит о ${contactName} или обращается к нему/ней
   Примеры: "ты постоянно переживаешь", "ты же работаешь в X?", "ты всегда так делаешь"

Что искать о ${contactName}:
- Работа и занятия
- Семья и отношения
- Интересы и привычки
- Характер и поведение: паттерны, реакции
- Здоровье и самочувствие
- Отношение к ${ownerName} и ситуациям

НЕ включай: факты о ${ownerName}.
НЕ включай: тривиальное, единичные случайные фразы без контекста.
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

Переписка:
${chunk}

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Факт о ${contactName}, одно предложение от третьего лица",
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

function parseFacts(text: string, subject: 'user' | 'contact'): ExtractedFactAboutUser[] {
    const data = parseLLMJson<{ facts?: unknown[] }>(text);
    if (!data || !Array.isArray(data.facts)) return [];
    return data.facts
        .filter((f: any) => f?.content && f?.domain)
        .map((f: any) => normalizeFactLike(f, subject))
        .filter((fact) => fact.content.length >= 8);
}

async function extractRawFactsFromChunk(
    chunk: string,
    contactName: string,
    periodLabel: string
): Promise<ExtractedFactAboutUser[]> {
    // Два параллельных запроса — каждый про одного человека
    const [userResp, contactResp] = await Promise.allSettled([
        openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: buildUserFactsPrompt(chunk, contactName, periodLabel) },
            ],
            temperature: 1,
        }),
        openai.chat.completions.create({
            model: 'gpt-5.4-nano',
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: buildContactFactsPrompt(chunk, contactName, periodLabel) },
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
        ? parseFacts(userResp.value.choices[0]?.message?.content?.trim() || '', 'user')
        : [];

    const contactFacts = contactResp.status === 'fulfilled'
        ? parseFacts(contactResp.value.choices[0]?.message?.content?.trim() || '', 'contact')
        : [];

    return [...userFacts, ...contactFacts];
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
            f.evidence ? `evidence="${f.evidence}"` : '',
            f.validFrom ? `validFrom=${f.validFrom.toISOString()}` : '',
            f.validTo ? `validTo=${f.validTo.toISOString()}` : '',
        ].filter(Boolean).join(' | '))
        .join('\n');

    return `Все факты ниже — только о ${personName}. Консолидируй их.

Факты:
${factsText}

Задача:
1. Объедини семантически похожие факты в один (наиболее точная формулировка)
2. Если факт встречается в нескольких вариантах → это паттерн → повысь importance
3. Убери тривиальные факты (importance < 0.3 без явной ценности)
4. Формулируй конкретно от третьего лица: не "любит работу", а "работает в IT, часто задерживается"
5. Уточняй домен если нужно
6. Сохраняй evidence и confidence. Если обобщаешь несколько слабых намёков в паттерн — confidence не выше 0.65.
7. Не превращай одноразовое настроение в черту характера.
8. Сохраняй temporalScope/status: план не должен стать устойчивой чертой, а past_event не должен стать current_state.
9. Сохраняй inferenceLevel: direct можно укреплять, inferred/ambiguous требуют меньшей confidence и осторожной формулировки.

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Финальный факт, одним предложением",
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
    // Запускаем синтез даже для небольших групп — он сливает семантически похожие факты
    // и поднимает importance для повторяющихся паттернов
    if (facts.length === 1) return facts;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4',
            messages: [
                { role: 'system', content: SYNTHESIS_SYSTEM },
                { role: 'user', content: buildSynthesisPrompt(facts, personName) },
            ],
            temperature: 1,
        });

        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ facts?: unknown[] }>(text);
        if (!data || !Array.isArray(data.facts)) return deduplicateExact(facts);

        return data.facts
            .filter((f: any) => f?.content && f?.domain)
            .map((f: any) => normalizeFactLike(f, subject))
            .filter((fact) => fact.content.length >= 8);
    } catch (e) {
        console.error(`synthesizeGroup(${subject}) error:`, e);
        return deduplicateExact(facts);
    }
}

async function synthesizeFacts(
    rawFacts: ExtractedFactAboutUser[],
    contactName: string
): Promise<ExtractedFactAboutUser[]> {
    if (rawFacts.length === 0) return [];

    const ownerName = config.ownerName || 'пользователь';
    const userFacts = rawFacts.filter(f => f.subject === 'user');
    const contactFacts = rawFacts.filter(f => f.subject === 'contact');

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
    if (/^(дмитрий|он|она|контакт)\s+(общался|написал|спросил|ответил|обсуждал)/iu.test(lc)) return true;
    if (/переписывал[аи]сь|была переписка|в чате обсуждал/iu.test(lc) && (fact.importance ?? 0) < 0.65) return true;
    return false;
}

function deterministicQualityGate(facts: ExtractedFactAboutUser[]): ExtractedFactAboutUser[] {
    return deduplicateExact(facts)
        .map((fact) => {
            const confidence = clamp01(fact.confidence, 0.62);
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
                qualityWarnings: warnings.length > 0 ? warnings : undefined,
            };
        })
        .filter((fact) => fact.importance >= 0.25)
        .filter((fact) => (fact.confidence ?? 0.62) >= 0.35)
        .filter((fact) => !fact.qualityWarnings?.includes('too-generic'));
}

function buildCriticPrompt(
    conversationText: string,
    facts: ExtractedFactAboutUser[],
    contactName: string,
    periodLabel: string
): string {
    const ownerName = config.ownerName || 'пользователь';
    const factsText = facts.map((fact, index) => [
        `${index}. subject=${fact.subject}`,
        `domain=${fact.domain}`,
        `importance=${fact.importance.toFixed(2)}`,
        `confidence=${(fact.confidence ?? 0.62).toFixed(2)}`,
        `inferenceLevel=${fact.inferenceLevel ?? 'direct'}`,
        `temporalScope=${fact.temporalScope ?? 'unknown'}`,
        `status=${fact.status ?? 'active'}`,
        `content="${fact.content}"`,
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
- Нельзя выводить устойчивую черту из одного слабого намёка. Лучше rewrite в узкий временный факт или lower confidence.
- Факты о планах, настроении и текущем состоянии должны иметь lower confidence, если не ясно, актуальны ли они после периода.
- Проверяй временную природу: future_plan=status planned, past_event=status done, current_state=актуально только на момент переписки.
- Если факт был правдой только во время переписки, не превращай его в stable.
- Проверяй inferenceLevel: direct сильнее, reported требует осторожности, inferred/ambiguous нельзя усиливать до высокой уверенности.
- Верни решение для каждого index.

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
        domain: normalizeDomain(decision.domain ?? fact.domain),
        importance: clamp01(decision.importance, fact.importance),
        confidence,
        evidence: normalizeText(decision.evidence, MAX_EVIDENCE_CHARS) ?? fact.evidence,
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
    periodLabel: string
): Promise<ExtractedFactAboutUser[]> {
    const gated = deterministicQualityGate(facts);
    if (gated.length === 0) return [];

    if (conversationText.length > MAX_CRITIC_CONTEXT_CHARS) {
        return gated;
    }

    const reviewed: ExtractedFactAboutUser[] = [];
    for (let i = 0; i < gated.length; i += FACT_CRITIC_BATCH_SIZE) {
        const batch = gated.slice(i, i + FACT_CRITIC_BATCH_SIZE);
        try {
            const resp = await openai.chat.completions.create({
                model: 'gpt-5.4-nano',
                messages: [
                    {
                        role: 'system',
                        content: 'Ты строгий критик долговременной памяти. Отвечай только валидным JSON.',
                    },
                    { role: 'user', content: buildCriticPrompt(conversationText, batch, contactName, periodLabel) },
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

    return deterministicQualityGate(reviewed);
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
const CHUNK_CONCURRENCY = 4;

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
    onProgress?: StudyChatAnalysisProgressHandler
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

    // Извлечение чанков батчами — не более CHUNK_CONCURRENCY параллельных пар запросов
    const chunkResults: PromiseSettledResult<ExtractedFactAboutUser[]>[] = [];
    let rawFactsCountSoFar = 0;
    for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
        const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
        const batchResults = await Promise.allSettled(
            batch.map(chunk => extractRawFactsFromChunk(chunk, contactName, periodLabel))
        );
        chunkResults.push(...batchResults);
        for (const result of batchResults) {
            if (result.status === 'fulfilled') rawFactsCountSoFar += result.value.length;
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
    for (const result of chunkResults) {
        if (result.status === 'fulfilled') {
            rawFacts.push(...result.value);
        } else {
            const reason = result.reason?.message || String(result.reason);
            if (!firstChunkError) firstChunkError = reason;
            console.error('[studyChatFlow] Ошибка чанка:', reason);
        }
    }

    // Все чанки упали — пробрасываем ошибку, чтобы пользователь увидел причину
    if (rawFacts.length === 0 && firstChunkError) {
        throw new Error(firstChunkError);
    }

    console.log(`[studyChatFlow] Сырых фактов извлечено: ${rawFacts.length}`);
    await emitProgress({ stage: 'raw_facts_ready', rawFactsCount: rawFacts.length });

    // Синтез: консолидация + умная дедупликация
    await emitProgress({ stage: 'synthesis_start', rawFactsCount: rawFacts.length });
    const finalFacts = await synthesizeFacts(rawFacts, contactName);
    console.log(`[studyChatFlow] Финальных фактов после синтеза: ${finalFacts.length}`);
    await emitProgress({ stage: 'synthesis_done', factsCount: finalFacts.length });

    const qualityCheckedFacts = await critiqueFactsAgainstConversation(
        conversationText,
        finalFacts,
        contactName,
        periodLabel
    );
    const temporallyGroundedFacts = withTemporalDefaults(qualityCheckedFacts, startDate, endDate);
    console.log(`[studyChatFlow] Фактов после quality-gate: ${temporallyGroundedFacts.length}`);

    // Проставляем contactName для фактов о собеседнике
    return temporallyGroundedFacts.map(f =>
        f.subject === 'contact' ? { ...f, contactName } : f
    );
}
