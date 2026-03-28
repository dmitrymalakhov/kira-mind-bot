import { BotContext } from '../types';
import { searchAllDomainsMemories } from './enhancedDomainMemory';
import { devLog } from '../utils';
import openai from '../openai';

const MAX_QUERIES = 5;

/** Нейросеть определяет, упоминается ли в сообщении человек по роли (жена, муж, мама и т.д.). Возвращает роль в именительном падеже или null. */
export async function detectRelationshipInMessage(message: string): Promise<string | null> {
    const trimmed = message.trim();
    if (trimmed.length < 2) return null;
    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content:
                        'В сообщении пользователя может упоминаться человек по роли (жена, муж, мама, папа, коллега, друг и т.п.). Если такая роль есть — ответь одним словом в именительном падеже (жена, муж, мама, папа). Если нет — ответь: NONE.',
                },
                { role: 'user', content: trimmed },
            ],
            temperature: 1, // модель поддерживает только default (1)
        });
        const text = (resp.choices[0]?.message?.content?.trim() || '').trim();
        if (!text || text.toUpperCase() === 'NONE') return null;
        const role = text.split(/\s+/)[0].toLowerCase();
        if (role.length < 2 || role.length > 20) return null;
        devLog('detectRelationshipInMessage:', role);
        return role;
    } catch (e) {
        console.error('detectRelationshipInMessage error:', e);
        return null;
    }
}
const RESULTS_PER_QUERY = 4;

/**
 * Просит нейросеть сгенерировать поисковые фразы для долговременной памяти,
 * чтобы найти, кто имеется в виду под указанной ролью (жена, муж, коллега и т.д.).
 */
async function generateMemorySearchQueries(
    relationship: string,
    userMessageContext: string
): Promise<string[]> {
    const prompt = `Пользователь написал: "${userMessageContext}"

Нужно найти в долговременной памяти, кто такой человек: "${relationship}" (имя или как он/она подписана в контактах).

Сгенерируй от 3 до ${MAX_QUERIES} коротких поисковых фраз на русском для поиска по базе фактов о пользователе. Фразы должны помочь найти имя или упоминание этого человека (семья, родственники, близкие).
Только фразы, по одной на строку, без нумерации и пояснений.`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты генерируешь только короткие поисковые фразы для поиска в базе фактов, по одной на строку, без пояснений.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1,
        });
        const text = resp.choices[0]?.message?.content?.trim() || '';
        const queries = text
            .split(/\n+/)
            .map((q) => q.replace(/^[\d.)\-\s]+/, '').trim())
            .filter((q) => q.length > 1 && q.length < 100)
            .slice(0, MAX_QUERIES);
        devLog('resolveRelationship: generated queries', queries);
        return queries.length ? queries : [relationship, 'семья', 'близкие'];
    } catch (e) {
        console.error('resolveRelationship: generate queries error', e);
        return [relationship, 'семья'];
    }
}

/**
 * Просит нейросеть извлечь из найденных фактов имя человека (как в контактах).
 */
async function extractNameFromFacts(
    relationship: string,
    factsText: string
): Promise<string | null> {
    if (!factsText.trim()) return null;

    const prompt = `По контексту пользователя имеется в виду человек: "${relationship}".

Факты из долговременной памяти:
${factsText.slice(0, 3000)}

Определи имя этого человека так, как оно скорее всего записано в контактах (обычно имя или имя и фамилия). Ответь ОДНИМ словом или двумя словами — только имя, без кавычек и пояснений. Если по фактам нельзя однозначно понять, кто это, ответь: NOT_FOUND`;

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты извлекаешь имя человека из фактов. Отвечай только именем или NOT_FOUND.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1,
        });
        const name = resp.choices[0]?.message?.content?.trim() || '';
        if (!name || name.toUpperCase() === 'NOT_FOUND') return null;
        const cleaned = name.replace(/^["']|["']$/g, '').trim();
        if (cleaned.length < 2 || cleaned.length > 50) return null;
        devLog('resolveRelationship: extracted name', cleaned);
        return cleaned;
    } catch (e) {
        console.error('resolveRelationship: extract name error', e);
        return null;
    }
}

/**
 * Определяет имя человека по роли из долговременной памяти.
 * Нейросеть сама решает, что искать в памяти и как извлечь имя из найденных фактов.
 */
export async function resolveRelationshipFromMemory(
    ctx: BotContext,
    relationship: string,
    userMessageContext?: string
): Promise<string | null> {
    const rel = relationship.trim();
    if (!rel) return null;

    const context = userMessageContext || `переписку с ${rel}`;
    const queries = await generateMemorySearchQueries(rel, context);

    const seen = new Set<string>();
    const facts: string[] = [];
    for (const q of queries) {
        const results = await searchAllDomainsMemories(ctx, q, RESULTS_PER_QUERY);
        for (const r of results) {
            const content = r.content?.trim();
            if (content && !seen.has(content)) {
                seen.add(content);
                facts.push(content);
            }
        }
    }

    if (facts.length === 0) {
        devLog('resolveRelationshipFromMemory: no facts for', rel);
        return null;
    }

    const factsText = facts.join('\n');
    const name = await extractNameFromFacts(rel, factsText);
    if (name) devLog('resolveRelationshipFromMemory: resolved', rel, '->', name);
    return name;
}
