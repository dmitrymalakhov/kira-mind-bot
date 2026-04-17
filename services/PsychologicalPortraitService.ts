import { v4 as uuidv4 } from 'uuid';
import { BotContext } from '../types';
import { getVectorService } from './VectorServiceFactory';
import { devLog } from '../utils';
import openai from '../openai';

const PORTRAIT_DOMAIN = 'contacts';
const PORTRAIT_IMPORTANCE = 0.92;
const PORTRAIT_CONFIDENCE = 0.85;

/** Тег для идентификации записи как психологического портрета конкретного контакта */
export function portraitTag(contactName: string): string {
    return `portrait:${contactName}`;
}

export interface ContactPortrait {
    contactName: string;
    communicationStyle: string;
    personalityTraits: string;
    coreValues: string;
    interests: string;
    emotionalProfile: string;
    relationshipWithUser: string;
    keyObservations: string;
    summary: string;
    conversationsAnalyzed: number;
    lastUpdated: Date;
}

/**
 * Сериализует портрет в читаемый текст для хранения в векторной БД.
 */
function serializePortrait(p: ContactPortrait): string {
    const date = p.lastUpdated.toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    return [
        `[ПСИХОЛОГИЧЕСКИЙ ПОРТРЕТ: ${p.contactName}]`,
        ``,
        `Стиль общения: ${p.communicationStyle}`,
        `Черты личности: ${p.personalityTraits}`,
        `Ценности и приоритеты: ${p.coreValues}`,
        `Интересы и темы: ${p.interests}`,
        `Эмоциональный профиль: ${p.emotionalProfile}`,
        `Динамика общения с владельцем: ${p.relationshipWithUser}`,
        `Ключевые наблюдения: ${p.keyObservations}`,
        ``,
        `Краткое резюме: ${p.summary}`,
        ``,
        `Проанализировано переписок: ${p.conversationsAnalyzed}`,
        `Последнее обновление: ${date}`,
    ].join('\n');
}

const BUILD_PORTRAIT_PROMPT = (contactName: string, conversationText: string) => `
Ты анализируешь переписку между пользователем и человеком по имени ${contactName}.
Твоя задача — составить психологический портрет ${contactName} на основе его сообщений и поведения в переписке.

ПЕРЕПИСКА:
${conversationText.slice(0, 8000)}

Составь портрет по следующим аспектам. Будь конкретным — опирайся только на то, что реально видно в переписке. Не придумывай.

Верни ТОЛЬКО JSON (без пояснений):
{
  "communicationStyle": "Как пишет: формально/неформально, кратко/развёрнуто, тон, манера. 1-2 предложения.",
  "personalityTraits": "Черты характера, заметные по переписке. 1-2 предложения.",
  "coreValues": "Что для него важно, что ценит — видно из тем и реакций. 1-2 предложения.",
  "interests": "Темы, которые его интересуют, о чём говорит. 1-2 предложения.",
  "emotionalProfile": "Как выражает эмоции, насколько открыт, реакция на стресс/конфликт. 1-2 предложения.",
  "relationshipWithUser": "Характер отношений с пользователем: деловые/дружеские/семейные, кто инициирует, тональность. 1-2 предложения.",
  "keyObservations": "Нестандартные паттерны, особенности поведения, запоминающиеся моменты. 1-2 предложения.",
  "summary": "Ёмкое описание человека в 2-3 предложениях."
}
`;

const MERGE_PORTRAIT_PROMPT = (contactName: string, oldPortrait: string, newConversation: string) => `
Обнови психологический портрет ${contactName} с учётом новой информации из свежей переписки.

СУЩЕСТВУЮЩИЙ ПОРТРЕТ:
${oldPortrait}

НОВАЯ ПЕРЕПИСКА (для обновления портрета):
${newConversation.slice(0, 6000)}

Изучи новую переписку и обнови портрет: уточни или дополни каждый раздел, если новые данные это позволяют.
Не удаляй валидные наблюдения из старого портрета — только дополняй и уточняй.

Верни ТОЛЬКО JSON (без пояснений):
{
  "communicationStyle": "...",
  "personalityTraits": "...",
  "coreValues": "...",
  "interests": "...",
  "emotionalProfile": "...",
  "relationshipWithUser": "...",
  "keyObservations": "...",
  "summary": "..."
}
`;

/**
 * Извлекает психологический портрет из переписки через LLM.
 */
