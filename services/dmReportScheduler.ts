import { Bot } from "grammy";
import { config } from "../config";
import { BotContext } from "../types";
import { MessageStore, StoredMessage } from "../stores/MessageStore";
import { getProactiveChatId } from "../utils/allowedUserChatStore";

const REPORT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

let timer: NodeJS.Timeout | undefined;
let isRunning = false;

const reportedMessageIds = new Set<number>();
const reportedMessageDates = new Map<number, number>();

function inQuietHours(now: Date): boolean {
  if (!config.dmReportQuietHoursEnabled) {
    return false;
  }

  const hour = now.getHours();
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
    });
  }

  return messageDate.toLocaleTimeString("ru-RU", {
    hour: "2-digit",
    minute: "2-digit",
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

function formatDmReport(messages: StoredMessage[], now: Date): string {
  const groupedBySender = new Map<string, StoredMessage[]>();

  messages.forEach((message) => {
    const senderKey = String(message.senderId);
    if (!groupedBySender.has(senderKey)) {
      groupedBySender.set(senderKey, []);
    }

    groupedBySender.get(senderKey)!.push(message);
  });

  const sortedGroups = Array.from(groupedBySender.values()).sort((a, b) => {
    const aDate = Math.min(...a.map((m) => m.date.getTime()));
    const bDate = Math.min(...b.map((m) => m.date.getTime()));
    return aDate - bDate;
  });

  const lines: string[] = ["📬 Новые личные сообщения:", ""];

  sortedGroups.forEach((senderMessages, index) => {
    const sortedByDate = [...senderMessages].sort((a, b) => a.date.getTime() - b.date.getTime());
    const sender = sortedByDate[0];
    const username = sender.senderUsername ? ` (@${sender.senderUsername})` : "";

    lines.push(`${sender.senderName}${username}:`);

    sortedByDate.forEach((message) => {
      const timeLabel = formatMessageTime(message.date, now);
      const text = truncateMessageText(message.text || "[Без текста]");
      lines.push(`• [${timeLabel}] ${text}`);
    });

    if (index < sortedGroups.length - 1) {
      lines.push("");
    }
  });

  return lines.join("\n");
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
    const reportText = formatDmReport(newMessages, now);

    await bot.api.sendMessage(chatId, reportText);

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
  if (process.env.ASSISTANT_PROFILE !== "KiraMindBot") {
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
