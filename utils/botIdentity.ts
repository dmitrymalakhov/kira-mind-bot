const DEFAULT_BOT_PROFILE = 'KiraMindBot';

export function getActiveBotProfile(): string {
    const profile = process.env.ASSISTANT_PROFILE?.trim();
    return profile === DEFAULT_BOT_PROFILE ? profile : DEFAULT_BOT_PROFILE;
}

export function getActiveMemoryBotId(): string {
    return process.env.KIRA_MEMORY_BOT_ID || process.env.KIRA_MEMORY_NAMESPACE || getActiveBotProfile().toLowerCase();
}

export function scopedBotKey(key: string | number): string {
    return `${getActiveBotProfile()}:${String(key)}`;
}
