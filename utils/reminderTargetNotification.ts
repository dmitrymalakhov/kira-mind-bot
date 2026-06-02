import { InlineKeyboard } from "grammy";
import type { InlineKeyboardButton } from "grammy/types";
import { config } from "../config";
import type { ReminderTargetChat } from "../types/reminderTypes";

export const REMINDER_TARGET_NOTIFY_PREFIX = "reminder_notify";

interface TargetReminderButtonSource {
    id: string;
    targetChat?: ReminderTargetChat;
}

function ownerNameForInstruction(): string {
    const name = (config.ownerName || "").trim();
    if (!name) return config.userGender === "female" ? "владелицы" : "владельца";
    if (/^владелец$/iu.test(name)) return "владельца";
    if (/^владелица$/iu.test(name)) return "владелицы";
    if (/ия$/iu.test(name)) return `${name.slice(0, -1)}и`;
    if (/ий$/iu.test(name)) return `${name.slice(0, -2)}ия`;
    if (/а$/iu.test(name)) return `${name.slice(0, -1)}ы`;
    return name;
}

export function buildDefaultTargetReminderMessage(reminderText: string): string {
    const ownerName = ownerNameForInstruction();
    return `Напоминаю по поручению ${ownerName}: ${reminderText}`;
}

export function targetChatHumanLabel(target: ReminderTargetChat): string {
    return target.type === "group"
        ? `чат «${target.groupName}»`
        : `контакт «${target.contactQuery}»`;
}

function targetChatButtonLabel(target: ReminderTargetChat): string {
    const raw = target.type === "group" ? target.groupName : target.contactQuery;
    const normalized = raw.replace(/\s+/g, " ").trim();
    return normalized.length > 24 ? `${normalized.slice(0, 21).trimEnd()}...` : normalized;
}

export function buildTargetNotificationCallback(action: "enable" | "disable", reminderId: string): string {
    return `${REMINDER_TARGET_NOTIFY_PREFIX}:${action}:${reminderId}`;
}

export function parseTargetNotificationCallback(
    callbackData: string
): { action: "enable" | "disable"; reminderId: string } | null {
    const match = callbackData.match(/^reminder_notify:(enable|disable):(.+)$/);
    if (!match) return null;
    return {
        action: match[1] as "enable" | "disable",
        reminderId: match[2],
    };
}

export function appendTargetNotificationPrompt(
    responseText: string,
    reminders: TargetReminderButtonSource[]
): string {
    const withTargets = reminders.filter((r) => r.targetChat);
    if (withTargets.length === 0) return responseText;

    if (withTargets.length === 1) {
        const target = withTargets[0].targetChat!;
        return `${responseText}\n\nЯ нашла адресата: ${targetChatHumanLabel(target)}. Оповестить адресата отдельным сообщением, когда напоминание сработает?`;
    }

    return `${responseText}\n\nЯ нашла адресатов в нескольких напоминаниях. По каждому можно выбрать, отправлять ли отдельное сообщение адресату.`;
}

export function addTargetNotificationButtons(
    keyboard: InlineKeyboard,
    reminders: TargetReminderButtonSource[]
): InlineKeyboard {
    for (const reminder of reminders) {
        if (!reminder.targetChat) continue;
        keyboard
            .text(`📨 Оповестить ${targetChatButtonLabel(reminder.targetChat)}`, buildTargetNotificationCallback("enable", reminder.id))
            .text("Только мне", buildTargetNotificationCallback("disable", reminder.id))
            .row();
    }
    return keyboard;
}

export function removeTargetNotificationButtons(
    inlineKeyboard: InlineKeyboardButton[][] | undefined,
    reminderId: string
): InlineKeyboardButton[][] {
    if (!inlineKeyboard) return [];

    const callbacksToRemove = new Set([
        buildTargetNotificationCallback("enable", reminderId),
        buildTargetNotificationCallback("disable", reminderId),
    ]);

    return inlineKeyboard
        .map((row) => row.filter((button) => !("callback_data" in button) || !callbacksToRemove.has(button.callback_data)))
        .filter((row) => row.length > 0);
}
