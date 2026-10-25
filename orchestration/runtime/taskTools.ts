import { randomUUID } from 'crypto';
import { RecurringTaskRepository, RECURRING_TASK_STALE_LOCK_MS } from '../../services/RecurringTaskRepository';
import { updateRecurringTaskSchedule } from '../../services/recurringTaskService';
import { parseRecurringSchedule } from '../../utils/recurringTaskSchedule';
import { getActiveBotProfile } from '../../utils/botIdentity';
import { USER_TIMEZONE } from '../../constants';
import { ChatGroupRepository } from '../../services/ChatGroupRepository';
import { listChatPromptWatchers, addChatPromptWatcher, setChatPromptWatcherEnabled, removeChatPromptWatcher } from '../../services/chatPromptWatchers';
import { listReadableTelegramChats } from '../../services/telegram';
import { objectSchema, textSchema } from './registry';
import type { ToolDefinition } from './types';

const idSchema = objectSchema({ id: textSchema('ID из списка объектов') });

export function taskTools(): ToolDefinition[] {
    return [
        {
            name: 'tasks.list', skill: 'recurring-tasks', effect: 'read', ownerOnly: true,
            description: 'Список регулярных AI-задач текущего чата, включая расписание и состояние.', inputSchema: objectSchema({}),
            async execute(_, context) { return { status: 'ok', summary: 'Регулярные задачи.', data: await RecurringTaskRepository.listByChatId(context.ctx.chat!.id) }; },
        },
        {
            name: 'tasks.create', skill: 'recurring-tasks', effect: 'state', ownerOnly: true,
            description: 'Создать регулярное выполнение запроса. Prompt является одноразовой задачей, расписание задаётся отдельно. Не создавать из фонового запуска.',
            inputSchema: objectSchema({ prompt: textSchema('Одноразовый запрос, который заново исполняется каждый раз'), schedule: textSchema('Явное расписание: каждый день в 9, каждые 2 часа'), title: textSchema('Короткое название', 150) }, ['prompt', 'schedule']),
            async execute(args, context) {
                if (context.recurringTaskRun) return { status: 'failed', summary: 'Фоновая задача не может создавать другую регулярную задачу.' };
                const now = new Date();
                const schedule = parseRecurringSchedule(String(args.schedule), now, USER_TIMEZONE);
                if (!schedule || schedule.nextRunAt <= now) return { status: 'failed', summary: 'Расписание не распознано. Уточни время и повторение.' };
                const data = await RecurringTaskRepository.create({ id: randomUUID(), profile: getActiveBotProfile(), chatId: context.ctx.chat!.id,
                    chatType: context.ctx.chat!.type === 'private' ? 'private' : context.ctx.chat!.type === 'group' ? 'group' : 'supergroup',
                    userId: context.ctx.from!.id, title: String(args.title ?? args.prompt).slice(0, 150), prompt: String(args.prompt), schedule: schedule.schedule,
                    timezone: USER_TIMEZONE, status: 'active', nextRunAt: schedule.nextRunAt, consecutiveFailures: 0, runCount: 0, createdAt: now, updatedAt: now,
                    contextHistory: context.messageHistory.slice(-8).map(m => ({ role: m.role, content: m.content.slice(0, 2000) })),
                });
                return { status: 'ok', summary: `Регулярная задача создана: ${data.title}. ${schedule.description}`, data: { id: data.id, nextRunAt: data.nextRunAt } };
            },
        },
        ...(['pause', 'resume', 'remove', 'runNow'] as const).map(action => ({
            name: `tasks.${action}`, skill: 'recurring-tasks', effect: 'state' as const, ownerOnly: true,
            description: `${action}: изменить одну регулярную задачу по выбранному ID.`, inputSchema: idSchema,
            async execute(args: Record<string, unknown>, context: import('./types').ToolContext) {
                const id = String(args.id); const chatId = context.ctx.chat!.id;
                const task = await RecurringTaskRepository.findById(id, chatId);
                if (!task) return { status: 'failed' as const, summary: 'Задача этого чата не найдена.' };
                if (task.lockedAt && task.lockedAt.getTime() > Date.now() - RECURRING_TASK_STALE_LOCK_MS) return { status: 'failed' as const, summary: 'Задача сейчас исполняется; изменение не выполнено.' };
                const data = action === 'remove' ? await RecurringTaskRepository.delete(id, chatId)
                    : action === 'runNow' ? await RecurringTaskRepository.requestRunNow(id, chatId)
                    : await RecurringTaskRepository.setStatus(id, action === 'pause' ? 'paused' : 'active', chatId);
                return { status: data ? 'ok' as const : 'failed' as const, summary: data ? 'Состояние задачи изменено.' : 'Изменение задачи не подтверждено.', data };
            },
        })),
        {
            name: 'tasks.update', skill: 'recurring-tasks', effect: 'state', ownerOnly: true,
            description: 'Изменить расписание выбранной регулярной задачи.', inputSchema: objectSchema({ id: textSchema('ID задачи'), schedule: textSchema('Новое расписание') }),
            async execute(args, context) {
                const task = await RecurringTaskRepository.findById(String(args.id), context.ctx.chat!.id);
                if (!task) return { status: 'failed', summary: 'Задача не найдена.' };
                const data = await updateRecurringTaskSchedule(task, String(args.schedule));
                return { status: data ? 'ok' : 'failed', summary: data ? 'Расписание изменено.' : 'Не удалось изменить расписание.', data };
            },
        },
        {
            name: 'telegram.listChats', skill: 'telegram-reading', effect: 'read', ownerOnly: true,
            description: 'Получить доступные чаты личной Telegram-сессии. Нужен для выбора источника наблюдения.', inputSchema: objectSchema({}),
            async execute() { return { status: 'ok', summary: 'Доступные чаты.', data: await listReadableTelegramChats() }; },
        },
        {
            name: 'watchers.list', skill: 'chat-monitoring', effect: 'read', ownerOnly: true,
            description: 'Список наблюдений по пользовательским условиям.', inputSchema: objectSchema({}),
            async execute() { return { status: 'ok', summary: 'Наблюдения.', data: await listChatPromptWatchers() }; },
        },
        {
            name: 'watchers.create', skill: 'chat-monitoring', effect: 'state', ownerOnly: true,
            description: 'Создать наблюдение за доступным чатом с уведомлением владельцу в текущий чат. Другие получатели настраиваются через /watch.',
            inputSchema: objectSchema({ sourceChatId: textSchema('ID из telegram.listChats'), condition: textSchema('Условие, явно указанное пользователем') }),
            async execute(args, context) {
                const chats = await listReadableTelegramChats();
                const source = chats.find(chat => String(chat.id) === String(args.sourceChatId));
                if (!source) return { status: 'failed', summary: 'Источник отсутствует среди доступных чатов.' };
                const data = await addChatPromptWatcher({ sourceChatId: String(args.sourceChatId), sourceChatTitle: source.title, targetChatId: String(context.ctx.chat!.id), prompt: String(args.condition) });
                return { status: 'ok', summary: 'Наблюдение создано; уведомления будут приходить сюда.', data };
            },
        },
        ...(['pause', 'resume', 'remove'] as const).map(action => ({
            name: `watchers.${action}`, skill: 'chat-monitoring', effect: 'state' as const, ownerOnly: true,
            description: `${action}: изменить наблюдение по ID.`, inputSchema: idSchema,
            async execute(args: Record<string, unknown>) {
                const data = action === 'remove' ? await removeChatPromptWatcher(String(args.id)) : await setChatPromptWatcherEnabled(String(args.id), action === 'resume');
                return { status: data ? 'ok' as const : 'failed' as const, summary: data ? 'Наблюдение изменено.' : 'Наблюдение не найдено.', data };
            },
        })),
        {
            name: 'chatGroups.list', skill: 'chat-monitoring', effect: 'read', ownerOnly: true,
            description: 'Получить именованные наборы чатов и состояние отслеживания.', inputSchema: objectSchema({}),
            async execute(_, context) { return { status: 'ok', summary: 'Группы чатов.', data: await ChatGroupRepository.findAll(context.ctx.chat!.id) }; },
        },
        {
            name: 'chatGroups.save', skill: 'chat-monitoring', effect: 'state', ownerOnly: true,
            description: 'Создать или обновить именованный набор Telegram-чатов.',
            inputSchema: objectSchema({ name: textSchema('Имя набора', 120), chatNames: { type: 'array', maxItems: 30, items: textSchema('Название чата', 200) } }),
            async execute(args, context) {
                if (!(args.chatNames as string[]).length) return { status: 'failed', summary: 'Нужен хотя бы один чат.' };
                const data = await ChatGroupRepository.save(context.ctx.chat!.id, String(args.name), args.chatNames as string[]);
                return { status: 'ok', summary: 'Набор чатов сохранён.', data };
            },
        },
        ...(['remove', 'setTracking'] as const).map(action => ({
            name: `chatGroups.${action}`, skill: 'chat-monitoring', effect: 'state' as const, ownerOnly: true,
            description: `${action}: изменить набор чатов владельца.`,
            inputSchema: objectSchema({ id: { type: 'integer', minimum: 1 }, enabled: { type: 'boolean' } }, action === 'remove' ? ['id'] : ['id', 'enabled']),
            async execute(args: Record<string, unknown>, context: import('./types').ToolContext) {
                const groups = await ChatGroupRepository.findAll(context.ctx.chat!.id);
                const group = groups.find(g => g.id === Number(args.id));
                if (!group) return { status: 'failed' as const, summary: 'Набор этого чата не найден.' };
                if (action === 'remove') await ChatGroupRepository.delete(group.id);
                else if (!await ChatGroupRepository.setTracking(group.id, context.ctx.chat!.id, Boolean(args.enabled))) return { status: 'failed' as const, summary: 'Набор больше недоступен; изменение не подтверждено.' };
                return { status: 'ok' as const, summary: 'Набор чатов изменён.' };
            },
        })),
    ];
}
