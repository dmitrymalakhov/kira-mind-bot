import { Bot } from "grammy";
import { config } from "../config";
import { USER_TIMEZONE } from "../constants";
import { BotContext } from "../types";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { getProactiveChatId } from "../utils/allowedUserChatStore";
import { getActiveBotProfile } from "../utils/botIdentity";
import { getZonedDateTimeParts } from "../utils/time";
import { esc, heading, paragraph, RichBlock, sendStructured } from "../utils/richMessage";

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

const reportedMessageIds = new Set<number>();
const reportedMessageDates = new Map<number, number>();

function inQuietHours(now: Date): boolean {
  if (!config.dmReportQuietHoursEnabled) {
    return false;
  }

  const hour = getZonedDateTimeParts(now, USER_TIMEZONE).hour;
  const start = config.kiraLifeProactiveQuietHourStart;
  const end = config.kiraLifeProactiveQuietHourEnd;

  if (start === end) {
    return true;
  }

  if (start < end) {
    return hour >= start && hour < end;
  }

  return hour >= start || hour < end;
}

function truncateMessageText(text: string, maxLength: number = 200): string {
  if (text.length <= maxLength) {
    return text;
  }

  return `${text.slice(0, maxLength)}...`;
}

function formatMessageTime(messageDate: Date, now: Date): string {
  const isOlderThanDay = now.getTime() - messageDate.getTime() >= 24 * 60 * 60 * 1000;

  if (isOlderThanDay) {
    return messageDate.toLocaleString("ru-RU", {
      day: "2-digit",
      month: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      timeZone: USER_TIMEZONE,
    });
  }

  return messageDate.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
    timeZone: USER_TIMEZONE,
  });
}

function cleanupReportedMessageIds(now: Date): void {
  const threshold = now.getTime() - REPORT_TTL_MS;

  for (const [messageId, messageDateMs] of reportedMessageDates.entries()) {
    if (messageDateMs < threshold) {
      reportedMessageDates.delete(messageId);
      reportedMessageIds.delete(messageId);
    }
  }
}

function formatMessageCount(count: number): string {
  const mod10 = count % 10;
  const mod100 = count % 100;

  if (mod10 === 1 && mod100 !== 11) {
    return `${count} сообщение`;
  }

  if (mod10 >= 2 && mod10 <= 4 && (mod100 < 12 || mod100 > 14)) {
    return `${count} сообщения`;
  }

  return `${count} сообщений`;
}

function buildDmReportBlocks(messages: StoredMessage[], now: Date): RichBlock[] {
  const groupedBySender = new Map<string, StoredMessage[]>();

  messages.forEach((message) => {
    const senderKey = String(message.senderId);
    if (!groupedBySender.has(senderKey)) {
      groupedBySender.set(senderKey, []);
    }

    groupedBySender.get(senderKey)!.push(message);
  });

  const sortedGroups = Array.from(groupedBySender.values()).sort((a, b) => {
    const aLatestDate = Math.max(...a.map((m) => m.date.getTime()));
    const bLatestDate = Math.max(...b.map((m) => m.date.getTime()));
    return bLatestDate - aLatestDate;
  });

  const blocks: RichBlock[] = [heading("📬 Новые личные сообщения", 3)];

  sortedGroups.forEach((senderMessages, index) => {
    const sortedByDate = [...senderMessages].sort((a, b) => a.date.getTime() - b.date.getTime());
    const sender = sortedByDate[0];
    const latestMessage = sortedByDate[sortedByDate.length - 1];
    const metaParts = [];

    if (sender.senderUsername) {
      metaParts.push(`@${esc(sender.senderUsername)}`);
    }

    metaParts.push(formatMessageCount(sortedByDate.length));
    metaParts.push(`последнее ${esc(formatMessageTime(latestMessage.date, now))}`);

    const lines = sortedByDate.map((message) => {
      const timeLabel = esc(formatMessageTime(message.date, now));
      const text = esc(truncateMessageText(message.text || "[Без текста]"));
      return `• <b>${timeLabel}</b> — ${text}`;
    });

    const body = [
      `<b>${esc(sender.senderName)}</b>`,
      metaParts.join(" · "),
      "",
      ...lines,
    ].join("<br/>");

    blocks.push(paragraph(body));
    if (index < sortedGroups.length - 1) blocks.push(paragraph("──────────"));
  });

  return blocks;
}

async function runCycle(bot: Bot<BotContext>): Promise<void> {
  if (isRunning) {
    return;
  }

  isRunning = true;

  try {
    const now = new Date();
    cleanupReportedMessageIds(now);

    if (inQuietHours(now)) {
      return;
    }

    const messageStore = MessageStore.getInstance();
    const unreadChats = messageStore.getUnreadMessages();

    const unreadMessages = unreadChats.flatMap((chat) => chat.messages);

    const newMessages = unreadMessages.filter((message) => !reportedMessageIds.has(message.id));

    if (newMessages.length === 0) {
      return;
    }

    const chatId = await getProactiveChatId();
    const reportBlocks = buildDmReportBlocks(newMessages, now);

    await sendStructured(bot.api as any, chatId, reportBlocks);

    newMessages.forEach((message) => {
      reportedMessageIds.add(message.id);
      reportedMessageDates.set(message.id, message.date.getTime());
    });
  } catch (error) {
    console.error("[dm-report] cycle failed:", error);
  } finally {
    isRunning = false;
  }
}

export function startDmReportScheduler(bot: Bot<BotContext>): void {
  if (getActiveBotProfile() !== "KiraMindBot") {
    return;
  }

  if (!config.dmReportEnabled) {
    return;
  }

  if (timer) {
    clearInterval(timer);
  }

  timer = setInterval(() => {
    runCycle(bot);
  }, config.dmReportIntervalMs);

  setTimeout(() => {
    runCycle(bot);
  }, 30_000);
}
