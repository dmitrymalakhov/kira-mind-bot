import { getVectorService } from '../services/VectorServiceFactory';
import { MemoryEntry, SearchOptions } from '../types';
import { BotContext } from '../types';
import { devLog, parseLLMJson } from '../utils';
import openai from '../openai';
import { llmCache, LLM_CACHE_TTL } from './llmCache';

function vectorService() {
    return getVectorService();
}

const botId = process.env.BOT_ID || 'kira-mind-bot';

let lastSaveError: string | null = null;

export function getLastSaveError(): string | null {
    return lastSaveError;
}

// Факты с косинусным сходством выше этого порога считаются дубликатами — обновляем без проверки
const DEDUP_SIMILARITY_THRESHOLD = 0.92;
// Факты в диапазоне [CONTRADICTION_THRESHOLD, DEDUP_SIMILARITY_THRESHOLD) — похожие, но не идентичные.
// Именно здесь живут противоречия: "работаю в X" vs "перешёл в Y".
const CONTRADICTION_THRESHOLD = 0.72;

type ContradictionVerdict = 'contradicts' | 'updates' | 'complements';

interface ContradictionResult {
    verdict: ContradictionVerdict;
    /**
     * Объединённая формулировка для хранения в памяти.
     * Обязательна для 'contradicts' и 'updates', отсутствует для 'complements'.
     *
     * contradicts: сохраняет историю ("работал в Сбере, затем уволился")
     * updates:     отражает актуальное состояние ("переехал из Москвы в Питер")
     */
    mergedContent?: string;
}

/**
 * Спрашивает LLM, как два похожих факта соотносятся друг с другом.
 *
 * contradicts — факты прямо противоречат; mergedContent сохраняет историю ("работал в X, уволился")
 * updates     — новый факт обновляет старый; mergedContent отражает актуальное состояние
 * complements — факты не пересекаются, сохраняем оба
 */
async function checkContradiction(
    existingContent: string,
    newContent: string
): Promise<ContradictionResult> {
    const cacheKey = `contradiction:${existingContent.slice(0, 100)}|||${newContent.slice(0, 100)}`;
    const cached = llmCache.get<ContradictionResult>(cacheKey);
    if (cached) return cached;

    const prompt = `Два факта об одном человеке:

Факт А (старый): "${existingContent}"
Факт Б (новый): "${newContent}"

Определи отношение:
- "contradicts" — прямо противоречат: А и Б не могут быть одновременно актуальны (пример: "работает в Сбере" vs "уволился из Сбера")
- "updates" — Б обновляет или уточняет А: А устарел, Б — актуальная версия (пример: "живёт в Москве" vs "переехал в Питер")
- "complements" — не противоречат, добавляют разную информацию

Для "contradicts" — напиши mergedContent, сохраняющий историю: что было раньше и что изменилось.
  Пример: А="работает в Сбере", Б="уволился из Сбера" → "Работал в Сбере, затем уволился"
  Пример: А="не пьёт алкоголь", Б="выпил вчера пива" → "В целом не пьёт алкоголь, но иногда делает исключения"

Для "updates" — напиши mergedContent, отражающий актуальное состояние.
  Пример: А="живёт в Москве", Б="переехал в Питер" → "Переехал из Москвы в Питер"

Ответ только JSON:
{"verdict": "contradicts|updates|complements", "mergedContent": "обязательно для contradicts и updates"}`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                { role: 'user', content: prompt },
            ],
            temperature: 0,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ verdict?: string; mergedContent?: string }>(text);
        if (!data) return { verdict: 'complements' };
        const verdict: ContradictionVerdict =
            data.verdict === 'contradicts' ? 'contradicts' :
            data.verdict === 'updates' ? 'updates' : 'complements';
        const result: ContradictionResult = {
            verdict,
            mergedContent: verdict !== 'complements' && data.mergedContent
                ? String(data.mergedContent).trim()
                : undefined,
        };
        llmCache.set(cacheKey, result, LLM_CACHE_TTL.CONTRADICTION);
        return result;
    } catch {
        return { verdict: 'complements' };
    }
}

