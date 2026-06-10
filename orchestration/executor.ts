import type { BotContext } from '../types';
import type { MessageHistory } from '../types';
import type { ProcessingResult, MessageClassification } from '../orchestrator';
import type { Plan, PlanStep } from './types';
import { fetchAgentMemoryContext, buildMemoryContextBlock } from '../utils/agentMemoryContext';
import { conversationAgent } from '../agents/conversationAgent';
import { reminderAgent } from '../agents/reminderAgent';
import { webSearchAgent } from '../agents/webSearchAgent';
import { readMessagesAgent } from '../agents/readMessagesAgent';
import { sendMessagesAgent } from '../agents/sendMessagesAgent';
import { negotiateOnBehalfAgent } from '../agents/negotiateOnBehalfAgent';
import { imageGenerationAgent } from '../agents/imageGenerationAgent';
import { mapsAgent } from '../agents/googleMapsAgent';
import { unclearIntentAgent } from '../agents/unclearIntentAgent';
import { resolveRelationshipFromMemory, detectRelationshipInMessage } from '../utils/resolveRelationshipFromMemory';
import { answerCapabilitiesQuestion, getCapabilitiesMessage } from '../capabilities';
import { browserAgent } from '../agents/browserAgent';
import { selfStudyAgent } from '../agents/selfStudyAgent';
import { healthAgent } from '../agents/healthAgent';
import { ReminderRegistry } from '../stores/ReminderRegistry';
import { cancelReminder, rescheduleReminder } from '../reminder';
import { ReminderRepository } from '../services/ReminderRepository';
import { devLog, parseLLMJson } from '../utils';
import { buildQuickChoiceKeyboard } from '../utils/quickChoice';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { applyReminderEditInput } from '../utils/reminderEditor';

/**
 * Ищет напоминание по текстовому запросу и отменяет его.
 * Сначала пробует точное вхождение слов, затем — по любому слову длиннее 3 символов.
 */
async function cancelReminderByQuery(
    ctx: BotContext,
    query: string
): Promise<ProcessingResult> {
    const chatId = ctx.chat?.id;
    if (!chatId) return { responseText: 'Не могу определить чат для поиска напоминаний 🙏' };

    const active = ReminderRegistry.getInstance().getActiveByChatId(chatId);
    if (!active.length) {
        return { responseText: 'У тебя сейчас нет активных напоминаний 🤷' };
    }

    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/).filter((w) => w.length > 3);

    // Ищем лучшее совпадение: считаем, сколько ключевых слов встречается в тексте напоминания
    let best: { reminder: typeof active[0]; score: number } | null = null;
    for (const r of active) {
        const text = (r.text ?? '').toLowerCase();
        const displayText = (r.displayText ?? '').toLowerCase();
        const combined = text + ' ' + displayText;
        const score = words.filter((w) => combined.includes(w)).length;
        if (score > 0 && (!best || score > best.score)) {
            best = { reminder: r, score };
        }
    }
    if (!best && active.length === 1) {
        best = { reminder: active[0], score: 1 };
    }

    if (!best) {
        const list = active.map((r, i) => `${i + 1}. ${r.displayText || r.text}`).join('\n');
        return {
            responseText: `Не нашла напоминание по запросу «${query}». Активные напоминания:\n${list}`,
        };
    }

    const { reminder } = best;
    await cancelReminder(reminder.id);
    ReminderRegistry.getInstance().remove(reminder.id);
    if (ctx.session?.reminders) {
        ctx.session.reminders = ctx.session.reminders.filter((r) => r.id !== reminder.id);
    }

    devLog('Executor: cancelled reminder by query', query, '->', reminder.id);
    console.log('[ORCH] cancelReminderByQuery: cancelled', reminder.id, '| text:', (reminder.displayText || reminder.text).slice(0, 60));

    return {
        responseText: `✅ Напоминание отменено: «${reminder.displayText || reminder.text}»`,
    };
}

/**
 * Ищет напоминание по текстовому запросу, обновляет время/текст и перепланирует.
 */
