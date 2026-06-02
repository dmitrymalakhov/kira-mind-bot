import openai, { openAiModels } from '../openai';
import { getVectorService } from '../services/VectorServiceFactory';
import { config } from '../config';
import { getBotPersona, getCommunicationStyle } from '../persona';

export interface TrackedMessage {
    senderName: string;
    text: string;
    date: Date;
}

export interface TrackingAnalysisResult {
    isImportant: boolean;
    reason: string;
    notificationText: string;
}

async function fetchRelevantMemory(query: string): Promise<string> {
    const svc = getVectorService();
    if (!svc) return '';
    try {
        const results = await svc.searchAllDomains(query, String(config.allowedUserId), 6);
        if (!results.length) return '';
        return results.map((r: any) => `• ${r.content}`).join('\n');
    } catch {
        return '';
    }
}

export async function analyzeTrackedMessages(
    chatName: string,
    groupName: string,
    newMessages: TrackedMessage[],
    recentContext: TrackedMessage[]
): Promise<TrackingAnalysisResult | null> {
    if (!newMessages.length) return null;

    const messagesText = newMessages
        .map(m => `[${m.senderName}]: ${m.text}`)
        .join('\n');

    const contextText = recentContext.length
        ? recentContext.map(m => `[${m.senderName}]: ${m.text}`).join('\n')
        : 'Нет предыдущего контекста';

    const memoryQuery = `${groupName} ${chatName} ${newMessages.map(m => m.text).join(' ')}`;
    const memoryContext = await fetchRelevantMemory(memoryQuery);

    const systemPrompt = `${getBotPersona()} ${getCommunicationStyle()}
Ты анализируешь новые сообщения из Telegram-чата, за которым следишь по просьбе пользователя.
Твоя задача — определить, критична ли эта информация лично для ${config.ownerName}, и если да — кратко объяснить почему.

Критичным считается сообщение, которое:
- Требует действия или ответа от ${config.ownerName}
- Касается его проектов, работы, договорённостей или близких людей
- Содержит важную новость или изменение ситуации, о которой он должен знать
- Упоминает его лично или связанные с ним темы

НЕ критично: общий флуд, новости не по теме, мемы, технические уведомления ботов.

Отвечай строго в JSON без markdown:
{"isImportant": true/false, "reason": "краткое объяснение (1-2 предложения)", "notificationText": "текст уведомления для пользователя"}

notificationText — это готовое сообщение которое получит пользователь, пиши живо и по делу.`;

    const userPrompt = `Чат: ${chatName} (группа отслеживания: ${groupName})

${memoryContext ? `Из долговременной памяти о пользователе:\n${memoryContext}\n\n` : ''}Предыдущий контекст чата:
${contextText}

Новые сообщения:
${messagesText}`;

    try {
        const response = await openai.chat.completions.create({
            model: openAiModels.memoryExtractionModel,
            messages: [
                { role: 'system', content: systemPrompt },
                { role: 'user', content: userPrompt },
            ],
            temperature: 0.3,
        });

        const raw = response.choices[0]?.message?.content?.trim() || '';
        const match = raw.match(/\{[\s\S]*\}/);
        if (!match) return null;

        const parsed = JSON.parse(match[0]) as TrackingAnalysisResult;
        return parsed;
    } catch (e) {
        console.error('[trackingAnalysisAgent] error:', e);
        return null;
    }
}
