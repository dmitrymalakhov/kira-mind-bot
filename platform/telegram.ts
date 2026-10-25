import type { Update } from 'grammy/types';
import { ApiError } from '../api/contracts';
import { digest } from './crypto';

export interface BotIdentity { id: number; username: string }
export interface TelegramSession { apiId: number; apiHash: string; sessionString: string }
export interface TelegramGateway {
    verify(token: string): Promise<BotIdentity>;
    updates(token: string, offset: number): Promise<Update[]>;
    verifySession(credentials: TelegramSession, ownerId: string): Promise<void>;
}

/** Do not log fetch errors: Telegram URLs contain the bot token. */
export class TelegramBotGateway implements TelegramGateway {
    private async call(token: string, method: string, body: unknown = {}): Promise<any> {
        try {
            const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, {
                method: 'POST', headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body), signal: AbortSignal.timeout(15_000),
            });
            const result = await response.json() as { ok: boolean; result?: unknown; error_code?: number };
            if (!response.ok || !result.ok) {
                if (result.error_code === 401 || result.error_code === 404) throw new ApiError(400, 'invalid_bot_token', 'Telegram не принял токен бота.');
                if (result.error_code === 409) throw new ApiError(409, 'bot_in_use', 'Бот уже запущен другим приложением. Останови его перед подключением.');
                throw new Error('Telegram unavailable');
            }
            return result.result;
        } catch (error) {
            if (error instanceof ApiError) throw error;
            throw new ApiError(502, 'telegram_unavailable', 'Не удалось связаться с Telegram. Повтори позже.');
        }
    }
    async verify(token: string): Promise<BotIdentity> {
        if (!/^\d{5,20}:[A-Za-z0-9_-]{30,100}$/.test(token)) throw new ApiError(400, 'invalid_bot_token', 'Некорректный формат токена бота.');
        const bot = await this.call(token, 'getMe');
        const webhook = await this.call(token, 'getWebhookInfo');
        if (webhook.url) throw new ApiError(409, 'bot_has_webhook', 'У бота включён webhook. Отключи прежнее приложение перед подключением.');
        if (!Number.isSafeInteger(bot.id) || bot.id <= 0 || !bot.is_bot || !/^[A-Za-z0-9_]{5,32}$/.test(bot.username)) throw new Error('Invalid Telegram identity');
        return { id: bot.id, username: bot.username };
    }
    updates(token: string, offset: number): Promise<Update[]> {
        return this.call(token, 'getUpdates', { offset, timeout: 0, limit: 100, allowed_updates: ['message'] });
    }
    async verifySession(credentials: TelegramSession, ownerId: string): Promise<void> {
        const { TelegramClient } = await import('telegram');
        const { StringSession } = await import('telegram/sessions');
        const { Logger, LogLevel } = await import('telegram/extensions/Logger');
        const client = new TelegramClient(new StringSession(credentials.sessionString), credentials.apiId, credentials.apiHash, {
            connectionRetries: 0, requestRetries: 0, autoReconnect: false, baseLogger: new Logger(LogLevel.NONE),
        });
        let timeout: NodeJS.Timeout | undefined;
        try {
            const me = await Promise.race([
                (async () => { await client.connect(); return client.getMe(); })(),
                new Promise<never>((_, reject) => { timeout = setTimeout(() => reject(new Error('timeout')), 20_000); }),
            ]);
            if (String(me.id) !== ownerId) throw new Error('Different Telegram owner');
        } catch {
            throw new ApiError(400, 'invalid_telegram_session', 'Нужна действующая Telegram-сессия владельца этого бота.');
        } finally { clearTimeout(timeout); await client.destroy().catch(() => {}); }
    }
}

export function pairingOwner(update: Update, expectedHash: string): number | undefined {
    const message = update.message;
    const match = message?.text?.match(/^\/start(?:@[A-Za-z0-9_]+)? ([A-Za-z0-9_-]{43})$/);
    const id = message?.from?.id;
    if (message?.chat.type !== 'private' || message.from?.is_bot || !id || !Number.isSafeInteger(id) || id <= 0
        || message.chat.id !== id || !match || digest(match[1]) !== expectedHash) return undefined;
    return id;
}