async function updateReminderByQuery(
    ctx: BotContext,
    query: string,
    message: string
): Promise<ProcessingResult> {
    const chatId = ctx.chat?.id;
    if (!chatId) return { responseText: 'Не могу определить чат для поиска напоминаний 🙏' };

    const active = ReminderRegistry.getInstance().getActiveByChatId(chatId);
    if (!active.length) {
        return { responseText: 'У тебя сейчас нет активных напоминаний 🤷' };
    }

    const q = query.toLowerCase().trim();
    const words = q.split(/\s+/).filter((w) => w.length > 3);

    let best: { reminder: typeof active[0]; score: number } | null = null;
    for (const r of active) {
        const text = (r.text ?? '').toLowerCase();
        const displayText = (r.displayText ?? '').toLowerCase();
        const combined = text + ' ' + displayText;
        const score = words.filter((w) => combined.includes(w)).length;
        if (score > 0 && (!best || score > best.score)) {
            best = { reminder: r, score };
        }
    }
    if (!best && active.length === 1) {
        best = { reminder: active[0], score: 1 };
    }

    if (!best) {
        const list = active.map((r, i) => `${i + 1}. ${r.displayText || r.text}`).join('\n');
        return {
            responseText: `Не нашла напоминание по запросу «${query}». Активные напоминания:\n${list}`,
        };
    }

    const editResult = await applyReminderEditInput(best.reminder, message);
    if (!editResult.ok || !editResult.reminder) {
        return { responseText: editResult.responseText };
    }

    const reminder = editResult.reminder;

    if (ctx.session?.reminders) {
        const idx = ctx.session.reminders.findIndex((r) => r.id === reminder.id);
        if (idx >= 0) ctx.session.reminders[idx] = reminder;
    }

    devLog('Executor: updated reminder', reminder.id);
    console.log('[ORCH] updateReminderByQuery: updated', reminder.id, '| due:', new Date(reminder.dueDate).toISOString());

    return { responseText: editResult.responseText };
}

/** Фильтрует активные напоминания по периоду (today/tomorrow/week/undefined=все). */
function filterByPeriod(
    reminders: ReturnType<typeof ReminderRegistry.prototype.getActiveByChatId>,
    period?: string
) {
    if (!period) return reminders;
    const now = new Date();
    return reminders.filter((r) => {
        const d = new Date(r.dueDate);
        if (period === 'today') {
            return d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
        }
        if (period === 'tomorrow') {
            const tomorrow = new Date(now);
            tomorrow.setDate(tomorrow.getDate() + 1);
            return d.getFullYear() === tomorrow.getFullYear() && d.getMonth() === tomorrow.getMonth() && d.getDate() === tomorrow.getDate();
        }
        if (period === 'week') {
            const weekLater = new Date(now);
            weekLater.setDate(weekLater.getDate() + 7);
            return d >= now && d <= weekLater;
        }
        return true;
    });
}

/**
 * Отменяет все активные напоминания (опционально — за период).
 */
async function cancelAllReminders(
    ctx: BotContext,
    period?: string
): Promise<ProcessingResult> {
    const chatId = ctx.chat?.id;
    if (!chatId) return { responseText: 'Не могу определить чат 🙏' };

    const active = ReminderRegistry.getInstance().getActiveByChatId(chatId);
    const targets = filterByPeriod(active, period);

    if (!targets.length) {
        return { responseText: period ? `Нет активных напоминаний за этот период 🤷` : 'У тебя нет активных напоминаний 🤷' };
    }

    for (const r of targets) {
        await cancelReminder(r.id);
        ReminderRegistry.getInstance().remove(r.id);
        if (ctx.session?.reminders) {
            ctx.session.reminders = ctx.session.reminders.filter((s) => s.id !== r.id);
        }
    }

    const label = period === 'today' ? ' на сегодня' : period === 'tomorrow' ? ' на завтра' : period === 'week' ? ' за неделю' : '';
    devLog('Executor: cancelAll', targets.length, 'reminders');
    return { responseText: `✅ Отменено ${targets.length} напоминани${targets.length === 1 ? 'е' : targets.length < 5 ? 'я' : 'й'}${label}.` };
}

/**
 * Переносит все активные напоминания на новое время (опционально — только за период).
 */
