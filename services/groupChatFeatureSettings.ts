import { config } from '../config';
import { getGlobalSetting, setGlobalSetting } from './botSettingsService';

export const GROUP_CHAT_CONTEXT_SETTING_KEY = 'GROUP_CHAT_CONTEXT_ENABLED';
export const GROUP_REPLY_TO_BOT_SETTING_KEY = 'GROUP_REPLY_TO_BOT_ENABLED';

function boolToString(value: boolean): string {
    return value ? 'true' : 'false';
}

function parseBooleanSetting(value: string | undefined, fallback: boolean): boolean {
    if (value === undefined) return fallback;
    const normalized = value.trim().toLowerCase();
    if (['true', '1', 'yes', 'on', 'вкл', 'да'].includes(normalized)) return true;
    if (['false', '0', 'no', 'off', 'выкл', 'нет'].includes(normalized)) return false;
    return fallback;
}

export async function isGroupChatContextEnabled(): Promise<boolean> {
    const value = await getGlobalSetting(GROUP_CHAT_CONTEXT_SETTING_KEY, boolToString(config.groupChatContextEnabled));
    return parseBooleanSetting(value, config.groupChatContextEnabled);
}

export async function setGroupChatContextEnabled(value: boolean): Promise<void> {
    await setGlobalSetting(GROUP_CHAT_CONTEXT_SETTING_KEY, boolToString(value));
}

export async function isGroupReplyToBotEnabled(): Promise<boolean> {
    const value = await getGlobalSetting(GROUP_REPLY_TO_BOT_SETTING_KEY, boolToString(config.groupReplyToBotEnabled));
    return parseBooleanSetting(value, config.groupReplyToBotEnabled);
}

export async function setGroupReplyToBotEnabled(value: boolean): Promise<void> {
    await setGlobalSetting(GROUP_REPLY_TO_BOT_SETTING_KEY, boolToString(value));
}
