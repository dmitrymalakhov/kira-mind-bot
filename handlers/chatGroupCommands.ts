import { Bot, InlineKeyboard } from 'grammy';
import { BotContext } from '../types';
import { ChatGroupRepository } from '../services/ChatGroupRepository';
import { ChatGroupEntity } from '../entity/ChatGroupEntity';
import { notifyChatGroupTrackerChange } from '../services/chatGroupTracker';
import { config } from '../config';

const ITEMS_PER_PAGE = 5;

function buildMainMenu(groups: ChatGroupEntity[], page = 0): { text: string; keyboard: InlineKeyboard } {
    const total = groups.length;
    const start = page * ITEMS_PER_PAGE;
    const pageGroups = groups.slice(start, start + ITEMS_PER_PAGE);

    let text = '📂 *Группы чатов*\n\n';
    if (total === 0) {
        text += 'Группы ещё не созданы.';
    } else {
        pageGroups.forEach((g, i) => {
            const chats = g.chatNames.map(c => `• ${c}`).join('\n');
            text += `*${start + i + 1}. ${g.name}*\n${chats}\n\n`;
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

    return { text, keyboard: kb };
}

function buildGroupDetailMenu(group: ChatGroupEntity): { text: string; keyboard: InlineKeyboard } {
    const chats = group.chatNames.map((c, i) => `${i + 1}. ${c}`).join('\n');
    const trackingLabel = group.isTracking ? '🔕 Отслеживание: вкл' : '📡 Отслеживать';
    const text = `✏️ *${group.name}*\n\nЧаты:\n${chats}${group.isTracking ? `\n\n📡 _Умное отслеживание активно — ${config.characterName} уведомит о важных сообщениях_` : ''}\n\nЧто сделать?`;

    const kb = new InlineKeyboard()
        .text('➕ Добавить чат', `cg:addchat:${group.id}`).row()
        .text('➖ Удалить чат', `cg:rmchat:${group.id}`).row()
        .text('🔁 Переименовать', `cg:rename:${group.id}`).row()
        .text(trackingLabel, `cg:track:${group.id}`).row()
        .text('🗑️ Удалить группу', `cg:del:${group.id}`).row()
        .text('◀️ Назад', 'cg:back').row();

    return { text, keyboard: kb };
}

export function registerChatGroupCommands(bot: Bot<BotContext>) {

    // ── Команда /chatgroups ────────────────────────────────────────────────────
    bot.command('chatgroups', async (ctx) => {
        const chatId = ctx.chat?.id;
        if (!chatId) return;
        delete ctx.session.chatGroupState;

        const groups = await ChatGroupRepository.findAll(chatId);
        const { text, keyboard } = buildMainMenu(groups);
        await ctx.reply(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
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
        const { text, keyboard } = buildMainMenu(groups, page);
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
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
        const { text, keyboard } = buildMainMenu(groups);
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
    });

    // ── Callback: новая группа ────────────────────────────────────────────────
    bot.callbackQuery('cg:new', async (ctx) => {
        await ctx.answerCallbackQuery();
        ctx.session.chatGroupState = { step: 'awaiting_name' };
        await ctx.reply('Введи название новой группы (например: *Рабочие чаты*)', { parse_mode: 'Markdown' });
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

        const { text, keyboard } = buildGroupDetailMenu(group);
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
    });

    // ── Callback: удалить группу ──────────────────────────────────────────────
    bot.callbackQuery(/^cg:del:(\d+)$/, async (ctx) => {
        await ctx.answerCallbackQuery();
        const id = parseInt(ctx.match[1]);
        await ChatGroupRepository.delete(id);

        const chatId = ctx.chat?.id;
        if (!chatId) return;
        const groups = await ChatGroupRepository.findAll(chatId);
        const { text, keyboard } = buildMainMenu(groups);
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
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
            `Перечисли названия чатов, которые хочешь *добавить* в группу «${group.name}», через запятую или с новой строки:`,
            { parse_mode: 'Markdown' }
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

        const list = group.chatNames.map((c, i) => `${i + 1}. ${c}`).join('\n');
        await ctx.reply(
            `Напиши номер или название чата, который хочешь убрать из «${group.name}»:\n\n${list}`,
            { parse_mode: 'Markdown' }
        );
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

        const statusText = isNowTracking
            ? `✅ Умное отслеживание для группы «${group.name}» *включено*.\n\n${config.characterName} будет присылать уведомления о важных сообщениях в личный чат.`
            : `🔕 Отслеживание для группы «${group.name}» *выключено*.`;

        await ctx.reply(statusText, { parse_mode: 'Markdown' });

        const { text, keyboard } = buildGroupDetailMenu(group);
        await ctx.editMessageText(text, { reply_markup: keyboard, parse_mode: 'Markdown' });
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
                const list = saved.chatNames.map(c => `• ${c}`).join('\n');
                await ctx.reply(
                    `✅ Группа «${saved.name}» сохранена!\n\n${list}\n\nТеперь можешь писать: _«Проанализируй ${saved.name}»_.`,
                    { parse_mode: 'Markdown' }
                );
            } else {
                // Новая группа — запрашиваем чаты
                ctx.session.chatGroupState = { step: 'awaiting_chats', groupName: text };
                await ctx.reply(
                    `Отлично! Теперь перечисли названия Telegram-чатов для группы «${text}» — через запятую или с новой строки.\n\nНазвания должны совпадать с тем, как чаты называются в Telegram.`,
                    { parse_mode: 'Markdown' }
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
                    const list = merged.map(c => `• ${c}`).join('\n');
                    await ctx.reply(`✅ Группа «${group.name}» обновлена:\n${list}`);
                }
            } else if (state.groupName) {
                // Создание новой группы
                const saved = await ChatGroupRepository.save(chatId, state.groupName, parsed);
                delete ctx.session.chatGroupState;
                const list = parsed.map(c => `• ${c}`).join('\n');
                await ctx.reply(
                    `✅ Группа «${saved.name}» сохранена!\n\n${list}\n\nТеперь можешь писать: _«Проанализируй ${saved.name}»_.`,
                    { parse_mode: 'Markdown' }
                );
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
                const list = updated.map(c => `• ${c}`).join('\n');
                await ctx.reply(`✅ Удалён чат «${toRemove}» из группы «${group.name}».\n\nОсталось:\n${list}`);
            }
            return;
        }

        return next();
    });
}