// Temporal keywords that suggest a fact has limited lifespan
const TEMPORAL_HINT_RE = new RegExp(
    [
        // Явные ожидания
        'жду', 'ожидаю', 'жду ответа', 'жду результатов', 'жду звонка', 'жду письма',
        // События и встречи
        'встреча', 'звонок', 'собрание', 'мероприятие', 'событие', 'вечеринка', 'концерт', 'конференция',
        // Поездки
        'отпуск', 'поездка', 'командировка', 'рейс', 'вылет', 'перелёт',
        // Ближайшие дни
        'сегодня', 'завтра', 'послезавтра',
        // Дни недели
        'в понедельник', 'в вторник', 'в среду', 'в четверг', 'в пятницу', 'в субботу', 'в воскресенье',
        'на понедельник', 'на вторник', 'на среду', 'на четверг', 'на пятницу', 'на субботу', 'на воскресенье',
        // Недели
        'на этой неделе', 'на следующей неделе', 'на прошлой неделе', 'в выходные', 'на выходных',
        // «Через N» — число или слово
        'через \\d+',
        'через несколько', 'через пару', 'через пол', 'через полгода', 'через квартал',
        'через неделю', 'через месяц', 'через год', 'через два', 'через три', 'через четыре', 'через пять',
        // Месяцы
        'в январе', 'в феврале', 'в марте', 'в апреле', 'в мае', 'в июне',
        'в июле', 'в августе', 'в сентябре', 'в октябре', 'в ноябре', 'в декабре',
        // «К + точка во времени»
        'к лету', 'к зиме', 'к весне', 'к осени',
        'к новому году', 'к праздникам', 'к выходным',
        'к концу недели', 'к концу месяца', 'к концу года',
        'к пятнице', 'к понедельнику', 'к вторнику', 'к среде', 'к четвергу', 'к субботе', 'к воскресенью',
        // Начало/конец периода
        'в начале', 'в конце', 'в середине',
        'в следующем месяце', 'в этом месяце', 'в следующем году',
        // Скорое наступление
        'скоро', 'вот-вот', 'со дня на день', 'с минуты на минуту',
        // Сроки и дедлайны
        'дедлайн', 'крайний срок', 'срок сдачи', 'до конца', 'до дедлайна',
        'истекает', 'заканчивается', 'скоро истекает',
        // Учёба и экзамены
        'экзамен', 'зачёт', 'защита', 'сдаю', 'сессия', 'контрольная',
        // Медицина
        'запись к', 'приём у врача', 'операция', 'обследование', 'анализы',
        // Намерения с временным горизонтом
        'планирую (поехать|съездить|пойти|сходить|полететь|сделать|записаться)',
        'собираюсь (поехать|съездить|пойти|сходить|полететь|сделать|записаться)',
        'хочу (поехать|съездить|пойти|сходить|полететь) (сегодня|завтра|на этой|на следующей|в эти|в выходные)',
    ].join('|'),
    'i'
);

/**
 * Определяет, является ли факт временным, и возвращает дату истечения актуальности.
 * Использует быструю эвристику, а для неоднозначных случаев — LLM.
 */
