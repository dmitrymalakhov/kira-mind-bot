import { ApiError } from '../api/contracts';
import { digest, newToken, PlatformSecrets } from './crypto';
import type { Account, AccountStore } from './store';
import type { TenantCredentials } from './runtime';
import type { TelegramGateway } from './telegram';
import { checkAccountRevision } from './accountMetadata';

/** Shared by the account API and the operator console. HTTP never supplies an owner ID. */
export class BotConnections {
    private connecting = new Set<string>();
    constructor(private store: AccountStore, private secrets: PlatformSecrets, private telegram: Pick<TelegramGateway, 'verify'>,
        private reservedBotIds: string[] = []) {}

    async connect(id: string, token: string) {
        if (this.connecting.has(id)) throw new ApiError(409, 'connection_busy', 'Подключение уже выполняется.');
        this.connecting.add(id);
        try {
            const account = await this.store.byId(id);
            if (!account || ['deleting', 'deleted'].includes(account.account_state || '')) throw new ApiError(404, 'account_not_found', 'Аккаунт не найден.');
            if (account.runtime_mode === 'api_only') throw new ApiError(409, 'runtime_mode_fixed', 'Этот аккаунт работает без личного Telegram-бота.');
            if (account.owner_id) throw new ApiError(409, 'bot_already_connected', 'Бот уже подключён.');
            if (account.account_state === 'restricted') throw new ApiError(403, 'account_restricted', 'Аккаунт ограничен.');
            const bot = await this.telegram.verify(token);
            if (this.reservedBotIds.includes(String(bot.id))) throw new ApiError(409, 'bot_unavailable', 'Этот бот зарезервирован администратором.');
            const pairingCode = newToken();
            const credentials = account.secrets ? this.secrets.open<TenantCredentials>(account.secrets, id) : {};
            await this.store.connect(id, String(bot.id), bot.username, this.secrets.seal({ ...credentials, botToken: token, pairingCode }, id), digest(pairingCode));
            return { status: 'awaiting_telegram', pairingUrl: `https://t.me/${bot.username}?start=${pairingCode}`, expiresIn: 900 };
        } finally { this.connecting.delete(id); }
    }

    pairing(account: Account): { pairingUrl: string; expiresAt: string } | null {
        if (account.owner_id || !account.secrets || !account.bot_username || !account.pairing_hash || !account.pairing_expires
            || new Date(account.pairing_expires).getTime() <= Date.now()) return null;
        const credentials = this.secrets.open<TenantCredentials>(account.secrets, account.id);
        if (!credentials.pairingCode || digest(credentials.pairingCode) !== account.pairing_hash) return null;
        return { pairingUrl: `https://t.me/${account.bot_username}?start=${credentials.pairingCode}`, expiresAt: new Date(account.pairing_expires).toISOString() };
    }

    async replace(id: string, token: string, revision: string, confirmation: string) {
        if(this.connecting.has(id))throw new ApiError(409,'connection_busy','Подключение уже выполняется.');
        this.connecting.add(id);
        try {
            const account=await this.store.byId(id);
            if(!account || ['deleting','deleted'].includes(account.account_state || ''))throw new ApiError(404,'account_not_found','Аккаунт не найден.');
            checkAccountRevision(account,revision);
            if(confirmation!==account.username)throw new ApiError(400,'confirmation_required','Введи логин выбранного аккаунта.');
            if(account.runtime_mode==='api_only')throw new ApiError(409,'runtime_mode_fixed','Этот аккаунт работает без Telegram-бота.');
            if(!account.owner_id || !account.secrets || !account.bot_id)throw new ApiError(409,'bot_not_paired','Сначала заверши подключение владельца.');
            if(account.account_state==='restricted')throw new ApiError(403,'account_restricted','Аккаунт ограничен.');
            if(!this.store.replaceBot)throw new ApiError(503,'administration_unavailable','Замена бота недоступна.');
            const bot=await this.telegram.verify(token);
            if(String(bot.id)!==account.bot_id && this.reservedBotIds.includes(String(bot.id)))throw new ApiError(409,'bot_unavailable','Этот бот зарезервирован.');
            const credentials=this.secrets.open<TenantCredentials>(account.secrets,id);
            if(String(bot.id)!==account.bot_id)credentials.legacyTelegramBotId ||= account.bot_id;
            credentials.botToken=token;delete credentials.pairingCode;
            await this.store.replaceBot(account,String(bot.id),bot.username,this.secrets.seal(credentials,id));
        } finally { this.connecting.delete(id); }
    }
}
