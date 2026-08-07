import { Bot, InlineKeyboard } from "grammy";
import { Chat, User } from "grammy/types";
import { Reminder, postponeReminderUntil } from "../reminder";
import { BotContext, ConversationTurn } from "../types";
import { processMessage } from "../orchestrator";
import { getMessageDraft, saveMessageDraft } from "../agents/sendMessagesAgent";
import {
    NegotiationStore,
    buildNegotiationSummaryText,
    buildNegotiationStopKeyboard,
} from "../stores/NegotiationStore";
import { initTelegramClient, sendMessage as sendTelegramMessage } from "../services/telegram";
import { devLog } from "../utils";
import { addToHistory } from "../utils/history";
import { ContactsStore } from "../stores/ContactsStore";
import { ReminderRegistry } from "../stores/ReminderRegistry";
import { reconsolidateAfterResponse } from "../services/MemoryReconsolidationService";
import { looksLikeBrowserTaskCancellation } from "../utils/browserTaskCancellation";
import { applyReminderEditInput, extractReminderPostponeDate } from "../utils/reminderEditor";
import { stripVoiceReplyDirective, wantsVoiceReply } from "../utils/voiceReply";
import { editMessageTextIfChanged } from "../utils/telegramMessageEdit";
import { normalizeNumbersForVoiceMessage } from "../utils/russianSpeechNumbers";
import { syncReminderMemoryMutation } from "../services/ReminderMemorySync";
import { getBotGenderedText } from "../persona";
import {
    commitImplicitReminderCandidate,
    detectImplicitReminderCandidate,
} from "../utils/implicitReminderDetector";
import { commitMemoryGapCandidate, detectMemoryGapCandidate } from "../utils/memoryGapDetector";
import { detectCurrentConversationTopic } from '../utils/conversationTopic';
import {
    commitProactiveHintCandidate,
    maybeProactiveHint,
    ProactiveHintCandidate,
} from "../utils/proactiveMemory";
import { decideKnowledgeSource } from "../utils/knowledgeSource";
import { handleRecurringTaskText } from "../services/recurringTaskService";
import { getForwardedMessageInfo } from "../utils/forwardedMessage";
import {
    MEMORY_HEARS_RE,
    MEMORY_DELETE_RE,
    resolveReplyTo,
    replyAndStore,
    maybeReactToUser,
    saveRemindersFromResult,
    sendResultToUser,
    checkLastFactSaveError,
    shouldRunProactiveHint,
    storeSentMessageContext,
    flushSessionAfterAsyncWork,
} from "./shared";

// ── Консолидация инициализации группы пересланных сообщений ─

function initOrReuseForwardGroup(
    ctx: BotContext,
    forwardSource: string,
    message: string,
    currentTime: number,
    initialUserMessages: string[],
): void {
    if (!ctx.session.forwardGroups) {
        ctx.session.forwardGroups = {};
    }

    const forwardKey = "current_forward_group";

    if (!ctx.session.forwardGroups[forwardKey]) {
        ctx.session.forwardGroups[forwardKey] = {
            messages: [],
            sources: {},
            lastTime: currentTime,
            timerId: null,
            userMessages: initialUserMessages,
        };
    }

    if (!ctx.session.forwardGroups[forwardKey].sources[forwardSource]) {
        ctx.session.forwardGroups[forwardKey].sources[forwardSource] = [];
    }
    ctx.session.forwardGroups[forwardKey].sources[forwardSource].push(message);
    ctx.session.forwardGroups[forwardKey].lastTime = currentTime;

    if (ctx.session.forwardGroups[forwardKey].timerId) {
        clearTimeout(ctx.session.forwardGroups[forwardKey].timerId);
    }

    const timerId = setTimeout(() => {
        processForwardedGroup(ctx, forwardKey);
    }, 2000);

    ctx.session.forwardGroups[forwardKey].timerId = timerId;
}

// ── Обработка группы пересланных сообщений ─────────────────

