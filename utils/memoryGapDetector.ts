import { BotContext } from '../types';
import { searchAllDomainsMemories } from './enhancedDomainMemory';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { devLog } from '../utils';
import { addToHistory } from './history';
import { getVectorService } from '../services/VectorServiceFactory';
import { IDomainVectorService } from '../services/interfaces/IDomainVectorService';
import { SearchResult } from '../services/interfaces/IVectorService';
import {
    contactNamesLikelyMatch,
    contactIdentityTags,
    contactUsernameFromTags,
    isContactMemoryEntry,
    normalizeContactLookupValue,
    resolveContactIdentity,
    storedContactPrefix,
} from './contactMemory';

/** Минимальный интервал между вопросами о пробелах в памяти (10 минут) */
const GAP_COOLDOWN_MS = 10 * 60 * 1000;

/** Максимальное время на обнаружение пробела (LLM + vector search) */
const GAP_COMPUTE_TIMEOUT_MS = 3000;

function withTimeout<T>(fn: () => Promise<T>, ms: number): Promise<T> {
    return Promise.race([
        fn(),
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error('timeout')), ms)),
    ]);
}

/**
 * Если найден результат с таким score ИЛИ выше — считаем, что человек известен.
 * 0.65 — безопаснее чем 0.5: исключает случайные совпадения по распространённым именам.
 */
const KNOWN_SCORE_THRESHOLD = 0.65;
const FALLBACK_CONTACT_SEARCH_LIMIT = 12;

interface MemoryGapKnowledgeDeps {
    searchAllDomainsMemories: (ctx: BotContext, query: string, limit?: number) => Promise<SearchResult[]>;
    vectorService: IDomainVectorService | null;
}

const GAP_QUESTION_TEMPLATES = [
    (name: string) => `Кстати, ты упомянул ${name} — кто это для тебя?`,
    (name: string) => `Расскажи, а кто такой ${name}?`,
    (name: string) => `${name} — это кто? Хочу лучше понимать контекст.`,
    (name: string) => `Ты упомянул ${name} — мне о нём ничего не известно, расскажешь?`,
];

/**
 * После основного ответа бота проверяет: не упомянул ли пользователь человека,
 * о котором в памяти нет никаких данных? Если да — задаёт уточняющий вопрос.
 *
 * Ответ пользователя автоматически подберут quickFactCheck и delayed fact extraction,
 * так что сохранение в долгосрочную память происходит без дополнительной логики.
 *
 * Вызывается fire-and-forget после основного ответа.
 */
export async function maybeAskMemoryGap(
    ctx: BotContext,
    userMessage: string
): Promise<void> {
    if (ctx.chat?.type !== 'private') return;

    // Cooldown: не спрашиваем чаще раза в 10 минут
    const lastGapAt = ctx.session.lastMemoryGapAt ?? 0;
    if (Date.now() - lastGapAt < GAP_COOLDOWN_MS) return;

    // Быстрый пре-фильтр: нет заглавных букв → точно нет имён собственных
    const trimmed = userMessage.trim();
    if (trimmed.length < 5 || trimmed.startsWith('/')) return;
    if (!/[А-ЯЁA-Z]/.test(trimmed)) return;

    try {
        await withTimeout(async () => {
        const names = await extractPersonNames(trimmed);
        if (names.length === 0) return;

        for (const name of names) {
            const isKnown = await checkIfPersonKnown(ctx, name);
            if (!isKnown) {
                const question = pickQuestion(name);

                ctx.session.lastMemoryGapAt = Date.now();

                // Небольшая пауза — бот как будто "задумался"
                await new Promise((res) => setTimeout(res, 2000));
                await ctx.reply(question);
                await addToHistory(ctx, 'bot', question);
                devLog('Memory gap question sent:', question);

                // Только один вопрос за раз — не перегружаем пользователя
                return;
            }
        }
        }, GAP_COMPUTE_TIMEOUT_MS);
    } catch (e: any) {
        if (e?.message === 'timeout') {
            devLog('maybeAskMemoryGap: timed out, skipping');
        } else {
            devLog('maybeAskMemoryGap error (ignored):', e);
        }
    }
}

/**
 * Извлекает имена людей из ЛИЧНОГО ОКРУЖЕНИЯ пользователя.
 * Намеренно фильтрует знаменитостей, персонажей, исторических лиц.
 */
async function extractPersonNames(message: string): Promise<string[]> {
    const resp = await createChatCompletionForTask('memoryExtraction', {
        messages: [
            {
                role: 'system',
                content:
                    'Извлеки имена людей из ЛИЧНОГО ОКРУЖЕНИЯ пользователя: коллеги, друзья, родственники, знакомые. ' +
                    'НЕ включай: знаменитостей, исторических личностей, персонажей фильмов и книг, названия мест и компаний. ' +
                    'Только имена, по одному на строку. Если таких имён нет — ответь NONE.',
            },
            { role: 'user', content: `Сообщение: "${message.slice(0, 300)}"` },
        ],
        temperature: 0,
    });

    const text = resp.choices[0]?.message?.content?.trim() || '';
    if (!text || text.toUpperCase() === 'NONE') return [];

    return text
        .split(/\n+/)
        .map((n) => n.trim())
        .filter((n) => n.length > 1 && n.toUpperCase() !== 'NONE')
        .slice(0, 3); // не более 3 имён за раз
}

