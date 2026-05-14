import * as fs from 'fs/promises';
import * as path from 'path';
import { Api } from 'telegram';
import { TelegramClient } from 'telegram';
import { config } from '../config';
import { ContactsStore } from '../stores/ContactsStore';
import { BotContext, SessionData } from '../types';
import { runUpdateLongTermMemoryAgentDetailed } from '../agents/updateLongTermMemoryAgent';
import { contactDisplayName } from '../utils/contactMemory';
import {
    extractFactsAboutUserFromConversation,
    formatConversation,
} from '../utils/studyChatFlow';
import { devLog } from '../utils';
import { initTelegramClient } from './telegram';

const DATA_DIR = path.join(__dirname, '..', 'data');
const STATE_PATH = path.join(DATA_DIR, `${config.botUsername.toLowerCase()}-personal-chat-memory-index.json`);
const BATCH_SIZE = 100;
const MAX_PAGES_PER_CHAT = 30;

interface PersonalChatWatermark {
    chatId: number;
    displayName: string;
    username?: string;
    lastProcessedMessageId?: number;
    lastProcessedAt?: string;
    lastCheckedAt?: string;
    totalMessagesProcessed?: number;
    totalFactsSaved?: number;
    lastError?: string;
}

interface PersonalChatMemoryIndexState {
    version: 1;
    updatedAt: string;
    chats: Record<string, PersonalChatWatermark>;
}

interface PrivateDialogInfo {
    chatId: number;
    displayName: string;
    username?: string;
    date?: number;
}

interface NewMessagesResult {
    messages: Api.Message[];
    latestSeenMessageId?: number;
}

export interface PersonalChatMemoryCycleResult {
    enabled: boolean;
    scannedDialogs: number;
    processedChats: number;
    skippedChats: number;
    messagesAnalyzed: number;
    factsFound: number;
    factsSaved: number;
    errors: string[];
}

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

async function ensureDir(): Promise<void> {
    await fs.mkdir(DATA_DIR, { recursive: true });
}

async function loadState(): Promise<PersonalChatMemoryIndexState> {
    await ensureDir();
    try {
        const raw = await fs.readFile(STATE_PATH, 'utf-8');
        const parsed = JSON.parse(raw) as Partial<PersonalChatMemoryIndexState>;
        return {
            version: 1,
            updatedAt: parsed.updatedAt ?? new Date(0).toISOString(),
            chats: parsed.chats ?? {},
        };
    } catch {
        return { version: 1, updatedAt: new Date(0).toISOString(), chats: {} };
    }
}

async function saveState(state: PersonalChatMemoryIndexState): Promise<void> {
    await ensureDir();
    state.updatedAt = new Date().toISOString();
    await fs.writeFile(STATE_PATH, JSON.stringify(state, null, 2), 'utf-8');
}

function createBackgroundContext(): BotContext {
    const session: Partial<SessionData> = {
        reminders: [],
        messageHistory: [],
        dialogueSummary: '',
        lastSummarizedIndex: -1,
        domains: {},
        recentlySavedFacts: [],
    };

    return {
        from: { id: config.allowedUserId },
        chat: { id: config.allowedUserId, type: 'private' },
        session,
        reply: async () => undefined,
    } as unknown as BotContext;
}

function toNumberId(value: unknown): number | undefined {
    const id = Number(value);
    return Number.isFinite(id) ? id : undefined;
}

function dialogDisplayName(dialog: any, userId: number): { displayName: string; username?: string } {
    const contact = ContactsStore.getInstance().getContact(userId);
    if (contact) {
        return { displayName: contactDisplayName(contact), username: contact.username };
    }

    const entity = dialog.entity ?? {};
    const username = entity.username ? String(entity.username) : undefined;
    const first = entity.firstName ? String(entity.firstName) : '';
    const last = entity.lastName ? String(entity.lastName) : '';
    const fullName = [first, last].filter(Boolean).join(' ').trim();
    const title = String(dialog.title || dialog.name || '').trim();
    return {
        displayName: fullName || title || (username ? `@${username}` : `contact-${userId}`),
        username,
    };
}