async function processForwardedGroup(ctx: BotContext, forwardKey: string) {
    if (!ctx.chat || !ctx.session.forwardGroups) {
        return;
    }

    try {
        const group = ctx.session.forwardGroups[forwardKey];
        if (!group) return;

        const sources = group.sources || {};
        const userMessages = group.userMessages || [];

        if (Object.keys(sources).length === 0 && userMessages.length === 0) {
            devLog("Пустая группа сообщений, нечего обрабатывать");
            delete ctx.session.forwardGroups[forwardKey];
            return;
        }

        // Проверка на наличие первого сообщения пользователя в истории
        const recentUserMessage = ctx.session.messageHistory.find(msg =>
            msg.role === 'user' &&
            !msg.content.startsWith('[Пересланный тред сообщений]') &&
            !msg.content.startsWith('[Пересланные сообщения') &&
            new Date().getTime() - new Date(msg.timestamp).getTime() < 5000
        );

        if (recentUserMessage && !userMessages.includes(recentUserMessage.content)) {
            ctx.session.messageHistory = ctx.session.messageHistory.filter(
                msg => msg !== recentUserMessage
            );

            if (userMessages.length === 0) {
                userMessages.push(recentUserMessage.content);
            }
        }

        const forwardText = Object.entries(sources)
            .flatMap(([source, messages]) => messages.map(text => `${source}: ${text}`))
            .join('\n');
        const forwardedTurn: ConversationTurn = {
            userText: userMessages.join(' ').trim() || 'Пересланное сообщение',
            isForwardOnly: userMessages.length === 0,
            forwardContext: {
                sender: Object.keys(sources).join(', ') || 'неизвестный источник',
                text: forwardText,
            },
        };
        // В обычной user-history хранится только новая реплика владельца. Сам
        // пересланный материал передаётся отдельно и не участвует в извлечении
        // фактов как будто это слова пользователя.
        await addToHistory(ctx, 'user', forwardedTurn.userText, { turn: forwardedTurn });
        await ctx.api.sendChatAction(ctx.chat.id, "typing");
        devLog("Обработка пересланного треда:", { userText: forwardedTurn.userText, forwardText });

        const result = await processMessage(
            ctx,
            forwardedTurn.userText,
            true,
            "треда сообщений",
            ctx.session.messageHistory.slice().reverse(),
            undefined,
            { turn: forwardedTurn },
        );

        await saveRemindersFromResult(ctx, result);
        await addToHistory(ctx, 'bot', result.responseText);

        // Единая отправка результата
        await sendResultToUser(ctx, result);

        await checkLastFactSaveError(ctx);

        delete ctx.session.forwardGroups[forwardKey];

    } catch (error) {
        console.error("Ошибка при обработке группы пересланных сообщений:", error);
        await ctx.reply("Произошла ошибка при обработке пересланных сообщений. Пожалуйста, попробуйте еще раз.");

        if (ctx.session.forwardGroups) {
            delete ctx.session.forwardGroups[forwardKey];
        }
    }
}

async function processForwardedTextMessage(
    ctx: BotContext,
    message: string,
    forwardSource: string,
): Promise<void> {
    const currentTime = Date.now();
    if (ctx.session.lastUserMessage &&
        !ctx.session.lastUserMessage.processed &&
        (currentTime - ctx.session.lastUserMessage.timestamp < 5000)) {
        ctx.session.lastUserMessage.processed = true;
        initOrReuseForwardGroup(ctx, forwardSource, message, currentTime, [ctx.session.lastUserMessage.text]);
        return;
    }

    initOrReuseForwardGroup(ctx, forwardSource, message, currentTime, []);
}

/**
 * Forwarded text must be handled before command/hears middleware.
 * Intentionally does NOT call next() — forwarded content is not
 * authored by the owner and must not reach commands, memory hears,
 * draft editing, or any other owner-intent handlers.
 */
