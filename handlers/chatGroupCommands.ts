import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../types';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { ChatGroupEntity } from '../entity/ChatGroupEntity';
import { notifyChatGroupTrackerChange } from '../services/chatGroupTracker';
import { config } from '../config';
import { esc, heading, list, paragraph, footer, RichBlock, sendStructured, editStructuredCtx } from '../utils/richMessage';

const ITEMS_PER_PAGE = 5;

function buildMainMenu(groups: ChatGroupEntity[], page = 0): { blocks: RichBlock[]; keyboard: InlineKeyboard } {
    const total = groups.length;
    const start = page * ITEMS_PER_PAGE;
    const pageGroups = groups.slice(start, start + ITEMS_PER_PAGE);

    const blocks: RichBlock[] = [heading('📂 Группы чатов', 3)];
    if (total === 0) {
        blocks.push(paragraph('Группы ещё не созданы.'));
    } else {
        pageGroups.forEach((g, i) => {
            blocks.push(heading(`${start + i + 1}. ${esc(g.name)}`, 4));
            if (g.chatNames.length > 0) {
                blocks.push(list(g.chatNames.map(c => esc(c))));
            }
        });
    }

    const kb = new InlineKeyboard();

    pageGroups.forEach(g => {
        kb.text(`✏️ ${g.name}`, `cg:edit:${g.id}`).text(`🗑️`, `cg:del:${g.id}`).row();
    });

    // Пагинация
    const totalPages = Math.ceil(total / ITEMS_PER_PAGE);
    if (totalPages > 1) {
        if (page > 0) kb.text('◀️', `cg:page:${page - 1}`);
        kb.text(`${page + 1}/${totalPages}`, 'cg:noop');
        if (page < totalPages - 1) kb.text('▶️', `cg:page:${page + 1}`);
        kb.row();
    }

    kb.text('➕ Новая группа', 'cg:new').row();

    return { blocks, keyboard: kb };
}

function buildGroupDetailMenu(group: ChatGroupEntity): { blocks: RichBlock[]; keyboard: InlineKeyboard } {
    const trackingLabel = group.isTracking ? '🔕 Отслеживание: вкл' : '📡 Отслеживать';
    const blocks: RichBlock[] = [
        heading(`✏️ ${esc(group.name)}`, 3),
        paragraph('<b>Чаты:</b>'),
    ];
    if (group.chatNames.length > 0) {
        blocks.push(list(group.chatNames.map((c, i) => `${i + 1}. ${esc(c)}`), true));
    } else {
        blocks.push(paragraph('В группе пока нет чатов.'));
    }
    if (group.isTracking) {
        blocks.push(footer(`📡 Умное отслеживание активно — ${esc(config.characterName)} уведомит о важных сообщениях`));
    }
    blocks.push(paragraph('Что сделать?'));

    const kb = new InlineKeyboard()
        .text('➕ Добавить чат', `cg:addchat:${group.id}`).row()
        .text('➖ Удалить чат', `cg:rmchat:${group.id}`).row()
        .text('🔁 Переименовать', `cg:rename:${group.id}`).row()
        .text(trackingLabel, `cg:track:${group.id}`).row()
        .text('🗑️ Удалить группу', `cg:del:${group.id}`).row()
        .text('◀️ Назад', 'cg:back').row();

    return { blocks, keyboard: kb };
}