async function detectTemporalExpiry(content: string): Promise<Date | undefined> {
    if (!TEMPORAL_HINT_RE.test(content)) return undefined;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                { role: 'system', content: 'Отвечай только валидным JSON.' },
                {
                    role: 'user',
                    content: `Факт: "${content}"
Является ли этот факт временным (актуален ограниченное время)?
Если да — через сколько дней от сегодня он потеряет актуальность?

Примеры:
- "жду посылку" → {"temporal": true, "days": 14}
- "встреча в пятницу" → {"temporal": true, "days": 7}
- "отпуск в июле" → {"temporal": true, "days": 60}
- "через месяц переезжаю" → {"temporal": true, "days": 30}
- "через полгода защита диплома" → {"temporal": true, "days": 180}
- "экзамен на следующей неделе" → {"temporal": true, "days": 7}
- "запись к врачу в среду" → {"temporal": true, "days": 5}
- "к концу года хочу похудеть" → {"temporal": true, "days": 180}
- "дедлайн через три дня" → {"temporal": true, "days": 3}
- "собираюсь съездить в Питер на выходных" → {"temporal": true, "days": 7}
- "к лету планирую купить машину" → {"temporal": true, "days": 90}
- "вот-вот получу оффер" → {"temporal": true, "days": 14}
- "со дня на день придут результаты анализов" → {"temporal": true, "days": 7}
- "люблю горы" → {"temporal": false}
- "работаю программистом" → {"temporal": false}
- "у меня есть кот" → {"temporal": false}

JSON: {"temporal": true/false, "days": число_или_null}`,
                },
            ],
            temperature: 0,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const data = parseLLMJson<{ temporal?: boolean; days?: number }>(text);
        if (!data?.temporal || !data.days) return undefined;
        const expiry = new Date();
        expiry.setDate(expiry.getDate() + Number(data.days));
        return expiry;
    } catch {
        return undefined;
    }
}