export function registerForwardedTextGuard(bot: Bot<BotContext>): void {
    bot.on("message:text", async (ctx, next) => {
        const { isForwarded, source } = getForwardedMessageInfo(ctx.message);
        if (!isForwarded) {
            await next();
            return;
        }

        await processForwardedTextMessage(ctx, ctx.message.text, source);
    });
}

// ── Регистрация обработчика текстовых сообщений ───────────

export function registerTextMessageHandler(bot: Bot<BotContext>): void {
    bot.on("message:text", async (ctx, next) => {
        try {
            devLog('📨 Получено текстовое сообщение от пользователя:', ctx.from?.id);
            const message = ctx.message.text;
            const currentTime = Date.now();
            const { isForwarded, source: forwardSource } = getForwardedMessageInfo(ctx.message);

            // Пересланное содержимое нельзя пропускать через команды,
            // редактирование черновика или memory handlers: оно не является
            // словами владельца.
            if (isForwarded) {
                await processForwardedTextMessage(ctx, message, forwardSource);
                return;
            }

            if (message.startsWith('/')) {
                await next();
                return;
            }

            // These messages are handled by dedicated bot.hears handlers in memoryCommands
            if (MEMORY_HEARS_RE.test(message) || MEMORY_DELETE_RE.test(message)) {
                return;
            }

            if (ctx.session.messageEditing && ctx.chat) {
                ctx.session.messageEditing = false;
                const draft = getMessageDraft(ctx.chat.id);
                if (!draft) {
                    await replyAndStore(ctx, "❌ Черновик сообщения не найден или устарел. Создай сообщение заново.");
                    return;
                }
                const preparedMessage = draft.deliveryMode === "voice"
                    ? normalizeNumbersForVoiceMessage(message)
                    : message;

                saveMessageDraft(
                    ctx.chat.id,
                    draft.contactId,
                    preparedMessage,
                    draft.scheduledTime,
                    draft.notifyOnReply,
                    draft.isGroup ?? false,
                    draft.groupTitle,
                    draft.deliveryMode
                );

                const confirmKeyboard = new InlineKeyboard()
                    .text("✅ Отправить", "send_message")
                    .text("✏️ Изменить текст", "edit_message");

                if (!draft.isGroup) {
                    if (draft.deliveryMode === "text") {
                        confirmKeyboard
                            .row()
                            .text("🕒 Изменить время", "change_time")
                            .text(draft.notifyOnReply ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify");
                    } else {
                        confirmKeyboard
                            .row()
                            .text(draft.notifyOnReply ? "🔔 Выкл. уведомления" : "🔕 Вкл. уведомления", "toggle_notify");
                    }
                }

                confirmKeyboard
                    .row()
                    .text("❌ Отмена", "cancel_message");

                const contactsStore = ContactsStore.getInstance();
                const contact = draft.isGroup ? null : contactsStore.getContact(draft.contactId);
                const recipientLabel = draft.isGroup
                    ? `группы «${draft.groupTitle || draft.contactId}»`
                    : `${contact?.firstName || "контакта"} ${contact?.lastName || ""} ${contact?.username ? '(@' + contact.username + ')' : ''}`.trim();
                const scheduledTimeDisplay = draft.scheduledTime
                    ? draft.scheduledTime.toLocaleString('ru-RU', {
                        day: 'numeric',
                        month: 'long',
                        hour: 'numeric',
                        minute: 'numeric'
                    })
                    : "сейчас";
                const notifyIndicator = draft.notifyOnReply ?
                    "✅ С уведомлением о получении ответа" :
                    "❌ Без уведомления о получении ответа";

                await replyAndStore(ctx,
                    `📤 Обновлено ${draft.deliveryMode === "voice" ? "голосовое сообщение" : "сообщение"} для ${recipientLabel}:\n\n` +
                    `"${preparedMessage}"\n\n` +
                    `Формат: ${draft.deliveryMode === "voice" ? "голосовое сообщение, с представлением ассистента в начале" : "текстовое сообщение"}\n` +
                    `Время отправки: ${scheduledTimeDisplay}\n` +
                    `${draft.isGroup ? "" : `${notifyIndicator}\n`}\n` +
                    `Подтверди отправку или внеси изменения:`,
                    { reply_markup: confirmKeyboard }
                );
                return;
            }

            // Ожидаем ответ пользователя для активной сессии переговоров (бот вёл переписку от его имени)
            const negotiationSession = NegotiationStore.getByChatId(ctx.chat!.id);
            if (negotiationSession?.waitingForUserReply) {
                const trimmed = message.trim().toLowerCase();
                if (trimmed === "отмена" || trimmed === "отмена переговоров") {
                    const { summaryChatId, summaryMessageId, contactName } = negotiationSession;
                    NegotiationStore.delete(negotiationSession.originalChatId, negotiationSession.contactId);
                    if (summaryChatId != null && summaryMessageId != null) {
                        await editMessageTextIfChanged(ctx.api,
                            summaryChatId,
                            summaryMessageId,
                            `📩 Переговоры с ${contactName} отменены.`,
                            { reply_markup: { inline_keyboard: [] } }
                        ).catch((error) => console.error("[telegram-edit] negotiation cancellation summary update failed:", error));
                    }
                    await replyAndStore(ctx, "Переговоры отменены.");
                    return;
                }
                const client = await initTelegramClient();
                if (client) {
                    const sent = await sendTelegramMessage(client, negotiationSession.contactId, message, true, ctx.chat!.id);
                    if (sent.success) {
                        negotiationSession.history.push({ role: "user", text: message, at: new Date() });
                        negotiationSession.waitingForUserReply = false;
                        NegotiationStore.update(negotiationSession.originalChatId, negotiationSession.contactId, {
                            history: negotiationSession.history,
                            waitingForUserReply: false,
                        });
                        if (negotiationSession.summaryChatId != null && negotiationSession.summaryMessageId != null) {
                            const summaryText = buildNegotiationSummaryText(negotiationSession);
                            await NegotiationStore.editSummary(
                                negotiationSession.summaryChatId,
                                negotiationSession.summaryMessageId,
                                summaryText,
                                buildNegotiationStopKeyboard()
                            ).catch((error) => console.error("[telegram-edit] negotiation summary update failed:", error));
                        }
                        await replyAndStore(ctx, "Отправлено.");
                    } else {
                        await replyAndStore(ctx, "Не удалось отправить сообщение контакту. Попробуй ещё раз.");
                    }
                } else {
                    await replyAndStore(ctx, "Нет связи с Telegram. Попробуй позже.");
                }
                return;
            }

            // Сохраняем последнее сообщение пользователя для возможного объединения с последующими пересланными
            ctx.session.lastUserMessage = {
                text: message,
                timestamp: currentTime,
                processed: false
            };

            // Определяем контекст ответа (reply_to)
            const { replyContext } = resolveReplyTo(ctx);

            if (ctx.session.activePersonContext && ctx.session.activePersonContext.expiresAt <= Date.now()) {
                ctx.session.activePersonContext = undefined;
            }
            if (replyContext?.contactId || replyContext?.personId) {
                ctx.session.activePersonContext = {
                    contactId: replyContext.contactId,
                    contactName: replyContext.contactName,
                    personId: replyContext.personId,
                    expiresAt: Date.now() + 30 * 60 * 1000,
                };
            }
            const activePerson = ctx.session.activePersonContext;
            const pendingGap = ctx.session.pendingMemoryGap && ctx.session.pendingMemoryGap.expiresAt > Date.now()
                ? ctx.session.pendingMemoryGap
                : undefined;
            if (ctx.session.pendingMemoryGap && !pendingGap) ctx.session.pendingMemoryGap = undefined;
            const inheritedTopic = ctx.session.workingMemory?.activeTopics?.[0];
            const detectedTopic = detectCurrentConversationTopic(message, inheritedTopic);

            const turn: ConversationTurn = {
                userText: message,
                replyContext,
                activePeople: pendingGap && !replyContext?.contactId && !replyContext?.personId ? [{
                    contactName: pendingGap.contactName,
                }] : activePerson ? [{
                    contactId: activePerson.contactId,
                    contactName: activePerson.contactName,
                    personId: activePerson.personId,
                }] : undefined,
                currentTopic: detectedTopic,
            };
            // Reply-контекст не склеиваем с новой репликой: delayed extraction и
            // summaries должны видеть только слова пользователя.
            const recurringContextHistory = ctx.session.messageHistory
                .slice(0, 8)
                .reverse()
                .map(({ role, content }) => ({ role, content: content.slice(0, 2_000) }));
            await addToHistory(ctx, 'user', message, { turn });
            if (pendingGap) ctx.session.pendingMemoryGap = undefined;

            // Устанавливаем таймер для обработки одиночного сообщения
            setTimeout(async () => {
                try {
                if (ctx.session.lastUserMessage &&
                    ctx.session.lastUserMessage.text === message &&
                    !ctx.session.lastUserMessage.processed) {

                    ctx.session.lastUserMessage.processed = true;

                    if (ctx.session.pendingReminderEdit) {
                        const pending = ctx.session.pendingReminderEdit;
                        const isCancel = /^(отмена|отмени|не надо|стоп|cancel)$/iu.test(message.trim());
                        if (isCancel) {
                            ctx.session.pendingReminderEdit = undefined;
                            await ctx.reply('Ок, редактирование напоминания отменено.');
                            return;
                        }

                        if (pending.expiresAt <= Date.now()) {
                            ctx.session.pendingReminderEdit = undefined;
                            await ctx.reply('Время редактирования вышло. Открой /reminders и нажми «Изменить» ещё раз.');
                            return;
                        }

                        const reminder = ReminderRegistry.getInstance().get(pending.reminderId);
                        if (!reminder) {
                            ctx.session.pendingReminderEdit = undefined;
                            await ctx.reply(getBotGenderedText(
                                "Не нашла это напоминание.",
                                "Не нашёл это напоминание.",
                            ) + " Возможно, оно уже выполнено или отменено.");
                            return;
                        }

                        const editResult = await applyReminderEditInput(ctx, reminder, message);
                        if (!editResult.ok || !editResult.reminder) {
                            await ctx.reply(editResult.responseText);
                            return;
                        }

                        ctx.session.pendingReminderEdit = undefined;
                        const sessIdx = ctx.session.reminders.findIndex(r => r.id === editResult.reminder!.id);
                        if (sessIdx >= 0) ctx.session.reminders[sessIdx] = editResult.reminder;
                        await ctx.reply(editResult.responseText);
                        return;
                    }

                    // Кастомное время для переноса напоминания
                    if (ctx.session.pendingPostpone) {
                        const pending = ctx.session.pendingPostpone;
                        const { reminderId } = pending;
                        const isCancel = /^(отмена|отмени|не надо|стоп|cancel)$/iu.test(message.trim());
                        if (isCancel) {
                            ctx.session.pendingPostpone = undefined;
                            await ctx.reply('Ок, перенос напоминания отменён.');
                            return;
                        }

                        if (pending.expiresAt != null && pending.expiresAt <= Date.now()) {
                            ctx.session.pendingPostpone = undefined;
                            await ctx.reply('Время переноса вышло. Открой /reminders и нажми «Отложить» ещё раз.');
                            return;
                        }

                        ctx.session.pendingPostpone = undefined;
                        const reminder = ReminderRegistry.getInstance().get(reminderId);
                        if (reminder) {
                            const parsed = await extractReminderPostponeDate(reminder, message);
                            if (!parsed.ok || !parsed.dueDate) {
                                await ctx.reply(parsed.responseText);
                                ctx.session.pendingPostpone = pending;
                                return;
                            }

                            const previousReminder: Reminder = { ...reminder, dueDate: new Date(reminder.dueDate) };
                            const updated = await postponeReminderUntil(bot, reminder, parsed.dueDate);
                            if (!updated) {
                                await ctx.reply(getBotGenderedText(
                                    "Не смогла перенести напоминание.",
                                    "Не смог перенести напоминание.",
                                ) + " Попробуй ещё раз.");
                                ctx.session.pendingPostpone = pending;
                                return;
                            }

                            ReminderRegistry.getInstance().add(updated);
                            const sessIdx = ctx.session.reminders.findIndex(r => r.id === reminderId);
                            if (sessIdx >= 0) ctx.session.reminders[sessIdx] = updated;
                            await syncReminderMemoryMutation(ctx, previousReminder, updated, 'postpone').catch((e) =>
                                console.error('[reminder] memory sync failed on custom postpone:', e)
                            );
                            await ctx.reply(parsed.responseText);
                        }
                        return;
                    }

                    if (await handleRecurringTaskText(ctx, message, {
                        messageId: ctx.message.message_id,
                        contextHistory: recurringContextHistory,
                    })) {
                        return;
                    }

                    let messageForProcessing = message;
                    const pendingBrowserTask = ctx.session.pendingBrowserTask;
                    if (pendingBrowserTask) {
                        if (Date.now() > pendingBrowserTask.expiresAt) {
                            if (pendingBrowserTask.sessionId) {
                                import('../agents/browserAgent')
                                    .then((m) => m.cancelPausedBrowserSession(pendingBrowserTask.sessionId))
                                    .catch(() => {});
                            }
                            ctx.session.pendingBrowserTask = undefined;
                        } else {
                            if (looksLikeBrowserTaskCancellation(message)) {
                                if (pendingBrowserTask.sessionId) {
                                    import('../agents/browserAgent')
                                        .then((m) => m.cancelPausedBrowserSession(pendingBrowserTask.sessionId))
                                        .catch(() => {});
                                }
                                ctx.session.pendingBrowserTask = undefined;
                                await replyAndStore(ctx, 'Браузерная задача отменена.');
                                return;
                            }

                            pendingBrowserTask.userAnswer = message;
                            messageForProcessing = [
                                'Продолжи задачу в браузере через Playwright.',
                                `browserSessionId: ${pendingBrowserTask.sessionId ?? 'none'}`,
                                `Исходная задача пользователя: ${pendingBrowserTask.originalTask}`,
                                `Вопрос агента пользователю: ${pendingBrowserTask.question}`,
                                `Ответ пользователя: ${message}`,
                                'Используй ответ как недостающий параметр, подтяни долговременную память как обычно и продолжи выполнение.',
                            ].join('\n');
                        }
                    }

                    let voiceReplyRequested = false;
                    if (messageForProcessing === message && wantsVoiceReply(message)) {
                        voiceReplyRequested = true;
                        messageForProcessing = stripVoiceReplyDirective(messageForProcessing);
                    }

                    await ctx.api.sendChatAction(ctx.chat.id, "typing");

                    const result = await processMessage(
                        ctx,
                        messageForProcessing,
                        false,
                        "",
                        ctx.session.messageHistory.slice().reverse(),
                        undefined,
                        { voiceReplyRequested: voiceReplyRequested, turn }
                    );

                    await saveRemindersFromResult(ctx, result);

                    // Один follow-up включается в тот же ответ, а не прилетает
                    // отдельным fire-and-forget сообщением после него.
                    let identityGapCandidate: Awaited<ReturnType<typeof detectMemoryGapCandidate>>;
                    let proactiveCandidate: ProactiveHintCandidate | undefined;
                    if (
                        shouldRunProactiveHint(result, messageForProcessing) &&
                        !decideKnowledgeSource(message, turn.replyContext, turn.currentTopic).requiresWeb &&
                        !result.keyboard &&
                        !ctx.session.pendingContactMemory
                    ) {
                        const identityCandidate = turn.replyContext?.contactId
                            ? undefined
                            : await detectMemoryGapCandidate(ctx, message).catch(() => undefined);
                        if (identityCandidate) {
                            identityGapCandidate = identityCandidate;
                            result.responseText = `${result.responseText}\n\n${identityCandidate.question}`;
                        } else {
                            const reminderCandidate = await detectImplicitReminderCandidate(ctx, message).catch(() => undefined);
                            if (reminderCandidate) {
                                commitImplicitReminderCandidate(ctx, reminderCandidate);
                                result.responseText = `${result.responseText}\n\nХочешь, поставлю напоминание на «${reminderCandidate.eventSummary}»?`;
                                result.keyboard = new InlineKeyboard()
                                    .text('⏰ Создать напоминание', 'implicit_reminder_yes')
                                    .text('Не сейчас', 'implicit_reminder_no');
                            } else {
                                proactiveCandidate = await maybeProactiveHint(
                                    ctx,
                                    message,
                                    result.responseText,
                                    { delivery: 'candidate' },
                                ).catch(() => undefined) as ProactiveHintCandidate | undefined;
                                if (proactiveCandidate?.hint) {
                                    result.responseText = `${result.responseText}\n\n${proactiveCandidate.hint}`;
                                }
                            }
                        }
                    }

                    if (result.negotiationSummarySent) {
                        await addToHistory(ctx, 'bot', '[Переговоры запущены — см. сообщение выше]');
                        maybeReactToUser(ctx, result.botReaction);
                        return;
                    }

                    await addToHistory(ctx, 'bot', result.responseText);

                    // Единая отправка результата вместо дублированного if/else
                    const sentResult = await sendResultToUser(ctx, result, voiceReplyRequested);
                    ctx.session.lastSchedulableRequest = {
                        text: pendingBrowserTask?.originalTask ?? message,
                        messageId: ctx.message.message_id,
                        contextHistory: recurringContextHistory,
                        createdAt: Date.now(),
                    };
                    if (identityGapCandidate && sentResult?.message_id) {
                        commitMemoryGapCandidate(ctx, identityGapCandidate, sentResult.message_id);
                        storeSentMessageContext(ctx, sentResult.message_id, result.responseText, {
                            kind: 'identity_gap',
                            contactName: identityGapCandidate.name,
                        });
                    }
                    if (proactiveCandidate && sentResult?.message_id) {
                        commitProactiveHintCandidate(ctx, proactiveCandidate, sentResult.message_id);
                        storeSentMessageContext(ctx, sentResult.message_id, result.responseText, {
                            kind: 'proactive',
                            contactId: proactiveCandidate.contactId,
                            contactName: proactiveCandidate.contactName,
                            personId: proactiveCandidate.personId,
                            memoryIds: proactiveCandidate.sourceMemoryIds,
                            proactiveInsight: ctx.session.lastProactiveInsight,
                        });
                    }

                    maybeReactToUser(ctx, result.botReaction);
                    await checkLastFactSaveError(ctx);

                    // Reconsolidation
                    reconsolidateAfterResponse(ctx, message, result.responseText, result.recalledMemories, turn).catch(() => {});
                }
                } catch (timerError) {
                    console.error("Ошибка при обработке сообщения в setTimeout:", timerError);
                    try { await ctx.reply("Что-то пошло не так при обработке... Попробуй ещё раз? 💫"); } catch {}
                } finally {
                    await flushSessionAfterAsyncWork(ctx, 'message:text delayed processing');
                }
            }, 2000);
        } catch (error) {
            console.error("Ошибка при обработке сообщения:", error);
            await ctx.reply("Что-то пошло не так... Давай попробуем еще раз? 💫");
        }
    });
}

// Расширяем тип Message для поддержки пересланных сообщений
declare module "grammy/types" {
    interface Message {
        forward_from?: User;
        forward_from_chat?: Chat;
        forward_sender_name?: string;
        reply_to_message?: import("grammy/types").Message;
    }
}
