import { BotContext } from '../types';
import { ContactsStore } from '../stores/ContactsStore';
import { runFetchChatMessagesAgent } from '../agents/fetchChatMessagesAgent';
import { runAnalyzeConversationAgent } from '../agents/analyzeConversationAgent';
import { runUpdateLongTermMemoryAgent } from '../agents/updateLongTermMemoryAgent';
import type { StudyChatPeriod } from './studyChatFlow';

const PERIOD_LABELS: Record<StudyChatPeriod, string> = {
    week: 'неделю',
    month: 'месяц',
    '3months': '3 месяца',
    year: 'год',
};

/**
 * Последовательный пайплайн из трёх агентов:
 * 1) Получить сообщения из переписки за период (fetchChatMessagesAgent),
 * 2) Проанализировать переписку и извлечь факты о пользователе (analyzeConversationAgent),
 * 3) Обновить долговременную память (updateLongTermMemoryAgent).
 */
export async function studyChatAndSaveFacts(
    ctx: BotContext,
    contactName: string,
    contactId: number,
    period: StudyChatPeriod
): Promise<{ responseText: string; savedCount: number }> {
    const contact = ContactsStore.getInstance().getContact(contactId);
    const displayName = contact ? `${contact.firstName} ${contact.lastName || ''}`.trim() : contactName;

    // Шаг 1: агент получения сообщений
    const days = { week: 7, month: 30, '3months': 90, year: 365 }[period];
    const endDate = new Date();
    const startDate = new Date();
    startDate.setDate(startDate.getDate() - days);

    const fetchResult = await runFetchChatMessagesAgent(contactId, period, displayName);
    if ('error' in fetchResult) {
        return { responseText: fetchResult.error, savedCount: 0 };
    }

    // Шаг 2: агент анализа переписки
    let facts;
    try {
        facts = await runAnalyzeConversationAgent(fetchResult.formattedText, displayName, startDate, endDate);
    } catch (e: any) {
        const reason = e?.message || String(e);
        console.error('[studyChatPipeline] analyzeConversation failed:', reason);
        return {
            responseText: `Не удалось проанализировать переписку с ${displayName}: ${reason}`,
            savedCount: 0,
        };
    }

    // Шаг 3: агент обновления долговременной памяти
    const savedCount = await runUpdateLongTermMemoryAgent(ctx, facts);

    const periodLabel = PERIOD_LABELS[period];

    let responseText: string;
    if (savedCount > 0) {
        const userFacts = facts.filter(f => f.subject === 'user');
        const contactFacts = facts.filter(f => f.subject === 'contact');

        const formatList = (items: typeof facts) =>
            items.map(f => `• ${f.content}`).join('\n');

        const parts: string[] = [
            `Изучила переписку с ${displayName} за ${periodLabel} (${fetchResult.messageCount} сообщений). Запомнила ${savedCount} факт(ов).`,
        ];
        if (userFacts.length > 0) {
            parts.push(`\nО тебе:\n${formatList(userFacts)}`);
        }
        if (contactFacts.length > 0) {
            parts.push(`\nО ${displayName}:\n${formatList(contactFacts)}`);
        }
        responseText = parts.join('\n');
    } else {
        responseText = `Переписку с ${displayName} за ${periodLabel} прочитала (${fetchResult.messageCount} сообщений), но не нашла новых однозначных фактов для сохранения.`;
    }

    return { responseText, savedCount };
}
