import { digest } from './crypto';
import type { Account } from './store';
import { canonicalJson } from './publicAccounts/validation';
import { ApiError } from '../api/contracts';

/** A lifecycle form must still refer to the same owner, bot and credentials. */
export function accountRevision(account: Account): string {
    return digest(canonicalJson({id:account.id,username:account.username,name:account.display_name || null,
        state:account.account_state || 'active',bot:account.bot_id,botUsername:account.bot_username,
        owner:account.owner_id,credentials:account.secrets}));
}
export function checkAccountRevision(account: Account, revision: string): void {
    if (accountRevision(account) !== revision) throw new ApiError(409,'account_changed','Аккаунт изменился. Обнови список перед повтором.');
}
export function accountDisplayName(raw: unknown): string {
    if (typeof raw !== 'string') throw new ApiError(400,'invalid_display_name','Укажи название аккаунта.');
    const name=raw.trim().normalize('NFC');
    if (!name || [...name].length>80 || /[\u0000-\u001f\u007f-\u009f\u202a-\u202e\u2066-\u2069]/.test(name))
        throw new ApiError(400,'invalid_display_name','Название: от 1 до 80 символов, без управляющих знаков.');
    return name;
}
