import { BotContext } from '../types';
import { ContactsStore } from '../stores/ContactsStore';
import { runFetchChatMessagesAgent } from '../agents/fetchChatMessagesAgent';
import { runAnalyzeConversationAgent } from '../agents/analyzeConversationAgent';
import { runUpdateLongTermMemoryAgentDetailed } from '../agents/updateLongTermMemoryAgent';
import { saveOrUpdatePortrait } from '../services/PsychologicalPortraitService';
import { notifyUser } from '../utils';
import type {
    ExtractedFactAboutUser,
    StudyChatAnalysisProgress,
    StudyChatPeriod,
} from './studyChatFlow';

const PERIOD_LABELS: Record<StudyChatPeriod, string> = {
    week: 'неделю',
    month: 'месяц',
    '3months': 'квартал',
    year: 'год',
};

function formatFactList(items: ExtractedFactAboutUser[]): string {
    return items.map(f => `• ${f.content}`).join('\n');
}

function formatPartWord(count: number): string {
    const mod10 = count % 10;
    const mod100 = count % 100;
    if (mod10 === 1 && mod100 !== 11) return 'часть';
    if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) return 'части';
    return 'частей';
}

function buildNotSavedReason(
    facts: ExtractedFactAboutUser[],
    savedCount: number,
    eligibleCount: number,
    pendingCount: number,
    errorsCount: number
): string {
    if (facts.length === 0) return 'не нашла новых однозначных фактов';
    if (eligibleCount === 0) return 'найденное оказалось слишком ситуативным или слабым для долговременной памяти';
    if (pendingCount > 0) return 'для части фактов нужно уточнить контакт';
    if (errorsCount > 0 && savedCount === 0) return 'сохранение в память завершилось с ошибкой';
    return 'похожие факты уже были в памяти или не прошли проверку сохранения';
}

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

    await notifyUser(ctx, `📨 Этап 1/5: загружаю переписку с ${displayName} за ${PERIOD_LABELS[period]}…`);
    let fetchResult;
    try {
        fetchResult = await runFetchChatMessagesAgent(contactId, period, displayName);
    } catch (e: any) {
        const reason = e?.message || String(e);
        console.error('[studyChatPipeline] fetch messages failed:', reason);
        return {
            responseText: `Не удалось загрузить переписку с ${displayName}: ${reason}. Проверь подключение Telegram и попробуй ещё раз.`,
            savedCount: 0,
        };
    }
    if ('error' in fetchResult) {
        return { responseText: fetchResult.error, savedCount: 0 };
    }
    await notifyUser(ctx, `📨 Этап 1/5: загрузила ${fetchResult.messageCount} сообщений. Готовлю текст переписки к анализу.`);

    // Шаг 2: агент анализа переписки
    await notifyUser(ctx, `🔍 Этап 2/5: ищу факты в ${fetchResult.messageCount} сообщениях…`);
    let facts;
    try {
        const onAnalysisProgress = async (progress: StudyChatAnalysisProgress): Promise<void> => {
            if (progress.stage === 'chunks_ready') {
                await notifyUser(
                    ctx,
                    `🧩 Этап 2/5: разделила переписку на ${progress.chunksTotal} ${formatPartWord(progress.chunksTotal)} для LLM-анализа.`
                );
                return;
            }

            if (progress.stage === 'batch_done') {
                await notifyUser(
                    ctx,
                    `🔎 Этап 2/5: проанализировала ${progress.chunksDone}/${progress.chunksTotal} ${formatPartWord(progress.chunksTotal)}, пока нашла ${progress.rawFactsCount} кандидат(ов) в факты.`
                );
                return;
            }

            if (progress.stage === 'raw_facts_ready') {
                await notifyUser(ctx, `🧾 Этап 2/5: первичный анализ завершён, найдено ${progress.rawFactsCount} кандидат(ов) в факты.`);
                return;
            }

            if (progress.stage === 'synthesis_start') {
                await notifyUser(ctx, `🧠 Этап 3/5: объединяю похожие факты и убираю дубли…`);
                return;
            }

            await notifyUser(ctx, `🧠 Этап 3/5: после проверки осталось ${progress.factsCount} факт(ов) для возможного сохранения.`);
        };

        facts = await runAnalyzeConversationAgent(fetchResult.formattedText, displayName, startDate, endDate, onAnalysisProgress);
    } catch (e: any) {
        const reason = e?.message || String(e);
        console.error('[studyChatPipeline] analyzeConversation failed:', reason);
        return {
            responseText: `Не удалось проанализировать переписку с ${displayName}: ${reason}`,
            savedCount: 0,
        };
    }

    // Шаг 3: агент обновления долговременной памяти
    let updateResult;
    if (facts.length > 0) {
        await notifyUser(ctx, `💾 Этап 4/5: сохраняю ${facts.length} факт(ов) в долговременную память…`);
        try {
            updateResult = await runUpdateLongTermMemoryAgentDetailed(ctx, facts, {
                source: 'study_chat',
                sourceContactName: displayName,
            });
        } catch (e: any) {
            const reason = e?.message || String(e);
            console.error('[studyChatPipeline] memory update failed:', reason);
            updateResult = {
                totalCount: facts.length,
                eligibleCount: facts.length,
                savedCount: 0,
                savedFacts: [],
                pendingFacts: [],
                skippedFacts: facts,
                errors: [reason],
            };
        }
    } else {
        updateResult = {
            totalCount: 0,
            eligibleCount: 0,
            savedCount: 0,
            savedFacts: [],
            pendingFacts: [],
            skippedFacts: [],
            errors: [],
        };
    }
    const savedCount = updateResult.savedCount;
    if (facts.length > 0) {
        await notifyUser(ctx, `💾 Этап 4/5: сохранение завершено, запомнила ${savedCount} из ${facts.length} факт(ов).`);
    } else {
        await notifyUser(ctx, `💾 Этап 4/5: сохранять нечего — новых фактов не найдено.`);
    }

    // Шаг 4: строим / обновляем психологический портрет контакта (fire-and-forget с ожиданием)
    let portraitUpdated = false;
    await notifyUser(ctx, `🧠 Этап 5/5: обновляю психологический портрет ${displayName} и собираю итог…`);
    try {
        portraitUpdated = await saveOrUpdatePortrait(ctx, displayName, fetchResult.formattedText, contact);
    } catch (e) {
        console.error('[studyChatPipeline] portrait build error:', e);
    }
    await notifyUser(ctx, portraitUpdated
        ? `🧠 Этап 5/5: портрет ${displayName} обновлён. Формирую итог.`
        : `🧠 Этап 5/5: портрет не изменился или обновление не потребовалось. Формирую итог.`
    );

    const periodLabel = PERIOD_LABELS[period];
    const foundUserFacts = facts.filter(f => f.subject === 'user');
    const foundContactFacts = facts.filter(f => f.subject === 'contact');

    let responseText: string;
    if (savedCount > 0) {
        const userFacts = updateResult.savedFacts.filter(f => f.subject === 'user');
        const contactFacts = updateResult.savedFacts.filter(f => f.subject === 'contact');

        const parts: string[] = [
            `Изучила переписку с ${displayName} за ${periodLabel} (${fetchResult.messageCount} сообщений). Нашла ${facts.length} факт(ов): о тебе — ${foundUserFacts.length}, о ${displayName} — ${foundContactFacts.length}. Запомнила ${savedCount}: о тебе — ${userFacts.length}, о ${displayName} — ${contactFacts.length}.`,
        ];
        if (userFacts.length > 0) {
            parts.push(`\nО тебе:\n${formatFactList(userFacts)}`);
        }
        if (contactFacts.length > 0) {
            parts.push(`\nО ${displayName}:\n${formatFactList(contactFacts)}`);
        }
        const notSavedCount = facts.length - savedCount;
        if (notSavedCount > 0) {
            const reason = buildNotSavedReason(
                facts,
                savedCount,
                updateResult.eligibleCount,
                updateResult.pendingFacts.length,
                updateResult.errors.length
            );
            parts.push(`\nНе сохранила ${notSavedCount} факт(ов): ${reason}.`);
        }
        if (portraitUpdated) {
            parts.push(`\n🧠 Психологический портрет ${displayName} обновлён.`);
        }
        responseText = parts.join('\n');
    } else {
        const portraitNote = portraitUpdated ? `\n🧠 Психологический портрет ${displayName} обновлён.` : '';
        const reason = buildNotSavedReason(
            facts,
            savedCount,
            updateResult.eligibleCount,
            updateResult.pendingFacts.length,
            updateResult.errors.length
        );
        responseText = `Переписку с ${displayName} за ${periodLabel} прочитала (${fetchResult.messageCount} сообщений). Нашла ${facts.length} факт(ов): о тебе — ${foundUserFacts.length}, о ${displayName} — ${foundContactFacts.length}. Ничего не сохранила: ${reason}.${portraitNote}`;
    }

    return { responseText, savedCount };
}