function asPrivateDialog(dialog: any): PrivateDialogInfo | null {
    if (!dialog) return null;
    if (dialog.isGroup || dialog.isChannel) return null;

    const entity = dialog.entity ?? {};
    const className = String(entity.className || '');
    if (className && className !== 'User') return null;
    if (entity.bot || entity.deleted || entity.self) return null;

    const chatId = toNumberId(entity.id ?? dialog.id);
    if (!chatId) return null;
    if (chatId === config.allowedUserId) return null;

    const { displayName, username } = dialogDisplayName(dialog, chatId);
    return {
        chatId,
        displayName,
        username,
        date: typeof dialog.date === 'number' ? dialog.date : undefined,
    };
}

async function getPrivateDialogs(client: TelegramClient): Promise<PrivateDialogInfo[]> {
    const dialogs = await client.getDialogs({ limit: config.personalChatMemoryDialogLimit } as any);
    return dialogs
        .map(asPrivateDialog)
        .filter((d): d is PrivateDialogInfo => Boolean(d))
        .sort((a, b) => (b.date ?? 0) - (a.date ?? 0));
}

async function fetchNewMessages(
    client: TelegramClient,
    chatId: number,
    watermark: PersonalChatWatermark | undefined
): Promise<NewMessagesResult> {
    const lastProcessedId = watermark?.lastProcessedMessageId ?? 0;
    const initialCutoffMs = Date.now() - config.personalChatMemoryInitialLookbackDays * 86_400_000;
    const maxMessages = config.personalChatMemoryMaxMessagesPerChat;
    const messages: Api.Message[] = [];
    let latestSeenMessageId = lastProcessedId || undefined;
    let offsetId = 0;

    for (let page = 0; page < MAX_PAGES_PER_CHAT && messages.length < maxMessages; page++) {
        const batch = await (client as any).getMessages(chatId, {
            limit: BATCH_SIZE,
            offsetId: offsetId || undefined,
        }) as Api.Message[];
        if (!batch || batch.length === 0) break;

        let reachedKnownBoundary = false;
        for (const msg of batch) {
            const id = Number((msg as any).id || 0);
            if (id > (latestSeenMessageId ?? 0)) latestSeenMessageId = id;

            if (lastProcessedId && id <= lastProcessedId) {
                reachedKnownBoundary = true;
                break;
            }

            const dateMs = (msg.date || 0) * 1000;
            if (!lastProcessedId && dateMs < initialCutoffMs) {
                reachedKnownBoundary = true;
                break;
            }

            messages.push(msg);
            if (messages.length >= maxMessages) {
                reachedKnownBoundary = true;
                break;
            }
        }

        const last = batch[batch.length - 1];
        offsetId = Number((last as any)?.id || 0);
        if (!offsetId || reachedKnownBoundary) break;
    }

    messages.sort((a, b) => Number((a as any).id || 0) - Number((b as any).id || 0));
    return { messages, latestSeenMessageId };
}

function messageDateRange(messages: Api.Message[]): { startDate: Date; endDate: Date } {
    const dates = messages
        .map((msg) => (msg.date || 0) * 1000)
        .filter((value) => Number.isFinite(value) && value > 0);
    if (dates.length === 0) {
        const now = new Date();
        return { startDate: now, endDate: now };
    }
    return {
        startDate: new Date(Math.min(...dates)),
        endDate: new Date(Math.max(...dates)),
    };
}

function maxMessageId(messages: Api.Message[], fallback?: number): number | undefined {
    const ids = messages
        .map((msg) => Number((msg as any).id || 0))
        .filter((id) => Number.isFinite(id) && id > 0);
    return ids.length > 0 ? Math.max(...ids) : fallback;
}

function sourceMessageIds(chatId: number, messages: Api.Message[]): string[] {
    return messages
        .map((msg) => Number((msg as any).id || 0))
        .filter((id) => id > 0)
        .map((id) => `tg:${chatId}:${id}`)
        .slice(-80);
}