/** Сохраняет факт в векторную БД (Qdrant) с обнаружением противоречий и дедупликацией. */
export async function saveMemory(
    ctx: BotContext,
    domain: string,
    content: string,
    importance: number,
    tags: string[] = [],
    isAnchor = false
): Promise<void> {
    const userId = ctx.from?.id;
    devLog('💾 Сохранение в векторную БД (долговременная память):', {
        userId,
        domain,
        content: content.slice(0, 100) + '...',
        importance,
        isAnchor,
        vectorServiceAvailable: !!vectorService()
    });

    const svc = vectorService();
    if (!svc) {
        const msg = 'Векторный сервис недоступен. Факт не сохранён в долговременную память.';
        console.error('❌', msg);
        lastSaveError = msg;
        if (ctx.session) ctx.session.lastFactSaveError = msg;
        return;
    }

    try {
        // ── Шаг 1: Дедупликация (почти идентичные факты) ─────────────────────
        const nearIdentical = await svc.searchMemories(content, String(userId), {
            domain,
            limit: 1,
            minScore: DEDUP_SIMILARITY_THRESHOLD,
        });
        if (nearIdentical.length > 0) {
            const existing = nearIdentical[0];
            // Каждое подтверждение того же факта повышает достоверность (+0.1, cap 1.0)
            const boostedConfidence = Math.min(1.0, (existing.confidence ?? 0.6) + 0.1);
            const mergedImportance = Math.max(importance, existing.importance);
            // Авто-продвижение в anchors: высокая достоверность + высокая важность = ключевой факт о пользователе
            const shouldAutoAnchor = boostedConfidence >= 0.9 && mergedImportance >= 0.8;
            if (shouldAutoAnchor) devLog('⚓ Авто-продвижение в anchor:', content.slice(0, 60));
            await svc.updateMemory(existing.id, domain, {
                content,
                domain,
                timestamp: new Date(),
                importance: mergedImportance,
                tags: [...new Set([...(tags || []), ...(existing.tags || [])])],
                userId: String(userId),
                botId,
                isAnchor: isAnchor || shouldAutoAnchor || undefined,
                confidence: boostedConfidence,
            });
            devLog('✅ Факт обновлён (дедупликация) ID:', existing.id, '| confidence:', boostedConfidence);
            lastSaveError = null;
            if (ctx.session) delete ctx.session.lastFactSaveError;
            return;
        }

        // ── Шаг 2: Поиск похожих фактов для проверки противоречий ────────────
        const related = await svc.searchMemories(content, String(userId), {
            domain,
            limit: 3,
            minScore: CONTRADICTION_THRESHOLD,
        });

        for (const candidate of related) {
            // Пропускаем то, что уже обработано порогом дедупликации
            if (candidate.score >= DEDUP_SIMILARITY_THRESHOLD) continue;

            const check = await checkContradiction(candidate.content, content);
            devLog(`🔍 Проверка противоречия [${check.verdict}]:`, {
                old: candidate.content.slice(0, 60),
                new: content.slice(0, 60),
            });

            if ((check.verdict === 'contradicts' || check.verdict === 'updates') && check.mergedContent) {
                // В обоих случаях заменяем старый факт объединённой формулировкой:
                // - contradicts: "работал в Сбере, затем уволился" (история сохранена)
                // - updates:     "переехал из Москвы в Питер" (актуальное состояние)
                const mergeTag = check.verdict === 'contradicts' ? 'contradicts-merged' : 'updated';
                // При противоречии достоверность снижается (-0.2), при обновлении остаётся
                const existingConfidence = candidate.confidence ?? 0.6;
                const mergedConfidence = check.verdict === 'contradicts'
                    ? Math.max(0.3, existingConfidence - 0.2)
                    : existingConfidence;

                // Сохраняем старую версию в historya перед перезаписью
                const newVersion = {
                    content: candidate.content,
                    timestamp: candidate.timestamp,
                    confidence: existingConfidence,
                };
                const previousVersions = [
                    newVersion,
                    ...((candidate as any).previousVersions ?? []),
                ].slice(0, 10); // храним не более 10 версий

                await svc.updateMemory(candidate.id, domain, {
                    content: check.mergedContent,
                    domain,
                    timestamp: new Date(),
                    importance: Math.max(importance, candidate.importance),
                    tags: [...new Set([...(tags || []), ...(candidate.tags || []), mergeTag])],
                    userId: String(userId),
                    botId,
                    isAnchor: isAnchor || candidate.tags?.includes('anchor') || undefined,
                    confidence: mergedConfidence,
                    previousVersions,
                });
                devLog(`🔄 Факт объединён [${check.verdict}]:`, check.mergedContent.slice(0, 60));
                lastSaveError = null;
                if (ctx.session) delete ctx.session.lastFactSaveError;
                return;
            }
            // 'complements' — продолжаем, сохраним оба
        }

        // ── Шаг 3: Сохраняем как новый факт ──────────────────────────────────
        const expiresAt = await detectTemporalExpiry(content);
        const now = new Date();
        const result = await svc.saveMemory({
            content,
            domain,
            timestamp: now,
            importance,
            tags,
            userId: String(userId),
            botId,
            isAnchor: isAnchor || undefined,
            expiresAt,
            confidence: 0.6,
            lastAccessedAt: now,
        });
        devLog('✅ Факт успешно сохранён с ID:', result);

        // ── Шаг 4: Строим граф связей (fire & forget) ────────────────────────
        buildMemoryRelationships(result, content, String(userId), domain, svc).catch(() => {});

        lastSaveError = null;
        if (ctx.session) delete ctx.session.lastFactSaveError;
    } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        lastSaveError = msg;
        console.error('❌ Ошибка сохранения факта в векторную БД:', e instanceof Error ? e.stack : e);
        const userMsg =
            msg && /internal server error|500|ECONNREFUSED|ETIMEDOUT|unavailable/i.test(msg)
                ? 'Не удалось сохранить в долговременную память (ошибка сервиса или сети). Попробуй позже.'
                : msg;
        if (ctx.session) ctx.session.lastFactSaveError = userMsg;
    }
}

/**
 * Строит двунаправленные связи между новым фактом и семантически близкими фактами из памяти.
 * Связывает факты с cosine similarity 0.60–0.80 (ниже порога дедупликации, но выше случайного).
 * Вызывается fire-and-forget после сохранения нового факта.
 */
async function buildMemoryRelationships(
    newId: string,
    content: string,
    userId: string,
    domain: string,
    svc: ReturnType<typeof vectorService>
): Promise<void> {
    if (!svc || !newId) return;
    try {
        // Ищем связанные факты в диапазоне [0.60, 0.92) — не дубликаты, но семантически близкие
        const candidates = await svc.searchMemories(content, userId, {
            limit: 6,
            minScore: 0.60,
        });
        for (const candidate of candidates) {
            if (candidate.id === newId) continue;
            if (candidate.score >= DEDUP_SIMILARITY_THRESHOLD) continue; // пропускаем дубликаты
            await svc.addRelationship(newId, domain, candidate.id, candidate.domain);
        }
    } catch (e) {
        devLog('buildMemoryRelationships error (ignored):', e);
    }
}