/**
 * Ищет факты о человеке в памяти.
 * Считает человека «известным» если есть результат с score ≥ KNOWN_SCORE_THRESHOLD
 * И найденный контент содержит это имя (защита от ложных срабатываний).
 */
async function checkIfPersonKnown(ctx: BotContext, name: string): Promise<boolean> {
    return isPersonKnownForMemoryGap(ctx, name, {
        searchAllDomainsMemories,
        vectorService: getVectorService(),
    });
}

export async function isPersonKnownForMemoryGap(
    ctx: BotContext,
    name: string,
    deps: MemoryGapKnowledgeDeps = {
        searchAllDomainsMemories,
        vectorService: getVectorService(),
    }
): Promise<boolean> {
    const svc = deps.vectorService;
    const userId = String(ctx.from?.id);
    const normalizedName = normalizeContactLookupValue(name);
    const resolution = resolveContactIdentity(name);

    if (svc && resolution.status === 'resolved') {
        const tags = contactIdentityTags(name, resolution.contact);
        for (const tag of [...new Set(tags)]) {
            const matches = await svc.getMemoriesByTag(userId, tag).catch(() => []);
            if (matches.some((match) => isContactMemoryEntry(match) || (match.score ?? 0) >= KNOWN_SCORE_THRESHOLD)) {
                return true;
            }
        }
    }

    const results = await deps.searchAllDomainsMemories(ctx, name, 5);
    if (results.some((r) => r.score >= KNOWN_SCORE_THRESHOLD && memoryMatchesKnownName(r, normalizedName))) {
        return true;
    }

    if (!svc) return false;

    const fallbackQueries = new Set<string>([name]);
    if (resolution.status === 'resolved') {
        fallbackQueries.add(resolution.displayName);
        if (resolution.contact?.firstName) fallbackQueries.add(resolution.contact.firstName);
        if (resolution.contact?.lastName) fallbackQueries.add(resolution.contact.lastName);
        if (resolution.contact?.username) fallbackQueries.add(`@${String(resolution.contact.username).replace(/^@/, '')}`);
    }

    for (const query of fallbackQueries) {
        const matches = await svc.searchAllDomains(query, userId, FALLBACK_CONTACT_SEARCH_LIMIT).catch(() => []);
        if (matches.some((match) =>
            isContactMemoryEntry(match) &&
            memoryMatchesKnownName(match, normalizedName)
        )) {
            return true;
        }
    }

    return false;
}

function memoryMatchesKnownName(
    memory: { content: string; tags?: string[] | undefined },
    normalizedName: string
): boolean {
    const memoryVariants = new Set<string>();
    if (!normalizedName) return false;
    const normalizedNameTokens = normalizedName.split(/\s+/).filter(Boolean);
    const isSingleTokenQuery = normalizedNameTokens.length <= 1;

    const prefix = storedContactPrefix(memory.content);
    if (prefix) memoryVariants.add(normalizeContactLookupValue(prefix));

    for (const tag of memory.tags ?? []) {
        const value = String(tag);
        if (
            value.startsWith('contact:') ||
            value.startsWith('contact_name:') ||
            value.startsWith('contact_alias:') ||
            value.startsWith('contact_username:') ||
            value.startsWith('contact_key:')
        ) {
            memoryVariants.add(
                normalizeContactLookupValue(
                    value
                        .replace(/^contact(_name|_alias|_key)?:/, '')
                        .replace(/^contact_username:/, '')
                        .replace(/_/g, ' ')
                )
            );
        }
    }

    const memoryUsername = contactUsernameFromTags(memory.tags);
    if (memoryUsername && memoryUsername === normalizedName) return true;

    const memoryText = normalizeContactLookupValue(memory.content);
    if (!isSingleTokenQuery && memoryText.includes(normalizedName)) return true;

    for (const variant of memoryVariants) {
        if (!variant) continue;
        const variantTokens = variant.split(/\s+/).filter(Boolean);
        if (variant === normalizedName) return true;
        if (!isSingleTokenQuery && (variant.includes(normalizedName) || normalizedName.includes(variant))) {
            return true;
        }
        if (isSingleTokenQuery && variantTokens.length !== normalizedNameTokens.length) {
            continue;
        }
        if (contactNamesLikelyMatch(variant, normalizedName)) return true;
    }

    return false;
}

function pickQuestion(name: string): string {
    const idx = Math.floor(Math.random() * GAP_QUESTION_TEMPLATES.length);
    return GAP_QUESTION_TEMPLATES[idx](name);
}
