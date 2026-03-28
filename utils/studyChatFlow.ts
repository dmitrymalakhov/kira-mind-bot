import { Api } from 'telegram';
import { initTelegramClient } from '../services/telegram';
import openai from '../openai';
import { config } from '../config';
import { parseLLMJson } from '../utils';

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
    /** Кому принадлежит факт: 'user' — владелец бота ("Я"), 'contact' — собеседник */
    subject: 'user' | 'contact';
    /** Имя собеседника (заполняется только когда subject = 'contact') */
    contactName?: string;
}

// ─── Константы ────────────────────────────────────────────────────────────────

const CHUNK_MAX_CHARS = 12000;  // ~150–200 сообщений на чанк, чтобы не превышать контекст gpt-5-nano
const CHUNK_OVERLAP_LINES = 30; // строки-перекрытие между чанками для контекстности

const VALID_DOMAINS = new Set(['work', 'health', 'family', 'finance', 'education', 'hobbies', 'travel', 'social', 'home', 'personal', 'entertainment', 'general']);

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
    const ownerName = config.ownerName || 'Дмитрий';
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
      "tags": ["тег"]
    }
  ]
}
Если фактов нет — {"facts": []}.`;
}

/** Промпт для извлечения фактов о собеседнике (контакте) */
function buildContactFactsPrompt(chunk: string, contactName: string, periodLabel: string): string {
    const ownerName = config.ownerName || 'Дмитрий';
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
        .map((f: any) => {
            const rawDomain = String(f.domain).trim().toLowerCase();
            return {
                content: String(f.content).trim(),
                subject,
                domain: VALID_DOMAINS.has(rawDomain) ? rawDomain : 'general',
                importance: typeof f.importance === 'number' ? Math.min(1, Math.max(0, f.importance)) : 0.5,
                tags: Array.isArray(f.tags) ? f.tags.map((t: unknown) => String(t)) : [],
            };
        }) as ExtractedFactAboutUser[];
}

async function extractRawFactsFromChunk(
    chunk: string,
    contactName: string,
    periodLabel: string
): Promise<ExtractedFactAboutUser[]> {
    // Два параллельных запроса — каждый про одного человека
    const [userResp, contactResp] = await Promise.allSettled([
        openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: buildUserFactsPrompt(chunk, contactName, periodLabel) },
            ],
            temperature: 0.2,
        }),
        openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: EXTRACTION_SYSTEM },
                { role: 'user', content: buildContactFactsPrompt(chunk, contactName, periodLabel) },
            ],
            temperature: 0.2,
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
        .map((f, i) => `${i + 1}. [${f.domain}] importance=${f.importance.toFixed(2)} | ${f.content}`)
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

Домены: ${DOMAIN_LIST}

JSON:
{
  "facts": [
    {
      "content": "Финальный факт, одним предложением",
      "domain": "${DOMAIN_LIST}",
      "importance": 0.0-1.0,
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
            model: 'gpt-4.1',
            messages: [
                { role: 'system', content: SYNTHESIS_SYSTEM },
                { role: 'user', content: buildSynthesisPrompt(facts, personName) },
            ],
            temperature: 0.2,
        });

        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ facts?: unknown[] }>(text);
        if (!data || !Array.isArray(data.facts)) return deduplicateExact(facts);

        return data.facts
            .filter((f: any) => f?.content && f?.domain)
            .map((f: any) => {
                const rawDomain = String(f.domain).trim().toLowerCase();
                return {
                    content: String(f.content).trim(),
                    subject, // subject фиксирован — LLM его не трогает
                    domain: VALID_DOMAINS.has(rawDomain) ? rawDomain : 'general',
                    importance: typeof f.importance === 'number' ? Math.min(1, Math.max(0, f.importance)) : 0.5,
                    tags: Array.isArray(f.tags) ? f.tags.map((t: unknown) => String(t)) : [],
                };
            }) as ExtractedFactAboutUser[];
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

    const ownerName = config.ownerName || 'Дмитрий';
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
    endDate?: Date
): Promise<ExtractedFactAboutUser[]> {
    if (!conversationText.trim()) return [];

    const chunks = splitIntoChunks(conversationText);
    console.log(`[studyChatFlow] Анализ переписки: ${chunks.length} чанк(ов), ${conversationText.length} символов`);

    // Формируем метку периода для промптов
    const periodLabel = startDate && endDate
        ? `${startDate.toLocaleDateString('ru-RU')} — ${endDate.toLocaleDateString('ru-RU')}`
        : 'неизвестный период';

    // Извлечение чанков батчами — не более CHUNK_CONCURRENCY параллельных пар запросов
    const chunkResults: PromiseSettledResult<ExtractedFactAboutUser[]>[] = [];
    for (let i = 0; i < chunks.length; i += CHUNK_CONCURRENCY) {
        const batch = chunks.slice(i, i + CHUNK_CONCURRENCY);
        const batchResults = await Promise.allSettled(
            batch.map(chunk => extractRawFactsFromChunk(chunk, contactName, periodLabel))
        );
        chunkResults.push(...batchResults);
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

    // Синтез: консолидация + умная дедупликация
    const finalFacts = await synthesizeFacts(rawFacts, contactName);
    console.log(`[studyChatFlow] Финальных фактов после синтеза: ${finalFacts.length}`);

    // Проставляем contactName для фактов о собеседнике
    return finalFacts.map(f =>
        f.subject === 'contact' ? { ...f, contactName } : f
    );
}