export async function searchMemories(ctx: BotContext, query: string, options?: SearchOptions, userIdOverride?: string) {
    const svc = vectorService();
    if (!svc) return [];
    try {
        devLog('Searching memories:', query, options);
        const userId = userIdOverride ?? String(ctx.from?.id);
        const res = await svc.searchMemories(query, userId, options);
        devLog('Search result count:', res.length);
        if (res.length === 0) {
            console.warn(`⚠️ Память не найдена по запросу: "${query.slice(0, 120)}"`);
        }
        return res;
    } catch (e) {
        console.error('Vector search error', e);
        return [];
    }
}

export async function searchAllDomainsMemories(ctx: BotContext, query: string, limit = 5) {
    const svc = vectorService();
    if (!svc) return [];
    try {
        devLog('Searching all domains:', { query: query.slice(0, 100), limit });
        const res = await svc.searchAllDomains(query, String(ctx.from?.id), limit);
        devLog('Cross-domain result count:', res.length);
        if (res.length === 0) {
            console.warn(`⚠️ Кросс-доменный поиск не нашел фактов: "${query.slice(0, 120)}"`);
        }
        return res;
    } catch (e) {
        console.error('Cross-domain vector search error', e);
        return [];
    }
}

export async function getDomainContextVector(ctx: BotContext, domain: string, query: string, limit = 5): Promise<string> {
    const svc = vectorService();
    if (!svc) return '';
    try {
        devLog('Fetching domain context vector:', { domain, query: query.slice(0, 100), limit });

        const primaryResults = await svc.searchMemories(query, String(ctx.from?.id), { domain, limit });
        let finalResults = primaryResults;

        if (primaryResults.length < 2) {
            devLog('Primary domain has too few results, using cross-domain fallback:', {
                domain,
                primaryCount: primaryResults.length,
            });

            const crossDomain = await svc.searchAllDomains(query, String(ctx.from?.id), limit);
            const seen = new Set(primaryResults.map(result => result.id));
            finalResults = [...primaryResults];

            for (const result of crossDomain) {
                if (seen.has(result.id)) continue;
                finalResults.push(result);
                seen.add(result.id);
                if (finalResults.length >= limit) break;
            }
        }

        const context = finalResults.map(result => result.content).join('\n');
        devLog('Domain context vector length:', context.length);
        return context;
    } catch (e) {
        console.error('Vector domain context error', e);
        return '';
    }
}

export async function cleanupOldMemories(ctx: BotContext, days?: number) {
    const svc = vectorService();
    if (!svc) return 0;
    try {
        devLog('Cleaning up old memories older than days:', days);
        const res = await svc.cleanupOldMemories(String(ctx.from?.id), days);
        devLog('Cleanup removed count:', res);
        return res;
    } catch (e) {
        console.error('Vector cleanup error', e);
        return 0;
    }
}

export async function getMemoryStats(ctx: BotContext) {
    const svc = vectorService();
    if (!svc) return { total: 0, domains: {} };
    try {
        devLog('Fetching memory stats');
        const res = await svc.getMemoryStats(String(ctx.from?.id));
        devLog('Memory stats:', res);
        return res;
    } catch (e) {
        console.error('Vector stats error', e);
        return { total: 0, domains: {} };
    }
}

export function calcImportance(role: string, content: string): number {
    let base = role === 'user' ? 0.7 : 0.5;
    if (/напоминание|событие/i.test(content)) base = 0.8;
    if (/[!\?]/.test(content)) base += 0.2;
    return Math.min(1, base);
}

