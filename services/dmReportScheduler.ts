import * as fs from "fs/promises";
import * as path from "path";
import { Bot } from "grammy";
import { Api, TelegramClient } from "telegram";
import { config } from "../config";
import { USER_TIMEZONE } from "../constants";
import { BotContext } from "../types";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import { getActiveBotProfile } from "../utils/botIdentity";
import { RUNTIME_DATA_DIR } from "../utils/runtimeData";
import { getZonedDateTimeParts } from "../utils/time";
import { esc, heading, paragraph, RichBlock, sendStructured } from "../utils/richMessage";
import { initTelegramClient } from "./telegram";

const CHECK_INTERVAL_MS = 5 * 60_000;
const MAX_UNREAD_PER_CHAT = 100;
const STATE_PATH = path.join(RUNTIME_DATA_DIR, "dm-report-state.json");

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

interface DmReportState {
  version: 1;
  reported: Record<string, string>;
}

export function dmMessageKey(chatId: string | number, messageId: number): string {
  return `${chatId}:${messageId}`;
}

function inQuietHours(now: Date): boolean {
  if (!config.dmReportQuietHoursEnabled) return false;
  const hour = getZonedDateTimeParts(now, USER_TIMEZONE).hour;
  const start = config.kiraLifeProactiveQuietHourStart;
  const end = config.kiraLifeProactiveQuietHourEnd;
  if (start === end) return true;
  return start < end ? hour >= start && hour < end : hour >= start || hour < end;
}

async function loadState(): Promise<DmReportState> {
  await fs.mkdir(RUNTIME_DATA_DIR, { recursive: true });
  try {
    const parsed = JSON.parse(await fs.readFile(STATE_PATH, "utf-8")) as Partial<DmReportState>;
    return { version: 1, reported: parsed.reported ?? {} };
  } catch {
    return { version: 1, reported: {} };
  }
}

async function saveState(state: DmReportState): Promise<void> {
  await fs.mkdir(RUNTIME_DATA_DIR, { recursive: true });
  const tempPath = `${STATE_PATH}.${process.pid}.${Date.now()}.tmp`;
  await fs.writeFile(tempPath, JSON.stringify(state, null, 2), { encoding: "utf-8", mode: 0o600 });
  await fs.rename(tempPath, STATE_PATH);
}

function mediaText(message: Api.Message): string {
  const text = message.message?.trim();
  if (text) return text;
  const mediaName = message.media?.className?.replace(/^MessageMedia/, "");
  return mediaName ? `[${mediaName}]` : "[Без текста]";
}

/**
 * Сверяет локальный MessageStore с Telegram. История загружается только для
 * личных диалогов, у которых Telegram сообщает unreadCount > 0.
 */
export async function syncUnreadMessagesFromTelegram(
  client: TelegramClient,
  store = MessageStore.getInstance(),
): Promise<Set<string>> {
  const confirmedUnread = new Set<string>();
  const dialogs = await client.getDialogs({ limit: config.dmReportDialogLimit });

  for (const dialog of dialogs) {
    const entity = dialog.entity;
    if (!dialog.isUser || !(entity instanceof Api.User) || entity.bot || entity.self || !dialog.id) continue;
    const chatId = dialog.id.toString();
    const rawDialog = dialog.dialog as Api.Dialog;
    store.markReadThrough(chatId, Number(rawDialog.readInboxMaxId ?? 0));
    if (dialog.unreadCount <= 0) continue;

    const messages = await client.getMessages(dialog.inputEntity, {
      limit: MAX_UNREAD_PER_CHAT,
      minId: Number(rawDialog.readInboxMaxId ?? 0),
    });
    const senderName = dialog.name || dialog.title || entity.username || `contact-${chatId}`;
    for (const message of messages) {
      if (!(message instanceof Api.Message) || message.out || message.id <= Number(rawDialog.readInboxMaxId ?? 0)) continue;
      const stored: StoredMessage = {
        id: message.id,
        senderId: chatId,
        senderName,
        senderUsername: entity.username,
        text: mediaText(message),
        date: new Date(message.date * 1000),
        isRead: false,
        isBot: false,
      };
      store.addMessage(chatId, stored);
      confirmedUnread.add(dmMessageKey(chatId, message.id));
    }
  }
  return confirmedUnread;
}

