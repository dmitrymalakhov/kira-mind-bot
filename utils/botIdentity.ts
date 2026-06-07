const DEFAULT_BOT_PROFILE = 'KiraMindBot';

export function getActiveBotProfile(): string {
    const profile = process.env.ASSISTANT_PROFILE?.trim();
    return profile || DEFAULT_BOT_PROFILE;
}

export function getActiveMemoryBotId(): string {
    return getActiveBotProfile().toLowerCase();
}

export function scopedBotKey(key: string | number): string {
    return `${getActiveBotProfile()}:${String(key)}`;
}