function updateWatermark(
    state: PersonalChatMemoryIndexState,
    dialog: PrivateDialogInfo,
    patch: Partial<PersonalChatWatermark>
): PersonalChatWatermark {
    const key = String(dialog.chatId);
    const previous = state.chats[key] ?? {
        chatId: dialog.chatId,
        displayName: dialog.displayName,
    };
    const updated: PersonalChatWatermark = {
        ...previous,
        ...patch,
        chatId: dialog.chatId,
        displayName: dialog.displayName,
        username: dialog.username ?? previous.username,
        lastCheckedAt: new Date().toISOString(),
    };
    state.chats[key] = updated;
    return updated;
}

export async function runPersonalChatMemoryIndexingCycle(options: { force?: boolean; maxChats?: number } = {}): Promise<PersonalChatMemoryCycleResult> {
    if (!config.personalChatMemoryEnabled && !options.force) {
        return {
            enabled: false,
            scannedDialogs: 0,
            processedChats: 0,
            skippedChats: 0,
            messagesAnalyzed: 0,
            factsFound: 0,
            factsSaved: 0,
            errors: ['personal-chat-memory-disabled'],
        };
    }
    if (isRunning) {
        return {
            enabled: config.personalChatMemoryEnabled,
            scannedDialogs: 0,
            processedChats: 0,
            skippedChats: 0,
            messagesAnalyzed: 0,
            factsFound: 0,
            factsSaved: 0,
            errors: ['already-running'],
        };
    }

    isRunning = true;
    const result: PersonalChatMemoryCycleResult = {
        enabled: config.personalChatMemoryEnabled,
        scannedDialogs: 0,
        processedChats: 0,
        skippedChats: 0,
        messagesAnalyzed: 0,
        factsFound: 0,
        factsSaved: 0,
        errors: [],
    };

    try {
        const client = await initTelegramClient();
        if (!client) {
            result.errors.push('telegram-client-unavailable');
            return result;
        }

        const state = await loadState();
        const dialogs = (await getPrivateDialogs(client)).slice(0, options.maxChats ?? config.personalChatMemoryMaxChatsPerRun);
        result.scannedDialogs = dialogs.length;

        for (const dialog of dialogs) {
            const key = String(dialog.chatId);
            const watermark = state.chats[key];
            try {
                const fetched = await fetchNewMessages(client, dialog.chatId, watermark);
                const textMessages = fetched.messages.filter((msg) => Boolean(msg.message?.trim()));

                if (fetched.messages.length === 0) {
                    updateWatermark(state, dialog, { lastError: undefined });
                    result.skippedChats++;
                    await saveState(state);
                    continue;
                }

                if (textMessages.length === 0) {
                    updateWatermark(state, dialog, {
                        lastProcessedMessageId: maxMessageId(fetched.messages, fetched.latestSeenMessageId),
                        lastProcessedAt: new Date().toISOString(),
                        lastError: undefined,
                    });
                    result.skippedChats++;
                    await saveState(state);
                    continue;
                }

                if (textMessages.length < config.personalChatMemoryMinNewMessages) {
                    updateWatermark(state, dialog, { lastError: undefined });
                    result.skippedChats++;
                    await saveState(state);
                    continue;
                }

                const formattedText = formatConversation(textMessages, dialog.chatId, dialog.displayName);
                if (!formattedText.trim()) {
                    updateWatermark(state, dialog, {
                        lastProcessedMessageId: maxMessageId(fetched.messages, fetched.latestSeenMessageId),
                        lastProcessedAt: new Date().toISOString(),
                        lastError: undefined,
                    });
                    result.skippedChats++;
                    await saveState(state);
                    continue;
                }

                const { startDate, endDate } = messageDateRange(textMessages);
                devLog('[personal-chat-memory] analyzing', {
                    chatId: dialog.chatId,
                    displayName: dialog.displayName,
                    messages: textMessages.length,
                });

                const facts = await extractFactsAboutUserFromConversation(
                    formattedText,
                    dialog.displayName,
                    startDate,
                    endDate
                );
                const ctx = createBackgroundContext();
                const update = await runUpdateLongTermMemoryAgentDetailed(ctx, facts, {
                    source: 'personal_chat_background',
                    sourceContactName: dialog.displayName,
                    sourceContext: `Фоновое изучение личной переписки с ${dialog.displayName}: ${startDate.toISOString()} — ${endDate.toISOString()}.`,
                    sourceMessageIds: sourceMessageIds(dialog.chatId, textMessages),
                    askOnAmbiguous: false,
                });

                const processedId = maxMessageId(fetched.messages, fetched.latestSeenMessageId);
                updateWatermark(state, dialog, {
                    lastProcessedMessageId: processedId,
                    lastProcessedAt: endDate.toISOString(),
                    totalMessagesProcessed: (watermark?.totalMessagesProcessed ?? 0) + textMessages.length,
                    totalFactsSaved: (watermark?.totalFactsSaved ?? 0) + update.savedCount,
                    lastError: undefined,
                });
                await saveState(state);

                result.processedChats++;
                result.messagesAnalyzed += textMessages.length;
                result.factsFound += facts.length;
                result.factsSaved += update.savedCount;
            } catch (error) {
                const message = error instanceof Error ? error.message : String(error);
                updateWatermark(state, dialog, { lastError: message });
                await saveState(state);
                result.errors.push(`${dialog.displayName}: ${message}`);
                result.skippedChats++;
            }
        }

        return result;
    } finally {
        isRunning = false;
    }
}