export function extractTags(content: string): string[] {
    const tags: string[] = [];
    if (/тревог|паник|страх/i.test(content)) tags.push('тревога');
    if (/радост/i.test(content)) tags.push('радость');
    if (/грусть|печаль/i.test(content)) tags.push('грусть');
    if (/работ|офис/i.test(content)) tags.push('работа');
    if (/семь|родител/i.test(content)) tags.push('семья');
    if (/срочн|завтра/i.test(content)) tags.push('срочно');
    return Array.from(new Set(tags));
}


export async function getRecentMemories(ctx: BotContext, limit = 5): Promise<MemoryEntry[]> {
    const svc = vectorService();
    if (!svc) return [];
    try {
        devLog('Fetching recent memories:', { limit });
        const res = await svc.getRecentMemories(String(ctx.from?.id), limit);
        devLog('Recent memories fetched:', res.length);
        return res;
    } catch (e) {
        console.error('Recent memories fetch error', e);
        return [];
    }
}

export async function getAnchorMemories(ctx: BotContext, limit = 3) {
    const svc = vectorService();
    if (!svc) return [];
    try {
        const res = await svc.getAnchorMemories(String(ctx.from?.id), limit);
        devLog('Anchor memories fetched:', res.length);
        return res;
    } catch (e) {
        console.error('Anchor memories fetch error', e);
        return [];
    }
}

const DOMAIN_LABELS: Record<string, string> = {
    work: '💼 Работа',
    health: '🏥 Здоровье',
    family: '👨‍👩‍👧 Семья',
    finance: '💰 Финансы',
    education: '📚 Образование',
    hobbies: '🎨 Хобби',
    travel: '✈️ Путешествия',
    social: '👥 Общение',
    home: '🏠 Дом',
    personal: '🙋 Личное',
    entertainment: '🎬 Развлечения',
    general: '📝 Общее',
};

/**
 * Генерирует читаемое резюме всего, что бот знает о пользователе.
 * Разбивает по доменам, факты о контактах выносит отдельно.
 */
export async function generateMemoryBiography(ctx: BotContext): Promise<string> {
    const all = await getRecentMemories(ctx, 500);
    if (all.length === 0) return 'В памяти пока нет сохранённых фактов о тебе.';

    const userFacts = all.filter(f => !f.tags?.some(t => String(t).startsWith('contact:')));
    const contactFacts = all.filter(f => f.tags?.some(t => String(t).startsWith('contact:')));

    const byDomain: Record<string, MemoryEntry[]> = {};
    for (const fact of userFacts) {
        const d = fact.domain || 'general';
        if (!byDomain[d]) byDomain[d] = [];
        byDomain[d].push(fact);
    }

    const lines: string[] = ['Вот что я о тебе знаю:\n'];

    for (const [domain, facts] of Object.entries(byDomain)) {
        if (facts.length === 0) continue;
        lines.push(DOMAIN_LABELS[domain] || domain);
        for (const f of facts.slice(0, 10)) {
            lines.push(`• ${f.content}`);
        }
        lines.push('');
    }

    if (contactFacts.length > 0) {
        lines.push('👥 О твоих контактах');
        for (const f of contactFacts.slice(0, 20)) {
            lines.push(`• ${f.content}`);
        }
        lines.push('');
    }

    lines.push(`📊 Всего фактов в памяти: ${all.length}`);
    return lines.join('\n');
}

/**
 * Ищет факт по запросу и удаляет лучшее совпадение (если score >= 0.65).
 * Возвращает удалённый контент или undefined если ничего не найдено.
 */
export async function deleteMemoryByContent(
    ctx: BotContext,
    query: string
): Promise<string | undefined> {
    const svc = vectorService();
    if (!svc) return undefined;
    const userId = String(ctx.from?.id);

    const results = await svc.searchAllDomains(query, userId, 1);
    if (results.length === 0 || results[0].score < 0.65) return undefined;

    const best = results[0];
    await svc.deleteMemory(best.id, best.domain);
    devLog('🗑️ Факт удалён по запросу пользователя:', best.content.slice(0, 80));
    return best.content;
}

