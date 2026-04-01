import { BotContext } from '../types';
import { FactExtractionService } from '../services/FactExtractionService';
import { saveMemory } from './enhancedDomainMemory';
import { devLog, parseLLMJson } from '../utils';
import { rememberFact } from './domainMemory';
import openai from '../openai';

interface QuickFact {
    content: string;
    domain: string;
    importance: number;
    tags: string[];
}

const factService = new FactExtractionService();

/** Паттерны явной просьбы запомнить — при совпадении факт сразу сохраняется в векторную БД (долговременная память). */
const EXPLICIT_REMEMBER_PATTERNS: RegExp[] = [
    // «Запомни, что …» / «Запомни что …» / «Запомни: …»
    /запомни\s*(?:,|что|:)\s*(.+)/i,
    // «Запомни это: …» / «Запомни на будущее что …»
    /запомни\s+(?:это|на будущее)\s*(?:[:\s,]+|что\s+)?(.+)/i,
    // «Сохрани в память что …» / «Сохрани что …»
    /сохрани\s+в память\s*(?:,|что)\s*(.+)/i,
    /сохрани\s*(?:,|что)\s*(.+)/i,
    // «Запиши что …» / «Запиши, что …»
    /запиши\s*(?:,|что)\s*(.+)/i,
    // «Не забывай что …» / «Не забывай, что …»
    /не забывай\s*(?:,|что)\s*(.+)/i,
    // «Важно запомнить что …» / «Нужно запомнить …»
    /(?:важно|нужно)\s+запомнить\s*(?:,|что)?\s*(.+)/i,
    // «Хочу чтобы ты запомнила …» / «Запомни пожалуйста что …»
    /(?:хочу\s+чтобы\s+ты\s+запомнила?|запомни\s+пожалуйста)\s*(?:,|что)?\s*(.+)/i,
    // English
    /remember\s+that\s+(.+)/i,
    /keep in mind\s+(?:that\s+)?(.+)/i,
    /don't forget\s+that\s+(.+)/i,
    /save\s+(?:to memory|that)\s+(.+)/i,
    // Общий «Запомни …» (одно или несколько слов после)
    /^запомни\s+(.+)/i,
];

const EXPLICIT_REMEMBER_IMPORTANCE = 0.95;
const EXPLICIT_REMEMBER_DOMAIN = 'personal';

/**
 * Проверяет, просит ли пользователь явно что-то запомнить. Если да — возвращает факт для сохранения в векторную БД (долговременная память).
 */
export function extractExplicitRememberFact(message: string): { content: string; domain: string; importance: number } | null {
    const trimmed = message.trim();
    if (!trimmed || trimmed.length < 3) return null;

    for (const re of EXPLICIT_REMEMBER_PATTERNS) {
        const match = trimmed.match(re);
        if (match && match[1]) {
            const content = match[1].trim();
            if (content.length < 2) return null;
            return {
                content,
                domain: EXPLICIT_REMEMBER_DOMAIN,
                importance: EXPLICIT_REMEMBER_IMPORTANCE,
            };
        }
    }
    return null;
}

export async function extractAndSaveFactsFromConversation(
    ctx: BotContext,
    startIndex: number = 0
): Promise<number> {
    try {
        // Анализируем только новые сообщения: история в порядке от новых к старым (index 0 = последнее)
        const totalCount = ctx.session.messageHistory.length;
        const newCount = Math.max(0, totalCount - startIndex);
        const recentMessages = ctx.session.messageHistory.slice(0, Math.min(10, newCount));
        const conversation = recentMessages.reverse();

        if (conversation.length < 1) {
            devLog('Нет сообщений для анализа фактов');
            return 0;
        }

        devLog(
            `🔍 Анализ фактов: ${conversation.length} сообщений в хронологическом порядке`
        );
        conversation.forEach((msg, i) => {
            devLog(`  ${i}: ${msg.role} - "${msg.content.slice(0, 50)}..."`);
        });

        const lastUserMessage = conversation.find(msg => msg.role === 'user');
        if (lastUserMessage) {
            devLog(
                `📝 Анализируем последнее сообщение пользователя: "${lastUserMessage.content.slice(0, 100)}..."`
            );
            // const singleMessageFacts = await factService.extractFactsFromSingleMessage(lastUserMessage.content);
        }

        if (conversation.length < 2) {
            devLog('Недостаточно сообщений для анализа фактов');
            return 0;
        }

        devLog(`Анализ фактов: ${conversation.length} сообщений, начиная с индекса ${startIndex}`);

        const dialoguePairs = groupMessagesIntoDialogue(conversation);

        if (dialoguePairs.length === 0) {
            devLog('⚠️ Нет диалоговых пар, но проверяем одиночные сообщения');
            // Не прерываем выполнение, так как могут быть одиночные факты
        }

        const facts = await factService.extractFactsFromDialogue(dialoguePairs);

        devLog(`Извлечено фактов: ${facts.length}`);
        if (facts.length === 0) {
            console.warn('⚠️ Мониторинг качества: при анализе диалога факты не найдены');
        }

        let savedCount = 0;
        for (const fact of facts) {
            if (fact.confidence > 0.5 && fact.importance > 0.3) {
                await saveMemory(ctx, fact.domain, fact.content, fact.importance, fact.tags);
                rememberFact(ctx, fact.domain, fact.content);
                savedCount++;
                devLog(`Сохранен факт: ${fact.content}`);
            } else {
                devLog(`Факт отклонен (низкие показатели): ${fact.content} (conf: ${fact.confidence}, imp: ${fact.importance})`);
            }
        }

        devLog(`Сохранено фактов: ${savedCount} из ${facts.length}`);

        devLog(`📊 Статистика анализа:\n  - Всего сообщений в истории: ${ctx.session.messageHistory.length}\n  - Анализируется сообщений: ${conversation.length}\n  - Последний анализ был на индексе: ${ctx.session.lastFactAnalysisIndex}\n  - Создано диалоговых пар: ${dialoguePairs.length}`);

        ctx.session.lastFactAnalysisIndex = ctx.session.messageHistory.length;
        return savedCount;

    } catch (error) {
        console.error('Ошибка в анализе фактов из разговора:', error);
        return 0;
    }
}