async function buildPortraitFromText(
    contactName: string,
    conversationText: string,
    oldPortraitText?: string,
    oldConversationsCount = 0,
): Promise<ContactPortrait | null> {
    const prompt = oldPortraitText
        ? MERGE_PORTRAIT_PROMPT(contactName, oldPortraitText, conversationText)
        : BUILD_PORTRAIT_PROMPT(contactName, conversationText);

    try {
        const resp = await openai.chat.completions.create({
            model: 'gpt-5.4',
            messages: [
                {
                    role: 'system',
                    content: 'Ты психолог-аналитик. Составляй точные, конкретные портреты только на основе фактов из переписки. Отвечай строго JSON.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 0.3,
        });

        const raw = resp.choices[0]?.message?.content?.trim() || '';
        const jsonMatch = raw.match(/\{[\s\S]*\}/);
        if (!jsonMatch) {
            devLog('PsychologicalPortraitService: no JSON in response');
            return null;
        }

        const data = JSON.parse(jsonMatch[0]);

        return {
            contactName,
            communicationStyle: data.communicationStyle || '',
            personalityTraits: data.personalityTraits || '',
            coreValues: data.coreValues || '',
            interests: data.interests || '',
            emotionalProfile: data.emotionalProfile || '',
            relationshipWithUser: data.relationshipWithUser || '',
            keyObservations: data.keyObservations || '',
            summary: data.summary || '',
            conversationsAnalyzed: oldConversationsCount + 1,
            lastUpdated: new Date(),
        };
    } catch (e) {
        console.error('PsychologicalPortraitService: build error', e);
        return null;
    }
}

/**
 * Сохраняет или обновляет психологический портрет контакта в долговременной памяти.
 *
 * Алгоритм:
 * 1. Ищем существующий портрет по тегу `portrait:<Name>`
 * 2. Если есть — передаём в LLM вместе с новой перепиской для обновления, затем удаляем старую запись
 * 3. Сохраняем новую запись как anchor в домене `contacts`
 */
export async function saveOrUpdatePortrait(
    ctx: BotContext,
    contactName: string,
    conversationText: string,
): Promise<boolean> {
    const svc = getVectorService();
    if (!svc) return false;

    const userId = String(ctx.from?.id);
    if (!userId) return false;

    const tag = portraitTag(contactName);

    // Ищем существующий портрет
    let oldPortraitText: string | undefined;
    let oldId: string | undefined;
    let oldConversationsCount = 0;

    try {
        const existing = await svc.getMemoriesByTag(userId, tag);
        if (existing.length > 0) {
            const best = existing[0];
            oldPortraitText = best.content;
            oldId = best.id;
            // Извлекаем счётчик переписок из текста
            const countMatch = oldPortraitText.match(/Проанализировано переписок: (\d+)/);
            if (countMatch) oldConversationsCount = parseInt(countMatch[1], 10);
        }
    } catch (e) {
        devLog('PsychologicalPortraitService: error fetching existing portrait', e);
    }

    const portrait = await buildPortraitFromText(
        contactName,
        conversationText,
        oldPortraitText,
        oldConversationsCount,
    );
    if (!portrait) return false;

    const content = serializePortrait(portrait);
    const botId = process.env.BOT_ID || 'kira-mind-bot';

    // Удаляем старую запись
    if (oldId) {
        try {
            await svc.deleteMemory(oldId, PORTRAIT_DOMAIN);
            devLog(`PsychologicalPortraitService: deleted old portrait id=${oldId}`);
        } catch (e) {
            devLog('PsychologicalPortraitService: error deleting old portrait', e);
        }
    }

    // Сохраняем новую
    try {
        await svc.saveMemory({
            content,
            domain: PORTRAIT_DOMAIN,
            botId,
            timestamp: new Date(),
            importance: PORTRAIT_IMPORTANCE,
            tags: [tag, `contact:${contactName}`],
            userId,
            isAnchor: true,
            confidence: PORTRAIT_CONFIDENCE,
        });
        devLog(`PsychologicalPortraitService: saved portrait for "${contactName}"`);
        return true;
    } catch (e) {
        console.error('PsychologicalPortraitService: save error', e);
        return false;
    }
}

/**
 * Возвращает текст психологического портрета контакта (или null если не найден).
 */
export async function getContactPortrait(
    ctx: BotContext,
    contactName: string,
): Promise<string | null> {
    const svc = getVectorService();
    if (!svc) return null;

    const userId = String(ctx.from?.id);
    if (!userId) return null;

    try {
        const results = await svc.getMemoriesByTag(userId, portraitTag(contactName));
        return results.length > 0 ? results[0].content : null;
    } catch (e) {
        devLog('PsychologicalPortraitService: getPortrait error', e);
        return null;
    }
}

/**
 * Возвращает портреты всех контактов пользователя.
 */
export async function getAllPortraits(
    ctx: BotContext,
): Promise<Array<{ contactName: string; content: string }>> {
    const svc = getVectorService();
    if (!svc) return [];

    const userId = String(ctx.from?.id);
    if (!userId) return [];

    try {
        const results = await svc.getMemoriesByTag(userId, 'portrait:');
        return results
            .filter(r => r.tags?.some(t => String(t).startsWith('portrait:')))
            .map(r => {
                const nameTag = r.tags.find(t => String(t).startsWith('portrait:'));
                const contactName = nameTag ? String(nameTag).replace('portrait:', '') : 'Неизвестно';
                return { contactName, content: r.content };
            });
    } catch (e) {
        devLog('PsychologicalPortraitService: getAllPortraits error', e);
        return [];
    }
}