/**
 * Анализирует накопленные факты и возвращает 3-5 инсайтов о паттернах и трендах.
 * Полезно для самоотражения: "ты часто упоминаешь стресс", "много фактов о путешествиях".
 */
export async function generateMemoryInsights(ctx: BotContext): Promise<string> {
    const memories = await getRecentMemories(ctx, 200);
    if (memories.length < 5) {
        return 'Накопи больше воспоминаний — мне нужно хотя бы 5 фактов для анализа паттернов.';
    }

    const sample = memories
        .slice(0, 120)
        .map(m => `[${m.domain}] ${m.content}`)
        .join('\n');

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты анализируешь факты о человеке и находишь паттерны, тренды и интересные наблюдения. Отвечай по-русски, кратко и конкретно.',
                },
                {
                    role: 'user',
                    content: `Вот факты о человеке из его долговременной памяти (${memories.length} всего, показаны ${Math.min(120, memories.length)}):

${sample}

Найди 3-5 интересных паттерна, тренда или наблюдения. Примеры того, что стоит искать:
- Повторяющиеся темы или эмоции
- Противоречия или изменения во времени
- Области где накопилось много фактов
- Необычные или примечательные детали
- Возможные связи между разными сферами жизни

Каждое наблюдение — 1-2 предложения. Будь конкретным, используй данные из фактов.`,
                },
            ],
            temperature: 1,
        });

        const text = resp.choices[0]?.message?.content?.trim();
        if (!text) return 'Не удалось сгенерировать инсайты. Попробуй позже.';

        return `🔍 Инсайты из твоей памяти (${memories.length} фактов):\n\n${text}`;
    } catch (e) {
        console.error('generateMemoryInsights error:', e);
        return 'Не удалось проанализировать память. Попробуй позже.';
    }
}

/**
 * Ищет факт по запросу без удаления.
 * Возвращает лучшее совпадение или undefined.
 */
export async function findMemoryByContent(
    ctx: BotContext,
    query: string
): Promise<{ id: string; content: string; domain: string; score: number; previousVersions?: MemoryEntry['previousVersions'] } | undefined> {
    const svc = vectorService();
    if (!svc) return undefined;
    const userId = String(ctx.from?.id);

    const results = await svc.searchAllDomains(query, userId, 1);
    if (results.length === 0 || results[0].score < 0.55) return undefined;

    const best = results[0];
    return {
        id: best.id,
        content: best.content,
        domain: best.domain,
        score: best.score,
        previousVersions: (best as any).previousVersions,
    };
}

/**
 * Удаляет факт по ID и домену.
 */
export async function deleteMemoryById(
    ctx: BotContext,
    memoryId: string,
    domain: string
): Promise<void> {
    const svc = vectorService();
    if (!svc) return;
    await svc.deleteMemory(memoryId, domain);
    devLog('🗑️ Факт удалён по ID:', memoryId);
}

/**
 * Эпизодическая компрессия: сжимает старые факты домена в 3-5 «эпизодных» воспоминаний.
 *
 * Алгоритм:
 * 1. Загружает факты старше olderThanDays (якоря пропускаются — они уже эпизодные)
 * 2. Если < 5 фактов — нечего сжимать
 * 3. LLM синтезирует 3-5 обобщённых утверждений с высокой важностью
 * 4. Сохраняет синтез как anchor-факты с тегом episodic-compression
 * 5. Удаляет исходные факты
 *
 * Возвращает { compressed, deleted }
 */