export async function quickFactCheck(message: string): Promise<QuickFact[]> {
    const trimmed = message.trim();
    if (!trimmed) return [];

    const today = new Date().toLocaleDateString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric' });
    const prompt = `
Определи, содержит ли сообщение пользователя ЯВНЫЕ личные факты о нем (имя, возраст, отношения, семья, личные данные, устойчивые предпочтения, работа, место жительства, текущее местонахождение, поездки и путешествия).

Сегодняшняя дата: ${today}

Сообщение:
"${trimmed}"

ВАЖНО: Если пользователь сообщает о своём ТЕКУЩЕМ местонахождении или состоянии события (поездка, путешествие, конференция и т.д.) — это факт, включай его с датой.
Примеры:
- "Я уже во Вьетнаме" → "Сейчас во Вьетнаме (с ${today})" (domain: travel, importance: 0.8)
- "Уже прилетел в Токио" → "Сейчас в Токио (с ${today})" (domain: travel, importance: 0.8)
- "Вернулся из Вьетнама" → "Вернулся из Вьетнама (${today})" (domain: travel, importance: 0.7)
- "Сейчас занят" → НЕ факт (слишком расплывчато)

Верни ТОЛЬКО JSON:
{
  "facts": [
    {
      "content": "краткий факт",
      "domain": "work|health|family|finance|education|hobbies|travel|social|home|personal|entertainment|general",
      "importance": 0.0-1.0,
      "tags": ["tag1", "tag2"]
    }
  ]
}

Если явных фактов нет, верни {"facts": []}.`;

    try {
        const response = await openai.chat.completions.create({
            model: 'gpt-5-nano',
            messages: [
                {
                    role: 'system',
                    content: 'Ты быстрый бинарный классификатор личных фактов. Отвечай строго JSON без пояснений.',
                },
                { role: 'user', content: prompt },
            ],
            temperature: 1, // модель поддерживает только default (1)
        });

        const content = response.choices[0]?.message?.content || '';
        const parsed = parseLLMJson<{ facts?: unknown[] }>(content);
        if (!parsed || !Array.isArray(parsed.facts)) return [];

        const normalizedFacts = parsed.facts
            .filter((fact: any) => fact?.content && fact?.domain)
            .map((fact: any) => ({
                content: String(fact.content).trim(),
                domain: String(fact.domain).trim() || 'general',
                importance: typeof fact.importance === 'number' ? Math.min(1, Math.max(0, fact.importance)) : 0.75,
                tags: Array.isArray(fact.tags) ? fact.tags.map((tag: unknown) => String(tag)) : [],
            }))
            .filter((fact: QuickFact) => fact.content.length > 0);

        if (normalizedFacts.length === 0) {
            console.warn('⚠️ Мониторинг качества: quickFactCheck не нашел фактов в сообщении');
        }

        return normalizedFacts;
    } catch (error) {
        console.error('Ошибка быстрого анализа фактов:', error);
        return [];
    }
}

interface DialoguePair {
    userMessage: string;
    botResponse: string;
    userReply?: string;
    timestamp: Date;
    isUserInitiated: boolean;
}

function groupMessagesIntoDialogue(messages: any[]): DialoguePair[] {
    const pairs: DialoguePair[] = [];

    devLog(`🔍 Группировка ${messages.length} сообщений в диалоги`);

    for (let i = 0; i < messages.length - 1; i++) {
        const current = messages[i];
        const next = messages[i + 1];

        devLog(`  Проверяем пару ${i}: ${current.role} -> ${next.role}`);

        if (current.role === 'user' && next.role === 'bot') {
            const userReply =
                i + 2 < messages.length && messages[i + 2].role === 'user'
                    ? messages[i + 2].content
                    : undefined;

            const pair = {
                userMessage: current.content,
                botResponse: next.content,
                userReply,
                timestamp: current.timestamp,
                isUserInitiated: true,
            };

            pairs.push(pair);
            devLog(`✅ Создана диалоговая пара: "${current.content}" -> "${next.content}"`);
        }
    }

    devLog(`📊 Создано диалоговых пар: ${pairs.length}`);
    return pairs;
}