async function updateAllReminders(
    ctx: BotContext,
    period: string | undefined,
    message: string
): Promise<ProcessingResult> {
    const chatId = ctx.chat?.id;
    if (!chatId) return { responseText: 'Не могу определить чат 🙏' };

    const active = ReminderRegistry.getInstance().getActiveByChatId(chatId);
    const targets = filterByPeriod(active, period);

    if (!targets.length) {
        return { responseText: period ? 'Нет активных напоминаний за этот период 🤷' : 'У тебя нет активных напоминаний 🤷' };
    }

    const now = new Date();
    let newDueDate: Date | null = null;
    let shiftMinutes: number | null = null;

    try {
        const resp = await createChatCompletionForTask('memoryExtraction', {
            messages: [
                {
                    role: 'system',
                    content: `Текущая дата и время: ${now.toLocaleString('ru-RU', { day: 'numeric', month: 'long', year: 'numeric', hour: 'numeric', minute: 'numeric', weekday: 'long' })}.
Пользователь хочет перенести ВСЕ напоминания. Определи: это сдвиг на фиксированный интервал ("через X часов", "на неделю вперёд") или конкретное новое время ("на завтра в 9", "на пятницу в 10")?
Верни JSON: {"shiftMinutes": число минут сдвига или null, "newDueDate": "ISO 8601 конкретного времени или null"}`,
                },
                { role: 'user', content: message.slice(0, 400) },
            ],
            temperature: 1,
        });
        const extracted = parseLLMJson<{ shiftMinutes?: number | null; newDueDate?: string | null }>(
            resp.choices[0]?.message?.content || ''
        );
        if (extracted?.shiftMinutes) shiftMinutes = Number(extracted.shiftMinutes);
        if (extracted?.newDueDate) {
            const d = new Date(extracted.newDueDate);
            if (!isNaN(d.getTime())) newDueDate = d;
        }
    } catch (e) {
        console.error('[ORCH] updateAllReminders: LLM failed', e);
    }

    if (!shiftMinutes && !newDueDate) {
        return { responseText: 'Не смогла распознать новое время. Уточни, например: «перенеси все на завтра в 9» или «сдвинь все на 2 часа вперёд».' };
    }

    for (const r of targets) {
        const updated = { ...r };
        if (shiftMinutes) {
            updated.dueDate = new Date(new Date(r.dueDate).getTime() + shiftMinutes * 60 * 1000);
        } else if (newDueDate) {
            updated.dueDate = newDueDate;
        }
        rescheduleReminder(updated);
        ReminderRegistry.getInstance().add(updated);
        if (ctx.session?.reminders) {
            const idx = ctx.session.reminders.findIndex((s) => s.id === r.id);
            if (idx >= 0) ctx.session.reminders[idx] = updated;
        }
        await ReminderRepository.update(updated).catch(() => {});
    }

    const label = period === 'today' ? ' на сегодня' : period === 'tomorrow' ? ' на завтра' : period === 'week' ? ' за неделю' : '';
    devLog('Executor: updateAll', targets.length, 'reminders');
    return { responseText: `✅ Перенесено ${targets.length} напоминани${targets.length === 1 ? 'е' : targets.length < 5 ? 'я' : 'й'}${label}.` };
}

/**
 * Объединяет результаты нескольких terminal-шагов в один ответ.
 * Используется когда план содержит несколько действий (например, sendMessage + reminder).
 */
function mergeProcessingResults(results: ProcessingResult[], botReaction?: string): ProcessingResult {
    if (results.length === 1) return { ...results[0], botReaction };
    const merged: ProcessingResult = {
        responseText: results.map((r) => r.responseText).filter(Boolean).join('\n\n'),
        botReaction,
    };
    for (const r of results) {
        if (r.keyboard) merged.keyboard = r.keyboard;
        if (r.messageDraft) merged.messageDraft = r.messageDraft;
        if (r.reminderCreated) {
            merged.reminderCreated = true;
            if (r.reminderDetails) merged.reminderDetails = r.reminderDetails;
            if (r.reminderDetailsList) merged.reminderDetailsList = r.reminderDetailsList;
            if (r.icsFilePath) merged.icsFilePath = r.icsFilePath;
        }
        if (r.imageGenerated) {
            merged.imageGenerated = true;
            merged.generatedImageUrl = r.generatedImageUrl;
        }
        if (r.documentFilePath) {
            merged.documentFilePath = r.documentFilePath;
            merged.documentFilename = r.documentFilename;
            merged.documentCaption = r.documentCaption;
        }
    }
    return merged;
}

