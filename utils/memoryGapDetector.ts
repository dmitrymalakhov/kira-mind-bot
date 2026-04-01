import { BotContext } from '../types';
import { searchAllDomainsMemories } from './enhancedDomainMemory';
import openai from '../openai';
import { devLog } from '../utils';
import { addToHistory } from './history';

/** Минимальный интервал между вопросами о пробелах в памяти (10 минут) */
const GAP_COOLDOWN_MS = 10 * 60 * 1000;

/**
 * Если найден результат с таким score ИЛИ выше — считаем, что человек известен.
 * Намеренно ниже стандартного порога поиска: даже слабое совпадение означает
 * что что-то о человеке уже есть в памяти.
 */
const KNOWN_SCORE_THRESHOLD = 0.5;

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
    } catch (e) {
        devLog('maybeAskMemoryGap error (ignored):', e);
    }
}

/**
 * Извлекает имена людей из ЛИЧНОГО ОКРУЖЕНИЯ пользователя.
 * Намеренно фильтрует знаменитостей, персонажей, исторических лиц.
 */
async function extractPersonNames(message: string): Promise<string[]> {
    const resp = await openai.chat.completions.create({
        model: 'gpt-5-nano',
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
        temperature: 1,
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
    const results = await searchAllDomainsMemories(ctx, name, 5);
    const nameLower = name.toLowerCase();
    return results.some(
        (r) => r.score >= KNOWN_SCORE_THRESHOLD && r.content.toLowerCase().includes(nameLower)
    );
}

function pickQuestion(name: string): string {
    const idx = Math.floor(Math.random() * GAP_QUESTION_TEMPLATES.length);
    return GAP_QUESTION_TEMPLATES[idx](name);
}
