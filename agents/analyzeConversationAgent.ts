import {
    extractFactsAboutUserFromConversation,
    ExtractedFactAboutUser,
} from '../utils/studyChatFlow';
import { devLog } from '../utils';

/**
 * Агент 2: анализирует текст переписки и извлекает факты о пользователе (владельце бота).
 * Единственная ответственность — по тексту диалога получить структурированные факты о "Я".
 */
export async function runAnalyzeConversationAgent(
    formattedConversationText: string,
    contactName: string,
    startDate?: Date,
    endDate?: Date
): Promise<ExtractedFactAboutUser[]> {
    const facts = await extractFactsAboutUserFromConversation(
        formattedConversationText,
        contactName,
        startDate,
        endDate
    );
    devLog('AnalyzeConversationAgent: extracted facts', { count: facts.length, contactName });
    return facts;
}