/**
 * Выполняет fn с одной повторной попыткой при сбое.
 * При двух ошибках подряд возвращает null — вызывающий код должен обработать fallback.
 */
async function safeStep<T>(agentId: string, fn: () => Promise<T>): Promise<T | null> {
    try {
        return await fn();
    } catch (firstErr) {
        console.error(`[ORCH] step "${agentId}" failed, retrying once:`, firstErr);
        try {
            return await fn();
        } catch (secondErr) {
            console.error(`[ORCH] step "${agentId}" failed twice, giving up:`, secondErr);
            return null;
        }
    }
}

/** Человекочитаемые описания шагов для уведомлений пользователя */
const STEP_LABELS: Record<string, string> = {
    webSearch: '🔍 Ищу в интернете…',
    conversation: '💬 Формирую ответ…',
    reminder: '⏰ Создаю напоминание…',
    readMessages: '📨 Анализирую переписку…',
    sendMessage: '✉️ Готовлю сообщение…',
    negotiateOnBehalf: '🤝 Начинаю переговоры…',
    imageGeneration: '🎨 Генерирую изображение…',
    maps: '🗺️ Ищу на карте…',
    unclearIntent: '🤔 Уточняю запрос…',
    capabilities: '📋 Готовлю информацию…',
    selfStudy: '🧭 Изучаю свои возможности и ограничения…',
    browserTask: '🌐 Выполняю задачу в браузере…',
    health: '🩺 Открываю дневник здоровья…',
};

/** Шаги, которые не видны пользователю (нет полезного действия для отображения) */
const SILENT_STEPS = new Set(['memory', 'resolveContact']);

export interface ExecutePlanParams {
    ctx: BotContext;
    plan: Plan;
    message: string;
    isForwarded: boolean;
    forwardFrom: string;
    messageHistory: MessageHistory[];
    classification: MessageClassification;
    lastLocation?: { latitude: number; longitude: number; address?: string };
    /** Контекст из долговременной памяти, уже донасыщенный оркестратором до классификации и плана. Если передан — не дублируем обогащение. */
    enrichedContextFromMemory?: string;
    /** Исходный запрос просил ответить голосом. */
    voiceReplyRequested?: boolean;
}

/**
 * Выполняет план: передаёт каждому агенту enrichedContextFromMemory (уже донасыщенный оркестратором).
 * Если контекст не передан — донасыщаем здесь (для вызовов не из processMessage).
 *
 * Все агенты получают и используют этот контекст в своей работе.
 */