export async function getPersonalChatMemoryIndexStatus(): Promise<string> {
    const state = await loadState();
    const chats = Object.values(state.chats)
        .sort((a, b) => String(b.lastCheckedAt ?? '').localeCompare(String(a.lastCheckedAt ?? '')));
    const totals = chats.reduce(
        (acc, chat) => {
            acc.messages += chat.totalMessagesProcessed ?? 0;
            acc.facts += chat.totalFactsSaved ?? 0;
            if (chat.lastError) acc.errors++;
            return acc;
        },
        { messages: 0, facts: 0, errors: 0 }
    );

    const lines = [
        '📚 Фоновое изучение личных переписок',
        `Статус: ${config.personalChatMemoryEnabled ? 'включено' : 'выключено'}`,
        `Чатов с watermark: ${chats.length}`,
        `Обработано сообщений: ${totals.messages}`,
        `Сохранено фактов: ${totals.facts}`,
        `Чатов с последней ошибкой: ${totals.errors}`,
        `Файл состояния: ${STATE_PATH}`,
    ];

    if (chats.length > 0) {
        lines.push('', 'Последние чаты:');
        for (const chat of chats.slice(0, 10)) {
            const last = chat.lastProcessedMessageId ? `msg ${chat.lastProcessedMessageId}` : 'нет watermark';
            const checked = chat.lastCheckedAt ? new Date(chat.lastCheckedAt).toLocaleString('ru-RU') : 'не проверялся';
            const err = chat.lastError ? `, ошибка: ${chat.lastError.slice(0, 80)}` : '';
            lines.push(`• ${chat.displayName}: ${last}, проверка ${checked}, фактов ${chat.totalFactsSaved ?? 0}${err}`);
        }
    }

    return lines.join('\n');
}

async function runScheduledCycle(): Promise<void> {
    const result = await runPersonalChatMemoryIndexingCycle();
    console.log('[personal-chat-memory] cycle completed:', result);
}

export function startPersonalChatMemoryIndexer(): void {
    if (!config.personalChatMemoryEnabled) return;
    if (timer) clearInterval(timer);

    timer = setInterval(() => {
        runScheduledCycle().catch((error) => {
            console.error('[personal-chat-memory] cycle failed:', error);
        });
    }, config.personalChatMemoryIntervalMs);

    setTimeout(() => {
        runScheduledCycle().catch((error) => {
            console.error('[personal-chat-memory] first cycle failed:', error);
        });
    }, 5 * 60 * 1000);

    console.log('[personal-chat-memory] Scheduler started, interval:', config.personalChatMemoryIntervalMs / 60_000, 'min');
}