export async function compressOldMemories(
    ctx: BotContext,
    domain: string,
    olderThanDays = 60
): Promise<{ compressed: number; deleted: number }> {
    const svc = vectorService();
    if (!svc) return { compressed: 0, deleted: 0 };

    const userId = String(ctx.from?.id);
    const old = await svc.getMemoriesForCompression(userId, domain, olderThanDays);

    if (old.length < 5) {
        devLog(`compressOldMemories [${domain}]: only ${old.length} facts, skipping`);
        return { compressed: 0, deleted: 0 };
    }

    const factsText = old.map((m, i) =>
        `${i + 1}. [importance=${m.importance.toFixed(2)}, conf=${(m.confidence ?? 0.6).toFixed(2)}] ${m.content}`
    ).join('\n');

    let summaries: string[] = [];
    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты синтезируешь группу фактов о человеке в компактные обобщения. Отвечай только валидным JSON.',
                },
                {
                    role: 'user',
                    content: `Домен: ${domain}
Факты (${old.length} штук, старше ${olderThanDays} дней):

${factsText}

Сожми в 3-5 обобщённых утверждений. Каждое должно:
- Охватывать несколько исходных фактов
- Быть конкретным (не "интересуется работой", а "работает в IT, предпочитает бэкенд")
- Сохранять наиболее значимую информацию

JSON: {"summaries": ["утверждение 1", "утверждение 2", ...]}`,
                },
            ],
            temperature: 1,
        });

        const data = parseLLMJson<{ summaries?: string[] }>(
            resp.choices[0]?.message?.content?.trim() || ''
        );
        if (data?.summaries && Array.isArray(data.summaries)) {
            summaries = data.summaries.filter(s => typeof s === 'string' && s.trim()).slice(0, 5);
        }
    } catch (e) {
        console.error('compressOldMemories LLM error:', e);
        return { compressed: 0, deleted: 0 };
    }

    if (summaries.length === 0) return { compressed: 0, deleted: 0 };

    // Сохраняем синтез как anchor-факты
    const now = new Date();
    for (const summary of summaries) {
        await svc.saveMemory({
            content: summary,
            domain,
            timestamp: now,
            importance: 0.85,
            tags: ['episodic-compression'],
            userId,
            botId,
            isAnchor: true,
            confidence: 0.8,
            lastAccessedAt: now,
        });
    }

    // Удаляем исходные факты
    await Promise.allSettled(old.map(m => svc.deleteMemory(m.id, domain)));

    devLog(`compressOldMemories [${domain}]: ${old.length} facts → ${summaries.length} episodes`);
    return { compressed: summaries.length, deleted: old.length };
}

/**
 * Отчёт о здоровье памяти: низкая достоверность, давний доступ, распределение по доменам.
 */
export async function getMemoryHealthReport(ctx: BotContext): Promise<string> {
    const svc = vectorService();
    if (!svc) return '❌ Векторный сервис недоступен.';

    const all = await getRecentMemories(ctx, 1000);
    if (all.length === 0) return 'Память пуста.';

    const now = Date.now();
    const day = 24 * 60 * 60 * 1000;

    let lowConfidence = 0;
    let stale = 0;             // не вспоминался > 60 дней
    let expiringSoon = 0;      // expiresAt в ближайшие 7 дней
    const domainCounts: Record<string, number> = {};

    for (const m of all) {
        const conf = m.confidence ?? 0.6;
        if (conf < 0.4) lowConfidence++;

        const accessed = m.lastAccessedAt ?? m.timestamp;
        const daysSinceAccess = (now - new Date(accessed).getTime()) / day;
        if (daysSinceAccess > 60) stale++;

        domainCounts[m.domain] = (domainCounts[m.domain] ?? 0) + 1;
    }

    const lines: string[] = [
        `🏥 Состояние долговременной памяти\n`,
        `📊 Всего фактов: ${all.length}`,
        `⚠️  Низкая достоверность (< 0.4): ${lowConfidence}`,
        `🕸️  Давно не всплывали (> 60 дней): ${stale}`,
        `⏳ Скоро истекут (< 7 дней): ${expiringSoon}`,
        ``,
        `📂 По доменам:`,
    ];

    const sorted = Object.entries(domainCounts).sort((a, b) => b[1] - a[1]);
    for (const [domain, count] of sorted) {
        lines.push(`  ${domain}: ${count}`);
    }

    if (lowConfidence > 0) {
        lines.push(`\n💡 Совет: запусти /memory_cleanup чтобы очистить устаревшие факты,`);
        lines.push(`  или /memory_compress <домен> чтобы сжать старые воспоминания.`);
    }

    return lines.join('\n');
}