export async function executePlan(params: ExecutePlanParams): Promise<ProcessingResult> {
    const {
        ctx,
        plan,
        message,
        isForwarded,
        forwardFrom,
        messageHistory,
        classification,
        lastLocation,
        enrichedContextFromMemory: passedContext,
        voiceReplyRequested,
    } = params;

    const steps = plan.steps;
    if (steps.length === 0) {
        return { responseText: 'Не удалось построить план ответа.' };
    }

    /** Контекст из долговременной памяти: либо передан оркестратором, либо донасыщаем здесь. */
    let enrichedContextFromMemory = passedContext ?? '';
    if (enrichedContextFromMemory === '') {
        // Параллельно загружаем память и резолвим роль из сообщения
        const [initialMemory, roleInMessage] = await Promise.all([
            fetchAgentMemoryContext(ctx, message),
            detectRelationshipInMessage(message),
        ]);
        const initialBlock = buildMemoryContextBlock(initialMemory);
        if (initialBlock) enrichedContextFromMemory = initialBlock + '\n\n';
        if (roleInMessage) {
            const resolvedName = await resolveRelationshipFromMemory(ctx, roleInMessage, message);
            if (resolvedName) {
                enrichedContextFromMemory += `В запросе пользователя под «${roleInMessage}» имеется в виду: ${resolvedName} (из долговременной памяти).\n\n`;
                devLog('Executor: enriched with resolved contact', roleInMessage, '->', resolvedName);
            }
        }
    }

    /** Проверяет, есть ли после текущего шага ещё шаги (т.е. текущий — не последний). */
    const hasMoreSteps = (index: number) => index < steps.length - 1;

    /** Видимые (не-silent) шаги плана — только по ним показываем прогресс */
    const visibleSteps = steps.filter((s) => !SILENT_STEPS.has(s.agentId));
    const isMultiStepPlan = visibleSteps.length > 1;

    /** Отправить пользователю уведомление о прогрессе (только для многошаговых планов) */
    const notifyProgress = async (stepAgentId: string) => {
        if (!isMultiStepPlan) return;
        const label = STEP_LABELS[stepAgentId];
        if (!label) return;
        try {
            await ctx.api.sendChatAction(ctx.chat!.id, 'typing');
            await ctx.reply(label);
        } catch (e) {
            devLog('Executor: failed to send progress notification', e);
        }
    };

    /** Накопленные результаты terminal-шагов в составном плане (multi-intent). */
    const collectedResults: ProcessingResult[] = [];

    for (let i = 0; i < steps.length; i++) {
        const step = steps[i];
        const nextStep = steps[i + 1];
        const isLastStep = !hasMoreSteps(i);

        devLog('Executor: step', i + 1, step.agentId, step.params);
        console.log("[ORCH] executor step", i + 1, "/", steps.length, "→", step.agentId);

        switch (step.agentId) {
            case 'resolveContact': {
                // Роль→имя уже добавлено в enrichedContextFromMemory в фазе донасыщения.
                // Но если detectRelationshipInMessage не нашёл роль, а планировщик указал relationship в params — резолвим здесь.
                const planRelationship = step.params?.relationship as string | undefined;
                if (planRelationship && !enrichedContextFromMemory.includes('имеется в виду:')) {
                    const resolvedName = await resolveRelationshipFromMemory(ctx, planRelationship, message);
                    if (resolvedName) {
                        enrichedContextFromMemory += `В запросе пользователя под «${planRelationship}» имеется в виду: ${resolvedName} (из долговременной памяти).\n\n`;
                        devLog('Executor: resolveContact step resolved', planRelationship, '->', resolvedName);
                        console.log("[ORCH] resolveContact step: role", planRelationship, "-> name", resolvedName);
                    }
                }
                break;
            }

            case 'memory': {
                // Память уже подтянута в начале выполнения; шаг оставлен для совместимости с планом.
                break;
            }

            case 'webSearch': {
                await notifyProgress('webSearch');
                const webRes = await safeStep('webSearch', () => webSearchAgent(
                    message, isForwarded, forwardFrom, messageHistory, enrichedContextFromMemory || ''
                ));
                if (webRes === null) {
                    // Поиск недоступен — продолжаем план без результатов поиска
                    console.warn('[ORCH] webSearch failed, continuing without search context');
                    enrichedContextFromMemory += '\n[Поиск временно недоступен]\n';
                    break;
                }
                const passToNext = nextStep && (step.params?.asContext === true || hasMoreSteps(i));
                if (passToNext) {
                    enrichedContextFromMemory += '\nДополнительный контекст из поиска в интернете:\n' + webRes.responseText + '\n\n';
                } else {
                    webRes.botReaction = classification.details?.botReaction;
                    return webRes;
                }
                break;
            }

            case 'conversation': {
                console.log("[ORCH] invoking conversationAgent");
                await notifyProgress('conversation');
                const sharedMemoryContext = enrichedContextFromMemory.trim()
                    ? { domain: 'personal' as const, context: enrichedContextFromMemory.trim() }
                    : await fetchAgentMemoryContext(ctx, message).then((m) => ({ domain: m.domain as 'personal', context: m.context }));
                const conv = await safeStep('conversation', () => conversationAgent(
                    ctx, message, isForwarded, forwardFrom, messageHistory, classification, sharedMemoryContext
                ));
                if (conv === null) return { responseText: 'Не смогла сформировать ответ. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                conv.botReaction = classification.details?.botReaction;
                if (collectedResults.length > 0) {
                    collectedResults.push(conv);
                    return mergeProcessingResults(collectedResults, classification.details?.botReaction as string | undefined);
                }
                return conv;
            }

            case 'reminder': {
                // Отмена существующего напоминания по тексту
                if (classification.details?.reminderAction === 'cancel') {
                    const cancelQuery = String(classification.details.reminderCancelQuery || message);
                    const cancelRes = await cancelReminderByQuery(ctx, cancelQuery);
                    cancelRes.botReaction = classification.details?.botReaction;
                    return cancelRes;
                }

                // Пакетная отмена напоминаний
                if (classification.details?.reminderAction === 'cancelAll') {
                    const batchRes = await cancelAllReminders(ctx, classification.details.reminderBatchPeriod);
                    batchRes.botReaction = classification.details?.botReaction;
                    return batchRes;
                }

                // Пакетный перенос напоминаний
                if (classification.details?.reminderAction === 'updateAll') {
                    const batchRes = await updateAllReminders(ctx, classification.details.reminderBatchPeriod, message);
                    batchRes.botReaction = classification.details?.botReaction;
                    return batchRes;
                }

                // Изменение существующего напоминания
                if (classification.details?.reminderAction === 'update') {
                    const updateQuery = String(classification.details.reminderUpdateQuery || message);
                    const updateRes = await updateReminderByQuery(ctx, updateQuery, message);
                    updateRes.botReaction = classification.details?.botReaction;
                    return updateRes;
                }

                await notifyProgress('reminder');
                const reminderRes = await safeStep('reminder', () => reminderAgent(
                    message, isForwarded, forwardFrom, messageHistory, enrichedContextFromMemory || ''
                ));
                if (reminderRes === null) return { responseText: 'Не удалось создать напоминание. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                if (reminderRes.reminderCreated) {
                    reminderRes.botReaction = classification.details?.botReaction;
                    if (!isLastStep) {
                        collectedResults.push(reminderRes);
                        break;
                    }
                    if (collectedResults.length > 0) {
                        collectedResults.push(reminderRes);
                        return mergeProcessingResults(collectedResults, classification.details?.botReaction as string | undefined);
                    }
                    return reminderRes;
                }
                if (nextStep?.agentId === 'conversation') break;
                reminderRes.botReaction = classification.details?.botReaction;
                return reminderRes;
            }

            case 'readMessages': {
                await notifyProgress('readMessages');
                const readRes = await safeStep('readMessages', () => readMessagesAgent(
                    ctx, message, isForwarded, forwardFrom, messageHistory, classification, enrichedContextFromMemory || '', voiceReplyRequested === true
                ));
                if (readRes === null) return { responseText: 'Не удалось прочитать сообщения. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                const passReadToNext = nextStep && (step.params?.asContext === true || hasMoreSteps(i));
                if (passReadToNext) {
                    enrichedContextFromMemory += '\nРезультат анализа переписки/чата:\n' + readRes.responseText + '\n\n';
                } else {
                    readRes.botReaction = classification.details?.botReaction;
                    return readRes;
                }
                break;
            }

            case 'sendMessage': {
                console.log("[ORCH] invoking sendMessagesAgent");
                await notifyProgress('sendMessage');
                const sendRes = await safeStep('sendMessage', () => sendMessagesAgent(
                    ctx, message, isForwarded, forwardFrom, messageHistory, enrichedContextFromMemory || ''
                ));
                if (sendRes === null) return { responseText: 'Не удалось подготовить сообщение. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                sendRes.botReaction = classification.details?.botReaction;
                if (!isLastStep) {
                    collectedResults.push(sendRes);
                    break;
                }
                if (collectedResults.length > 0) {
                    collectedResults.push(sendRes);
                    return mergeProcessingResults(collectedResults, classification.details?.botReaction as string | undefined);
                }
                return sendRes;
            }

            case 'negotiateOnBehalf': {
                console.log("[ORCH] invoking negotiateOnBehalfAgent");
                await notifyProgress('negotiateOnBehalf');
                const negRes = await safeStep('negotiateOnBehalf', () => negotiateOnBehalfAgent(
                    ctx, message, isForwarded, forwardFrom, messageHistory, enrichedContextFromMemory || ''
                ));
                if (negRes === null) return { responseText: 'Не удалось начать переговоры. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                negRes.botReaction = classification.details?.botReaction;
                return negRes;
            }

            case 'imageGeneration': {
                await notifyProgress('imageGeneration');
                const imgRes = await safeStep('imageGeneration', () => imageGenerationAgent(
                    message, isForwarded, forwardFrom, messageHistory, enrichedContextFromMemory || ''
                ));
                if (imgRes === null) return { responseText: 'Не удалось сгенерировать изображение. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                imgRes.botReaction = classification.details?.botReaction;
                return imgRes;
            }

            case 'maps': {
                await notifyProgress('maps');
                const mapsRes = await safeStep('maps', () => mapsAgent(
                    message, isForwarded, forwardFrom, messageHistory, lastLocation, enrichedContextFromMemory || ''
                ));
                if (mapsRes === null) return { responseText: 'Не удалось найти на карте. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                mapsRes.botReaction = classification.details?.botReaction;
                return mapsRes;
            }

            case 'unclearIntent': {
                await notifyProgress('unclearIntent');
                const unclearRes = await safeStep('unclearIntent', () => unclearIntentAgent(
                    message, isForwarded, forwardFrom, messageHistory, classification, enrichedContextFromMemory || ''
                ));
                if (unclearRes === null) return { responseText: 'Не смогла уточнить запрос. Попробуй сформулировать иначе 🙏', botReaction: classification.details?.botReaction };
                const keyboard = buildQuickChoiceKeyboard(ctx, message, unclearRes.responseText, classification);
                if (keyboard) unclearRes.keyboard = keyboard;
                unclearRes.botReaction = classification.details?.botReaction;
                return unclearRes;
            }

            case 'capabilities': {
                const capabilitiesText = await safeStep('capabilities', () => answerCapabilitiesQuestion(message, {
                    publicMode: ctx.chat?.type !== 'private' && !ctx.session?.isAllowedUser,
                }));
                return {
                    responseText: capabilitiesText ?? getCapabilitiesMessage(),
                    botReaction: classification.details?.botReaction,
                };
            }

            case 'selfStudy': {
                await notifyProgress('selfStudy');
                const selfStudyRes = await safeStep('selfStudy', () => selfStudyAgent(
                    ctx, message, messageHistory, enrichedContextFromMemory || ''
                ));
                if (selfStudyRes === null) return { responseText: 'Не удалось провести самоизучение. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                selfStudyRes.botReaction = classification.details?.botReaction;
                return selfStudyRes;
            }

            case 'browserTask': {
                console.log('[ORCH] invoking browserAgent');
                // Прогресс-уведомление не нужно — агент сам шлёт обновления по шагам
                const browserRes = await safeStep('browserTask', () => browserAgent(
                    ctx, message, isForwarded, forwardFrom, messageHistory, classification, enrichedContextFromMemory || ''
                ));
                if (browserRes === null) return { responseText: 'Не удалось выполнить задачу в браузере. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                browserRes.botReaction = classification.details?.botReaction;
                return browserRes;
            }

            case 'health': {
                await notifyProgress('health');
                const healthRes = await safeStep('health', () => healthAgent(
                    ctx, message, isForwarded, forwardFrom, messageHistory
                ));
                if (healthRes === null) return { responseText: 'Не удалось обработать дневник здоровья. Попробуй ещё раз 🙏', botReaction: classification.details?.botReaction };
                healthRes.botReaction = classification.details?.botReaction;
                return healthRes;
            }

            default:
                devLog('Executor: unknown agentId', (step as PlanStep).agentId);
                return { responseText: 'Неизвестный тип задачи. Попробуй сформулировать иначе.' };
        }
    }

    // Если в составном плане накоплены результаты нескольких terminal-шагов — объединяем и возвращаем.
    if (collectedResults.length > 0) {
        return mergeProcessingResults(collectedResults, classification.details?.botReaction as string | undefined);
    }

    // План выполнен, но ни один шаг не вернул ответ (только memory/resolveContact). Логируем и пробуем conversation как fallback.
    const stepIds = steps.map((s) => s.agentId);
    console.warn('[ORCH] executor: no response from plan steps:', stepIds.join(' → '), '| fallback to conversation');
    const sharedMemoryContext = enrichedContextFromMemory.trim()
        ? { domain: 'personal' as const, context: enrichedContextFromMemory.trim() }
        : await fetchAgentMemoryContext(ctx, message).then((m) => ({ domain: m.domain as 'personal', context: m.context }));
    const conv = await conversationAgent(
        ctx,
        message,
        isForwarded,
        forwardFrom,
        messageHistory,
        classification,
        sharedMemoryContext
    );
    conv.botReaction = classification.details?.botReaction;
    return conv;
}