export function registerChatGroupCommands(bot: Bot<BotContext>) {

    // ── Команда /chatgroups ────────────────────────────────────────────────────
    bot.command('chatgroups', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId) return;
        delete ctx.session.chatGroupState;

        const groups = await ChatGroupRepository.findAll(chatId);
        const { blocks, keyboard } = buildMainMenu(groups);
        await sendStructured(ctx.api as any, chatId, blocks, { replyMarkup: keyboard });
    });

    // ── Callback: quick-save после inline-анализа нескольких чатов ───────────
    bot.callbackQuery('cg:quicksave', async (ctx) => {
        await ctx.answerCallbackQuery();
        const pending = ctx.session.chatGroupState?.pendingChatNames;
        if (!pending?.length) {
            await ctx.reply('Нет чатов для сохранения. Используй /chatgroups чтобы создать группу вручную.');
            return;
        }
        ctx.session.chatGroupState = { step: 'awaiting_name', pendingChatNames: pending };
        const list = pending.map(c => `• ${c}`).join('\n');
        await ctx.reply(`Введи название для новой группы с этими чатами:\n\n${list}`);
    });

    // ── Callback: пагинация ────────────────────────────────────────────────────
    bot.callbackQuery(/^cg:page:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const page = parseInt(ctx.match[1]);
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const groups = await ChatGroupRepository.findAll(chatId);
        const { blocks, keyboard } = buildMainMenu(groups, page);
        await editStructuredCtx(ctx, blocks, { replyMarkup: keyboard });
    });

    // ── Callback: noop (заголовок пагинации) ──────────────────────────────────
    bot.callbackQuery('cg:noop', async (ctx) => { await ctx.answerCallbackQuery(); });

    // ── Callback: назад в список ──────────────────────────────────────────────
    bot.callbackQuery('cg:back', async (ctx) => {
        await ctx.answerCallbackQuery();
        const chatId = ctx.chat?.id;
        if (!chatId) return;
        delete ctx.session.chatGroupState;

        const groups = await ChatGroupRepository.findAll(chatId);
        const { blocks, keyboard } = buildMainMenu(groups);
        await editStructuredCtx(ctx, blocks, { replyMarkup: keyboard });
    });

    // ── Callback: новая группа ────────────────────────────────────────────────
    bot.callbackQuery('cg:new', async (ctx) => {
        await ctx.answerCallbackQuery();
        ctx.session.chatGroupState = { step: 'awaiting_name' };
        await ctx.reply('Введи название новой группы (например: Рабочие чаты)');
    });

    // ── Callback: открыть детали группы для редактирования ────────────────────
    bot.callbackQuery(/^cg:edit:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const groups = await ChatGroupRepository.findAll(chatId);
        const group = groups.find(g => g.id === id);
        if (!group) { await ctx.answerCallbackQuery('Группа не найдена'); return; }

        const { blocks, keyboard } = buildGroupDetailMenu(group);
        await editStructuredCtx(ctx, blocks, { replyMarkup: keyboard });
    });

    // ── Callback: удалить группу ──────────────────────────────────────────────
    bot.callbackQuery(/^cg:del:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        await ChatGroupRepository.delete(id);

        const chatId = ctx.chat?.id;
        if (!chatId) return;
        const groups = await ChatGroupRepository.findAll(chatId);
        const { blocks, keyboard } = buildMainMenu(groups);
        await editStructuredCtx(ctx, blocks, { replyMarkup: keyboard });
    });

    // ── Callback: добавить чат в группу ───────────────────────────────────────
    bot.callbackQuery(/^cg:addchat:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const groups = await ChatGroupRepository.findAll(chatId);
        const group = groups.find(g => g.id === id);
        if (!group) return;

        ctx.session.chatGroupState = { step: 'awaiting_chats', editGroupId: id, editGroupName: group.name };
        await ctx.reply(
            `Перечисли названия чатов, которые хочешь добавить в группу «${group.name}», через запятую или с новой строки:`
        );
    });

    // ── Callback: удалить чат из группы ───────────────────────────────────────
    bot.callbackQuery(/^cg:rmchat:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const groups = await ChatGroupRepository.findAll(chatId);
        const group = groups.find(g => g.id === id);
        if (!group) return;

        if (group.chatNames.length === 0) {
            await ctx.answerCallbackQuery('В группе нет чатов');
            return;
        }

        ctx.session.chatGroupState = { step: 'awaiting_remove_chat', editGroupId: id, editGroupName: group.name };

        const listItems = group.chatNames.map((c, i) => `${i + 1}. ${esc(c)}`);
        const blocks: RichBlock[] = [
            paragraph(`Напиши номер или название чата, который хочешь убрать из «${esc(group.name)}»:`),
            list(listItems, true),
        ];
        await sendStructured(ctx.api as any, chatId, blocks);
    });

    // ── Callback: включить/выключить отслеживание ─────────────────────────────
    bot.callbackQuery(/^cg:track:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const isNowTracking = await ChatGroupRepository.toggleTracking(id);
        notifyChatGroupTrackerChange();

        const groups = await ChatGroupRepository.findAll(chatId);
        const group = groups.find(g => g.id === id);
        if (!group) return;

        const statusBlocks: RichBlock[] = isNowTracking
            ? [
                paragraph(`✅ Умное отслеживание для группы «${esc(group.name)}» <b>включено</b>.`),
                paragraph(`${esc(config.characterName)} будет присылать уведомления о важных сообщениях в личный чат.`),
            ]
            : [paragraph(`🔕 Отслеживание для группы «${esc(group.name)}» <b>выключено</b>.`)];

        await sendStructured(ctx.api as any, chatId, statusBlocks);

        const { blocks, keyboard } = buildGroupDetailMenu(group);
        await editStructuredCtx(ctx, blocks, { replyMarkup: keyboard });
    });

    // ── Callback: переименовать группу ────────────────────────────────────────
    bot.callbackQuery(/^cg:rename:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        const chatId = ctx.chat?.id;
        if (!chatId) return;

        const groups = await ChatGroupRepository.findAll(chatId);
        const group = groups.find(g => g.id === id);
        if (!group) return;

        ctx.session.chatGroupState = { step: 'awaiting_name', editGroupId: id, editGroupName: group.name };
        await ctx.reply(`Введи новое название для группы «${group.name}»:`);
    });

    // ── Обработка текстовых ответов пользователя ──────────────────────────────
    bot.on('message:text', async (ctx, next) => {
        const watchState = ctx.session.chatPromptWatchState;
        if (watchState && watchState.expiresAt > Date.now()) return next();
        if (watchState) delete ctx.session.chatPromptWatchState;

        const state = ctx.session.chatGroupState;
        if (!state) return next();

        const text = ctx.message.text.trim();
        const chatId = ctx.chat?.id;
        if (!chatId) return next();

        // Шаг 1: ожидаем название группы
        if (state.step === 'awaiting_name') {
            if (!text) {
                await ctx.reply('Название не может быть пустым. Попробуй ещё раз:');
                return;
            }

            if (state.editGroupId) {
                // Переименование существующей группы
                const groups = await ChatGroupRepository.findAll(chatId);
                const group = groups.find(g => g.id === state.editGroupId);
                if (group) {
                    await ChatGroupRepository.save(chatId, text, group.chatNames);
                    await ChatGroupRepository.delete(group.id);
                }
                delete ctx.session.chatGroupState;
                await ctx.reply(`✅ Группа переименована в «${text}».`);
            } else if (state.pendingChatNames?.length) {
                // Quick-save: имя группы получено, чаты уже известны
                const saved = await ChatGroupRepository.save(chatId, text, state.pendingChatNames);
                delete ctx.session.chatGroupState;
                const blocks: RichBlock[] = [
                    paragraph(`✅ Группа «${esc(saved.name)}» сохранена!`),
                    list(saved.chatNames.map(c => esc(c))),
                    footer(`Теперь можешь писать: «Проанализируй ${esc(saved.name)}».`),
                ];
                await sendStructured(ctx.api as any, chatId, blocks);
            } else {
                // Новая группа — запрашиваем чаты
                ctx.session.chatGroupState = { step: 'awaiting_chats', groupName: text };
                await ctx.reply(
                    `Отлично! Теперь перечисли названия Telegram-чатов для группы «${text}» — через запятую или с новой строки. Названия должны совпадать с тем, как чаты называются в Telegram.`
                );
            }
            return;
        }

        // Шаг 2: ожидаем список чатов (создание новой или добавление в существующую)
        if (state.step === 'awaiting_chats') {
            const parsed = text
                .split(/[\n,]+/)
                .map(s => s.trim())
                .filter(Boolean);

            if (parsed.length === 0) {
                await ctx.reply('Не нашла ни одного названия чата. Перечисли их через запятую или с новой строки:');
                return;
            }

            if (state.editGroupId && state.editGroupName) {
                // Добавление чатов в существующую группу
                const groups = await ChatGroupRepository.findAll(chatId);
                const group = groups.find(g => g.id === state.editGroupId);
                if (group) {
                    const merged = Array.from(new Set([...group.chatNames, ...parsed]));
                    await ChatGroupRepository.updateChatNames(group.id, merged);
                    delete ctx.session.chatGroupState;
                    const blocks: RichBlock[] = [
                        paragraph(`✅ Группа «${esc(group.name)}» обновлена:`),
                        list(merged.map(c => esc(c))),
                    ];
                    await sendStructured(ctx.api as any, chatId, blocks);
                }
            } else if (state.groupName) {
                // Создание новой группы
                const saved = await ChatGroupRepository.save(chatId, state.groupName, parsed);
                delete ctx.session.chatGroupState;
                const blocks: RichBlock[] = [
                    paragraph(`✅ Группа «${esc(saved.name)}» сохранена!`),
                    list(parsed.map(c => esc(c))),
                    footer(`Теперь можешь писать: «Проанализируй ${esc(saved.name)}».`),
                ];
                await sendStructured(ctx.api as any, chatId, blocks);
            }
            return;
        }

        // Шаг 3: ожидаем название/номер чата для удаления
        if (state.step === 'awaiting_remove_chat' && state.editGroupId) {
            const groups = await ChatGroupRepository.findAll(chatId);
            const group = groups.find(g => g.id === state.editGroupId);
            if (!group) {
                delete ctx.session.chatGroupState;
                return next();
            }

            // Попытка разобрать как номер
            const idx = parseInt(text);
            let toRemove: string | undefined;
            if (!isNaN(idx) && idx >= 1 && idx <= group.chatNames.length) {
                toRemove = group.chatNames[idx - 1];
            } else {
                toRemove = group.chatNames.find(c => c.toLowerCase() === text.toLowerCase());
            }

            if (!toRemove) {
                await ctx.reply(`Не нашла чат «${text}» в группе. Попробуй ещё раз (номер или точное название):`);
                return;
            }

            const updated = group.chatNames.filter(c => c !== toRemove);
            await ChatGroupRepository.updateChatNames(group.id, updated);
            delete ctx.session.chatGroupState;

            if (updated.length === 0) {
                await ctx.reply(`✅ Удалён чат «${toRemove}». В группе «${group.name}» больше нет чатов.`);
            } else {
                const blocks: RichBlock[] = [
                    paragraph(`✅ Удалён чат «${esc(toRemove)}» из группы «${esc(group.name)}».`),
                    paragraph('<b>Осталось:</b>'),
                    list(updated.map(c => esc(c))),
                ];
                await sendStructured(ctx.api as any, chatId, blocks);
            }
            return;
        }

        return next();
    });
}
