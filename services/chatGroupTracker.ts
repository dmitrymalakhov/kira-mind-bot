import { Bot } from 'grammy';
import { BotContext } from '../types';
import { ChatGroupRepository } from './ChatGroupRepository';
import { initTelegramClient, searchGroupByTitle } from './telegram';
import { analyzeTrackedMessages, TrackedMessage } from '../agents/trackingAnalysisAgent';
import { getProactiveChatId } from '../utils/allowedUserChatStore';

const POLL_INTERVAL_MS = 5 * 60 * 1000; // 5 минут

// Хранит последний увиденный message id для каждого чата (по названию)
const lastSeenId = new Map<string, number>();
// Флаг первого запуска — при старте только записываем watermark, не шлём уведомления
const initializedChats = new Set<string>();

let timer: NodeJS.Timeout | undefined;
let botRef: Bot<BotContext> | undefined;

export function notifyChatGroupTrackerChange(): void {
    // Перезапускаем цикл сразу, чтобы подхватить изменения в отслеживаемых группах
    if (timer) {
        clearTimeout(timer);
        scheduleNext();
    }
}

async function pollOnce(): Promise<void> {
    const groups = await ChatGroupRepository.findAllTracking();
    if (!groups.length) return;

    const client = await initTelegramClient();
    if (!client) return;

    const ownerChatId = await getProactiveChatId();

    for (const group of groups) {
        for (const chatName of group.chatNames) {
            try {
                const found = await searchGroupByTitle(client, chatName);
                if (!found) continue;

                const messages = await (client as any).getMessages(found.id, { limit: 20 });
                if (!messages?.length) continue;

                // Сортируем по возрастанию id
                const sorted: any[] = [...messages].sort((a: any, b: any) => a.id - b.id);
                const latestId = sorted[sorted.length - 1].id;
                const key = `${group.id}:${chatName}`;

                if (!initializedChats.has(key)) {
                    // Первый запуск — просто запоминаем позицию, не шлём уведомления
                    lastSeenId.set(key, latestId);
                    initializedChats.add(key);
                    continue;
                }

                const prevId = lastSeenId.get(key) ?? 0;
                const newMessages: any[] = sorted.filter((m: any) => m.id > prevId && m.message?.trim());

                if (!newMessages.length) continue;

                lastSeenId.set(key, latestId);

                const recentContext: TrackedMessage[] = sorted
                    .filter((m: any) => m.id <= prevId && m.message?.trim())
                    .slice(-10)
                    .map((m: any) => ({
                        senderName: m.sender?.firstName || m.sender?.title || 'Неизвестный',
                        text: m.message,
                        date: new Date(m.date * 1000),
                    }));

                const incoming: TrackedMessage[] = newMessages.map((m: any) => ({
                    senderName: m.sender?.firstName || m.sender?.title || 'Неизвестный',
                    text: m.message,
                    date: new Date(m.date * 1000),
                }));

                const result = await analyzeTrackedMessages(chatName, group.name, incoming, recentContext);
                if (!result?.isImportant) continue;

                const text =
                    `📡 *${group.name}* · ${chatName}\n\n` +
                    `${result.notificationText}\n\n` +
                    `_Причина: ${result.reason}_`;

                await botRef!.api.sendMessage(ownerChatId, text, { parse_mode: 'Markdown' });
            } catch (e) {
                console.error(`[chatGroupTracker] error processing chat "${chatName}":`, e);
            }
        }
    }
}

function scheduleNext(): void {
    timer = setTimeout(async () => {
        try {
            await pollOnce();
        } catch (e) {
            console.error('[chatGroupTracker] poll error:', e);
        }
        scheduleNext();
    }, POLL_INTERVAL_MS);
}

export function startChatGroupTracker(bot: Bot<BotContext>): void {
    botRef = bot;
    scheduleNext();
    console.info('[chatGroupTracker] started, polling every 5 min');
}