export function selectAgedUnreadMessages(
  unreadChats: { chatId: string; messages: StoredMessage[] }[],
  confirmedUnread: Set<string>,
  reported: Record<string, string>,
  nowMs: number,
  minAgeMs: number,
): Array<StoredMessage & { chatId: string }> {
  return unreadChats.flatMap(({ chatId, messages }) => messages
    .filter((message) => {
      const key = dmMessageKey(chatId, message.id);
      return confirmedUnread.has(key) && !reported[key] && nowMs - message.date.getTime() >= minAgeMs;
    })
    .map((message) => ({ ...message, chatId })));
}

function formatMessageTime(date: Date): string {
  return date.toLocaleTimeString("ru-RU", { hour: "2-digit", minute: "2-digit", timeZone: USER_TIMEZONE });
}

function buildReportBlocks(messages: Array<StoredMessage & { chatId: string }>): RichBlock[] {
  const groups = new Map<string, Array<StoredMessage & { chatId: string }>>();
  for (const message of messages) {
    const key = message.chatId;
    groups.set(key, [...(groups.get(key) ?? []), message]);
  }

  const blocks: RichBlock[] = [heading("📬 Долго не прочитано", 3)];
  Array.from(groups.values())
    .sort((a, b) => b[b.length - 1].date.getTime() - a[a.length - 1].date.getTime())
    .forEach((group, index, all) => {
      group.sort((a, b) => a.date.getTime() - b.date.getTime());
      const sender = group[0];
      const username = sender.senderUsername ? ` · @${esc(sender.senderUsername)}` : "";
      const lines = group.map(message => `• <b>${esc(formatMessageTime(message.date))}</b> — ${esc(message.text)}`);
      blocks.push(paragraph(`<b>${esc(sender.senderName)}</b>${username}<br/>${lines.join("<br/>")}`));
      if (index < all.length - 1) blocks.push(paragraph("──────────"));
    });
  return blocks;
}

async function runCycle(bot: Bot<BotContext>): Promise<void> {
  if (isRunning) return;
  isRunning = true;
  try {
    const now = new Date();
    if (inQuietHours(now)) return;

    const client = await initTelegramClient({ preloadContacts: false });
    if (!client) throw new Error("Telegram user-client unavailable");
    const store = MessageStore.getInstance();
    const confirmedUnread = await syncUnreadMessagesFromTelegram(client, store);
    const state = await loadState();

    // Прочитанные сообщения больше не должны удерживать persisted dedupe.
    state.reported = Object.fromEntries(
      Object.entries(state.reported).filter(([key]) => confirmedUnread.has(key)),
    );
    const eligible = selectAgedUnreadMessages(
      store.getUnreadMessages(),
      confirmedUnread,
      state.reported,
      now.getTime(),
      config.dmReportIntervalMs,
    );

    if (eligible.length > 0) {
      await sendStructured(bot.api as any, await getProactiveChatId(), buildReportBlocks(eligible));
      const reportedAt = now.toISOString();
      for (const message of eligible) state.reported[dmMessageKey(message.chatId, message.id)] = reportedAt;
    }
    await saveState(state);
  } catch (error) {
    // Fail closed: без подтверждения Telegram не отправляем локальный stale-cache.
    console.error("[dm-report] cycle failed:", error);
  } finally {
    isRunning = false;
  }
}

export function startDmReportScheduler(bot: Bot<BotContext>): void {
  if (getActiveBotProfile() !== "KiraMindBot" || !config.dmReportEnabled) return;
  if (timer) clearInterval(timer);
  timer = setInterval(() => void runCycle(bot), CHECK_INTERVAL_MS);
  setTimeout(() => void runCycle(bot), 30_000);
  console.info(
    "[dm-report] scheduler started, unread age:",
    config.dmReportIntervalMs / 60_000,
    `min; Telegram check: ${CHECK_INTERVAL_MS / 60_000} min`,
  );
}
