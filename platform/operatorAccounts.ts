import type { IncomingMessage } from 'node:http';
import { createHmac } from 'node:crypto';
import { ApiError } from '../api/contracts';
import { readBody } from '../api/server';
import { digest, passwordHash, PlatformSecrets } from './crypto';
import type { Account, AccountStore } from './store';
import type { AccountRuntimes } from './runtime';
import type { BotConnections } from './botConnection';
import type { PublicOperatorBridge } from './publicAccounts/operatorBridge';
import { PublicReceipts } from './publicAccounts/receipts';
import { equalSecret } from './publicAccounts/webCookies';
import * as v from './publicAccounts/validation';
import type { TenantAdministration } from './administration';
import type { AccountDeletion } from './publicAccounts/deletion';
import { accountRevision, accountDisplayName } from './accountMetadata';

export interface ManagedAccountStore extends AccountStore {
    listManaged(): Promise<Account[]>;
    createManaged(username: string, hash: string, keyHash: string, fingerprint: string): Promise<Account>;
    renameManaged?(id:string,displayName:string,revision:string):Promise<Account>;
}

/** Private server-to-server surface. The bridge secret alone never grants operator authority. */
export class OperatorAccountsHttp {
    constructor(private store: ManagedAccountStore, private secrets: PlatformSecrets, private runtimes: AccountRuntimes,
        private bots: BotConnections, private receipts: Pick<PublicReceipts, 'run'>,
        private options: { username: string; password: string; capacity: number; bridgeSecret?: string; operator?: PublicOperatorBridge; administration?: TenantAdministration; deletion?:AccountDeletion }) {}

    private async authorize(req: IncomingMessage, raw: unknown): Promise<string> {
        const auth = v.object(raw);
        if (auth.kind === 'password') {
            v.fields(auth, ['kind', 'username', 'password'], ['username', 'password']);
            if (!this.options.username || !this.options.password
                || !equalSecret(v.text(auth.username, 1, 100), this.options.username)
                || !equalSecret(v.text(auth.password, 1, 256), this.options.password)) {
                throw new ApiError(401, 'unauthorized', 'Нужен вход оператора.');
            }
            return 'password';
        }
        if (auth.kind === 'account') {
            v.fields(auth, ['kind', 'accessToken', 'browserCookie'], ['accessToken', 'browserCookie']);
            const supplied = req.headers['x-kira-operator-bridge'];
            if (!this.options.operator || !this.options.bridgeSecret || typeof supplied !== 'string'
                || !equalSecret(supplied, this.options.bridgeSecret)) throw new ApiError(401, 'unauthorized', 'Нужен вход оператора.');
            const current = await this.options.operator.introspect(v.text(auth.accessToken, 32, 128), v.text(auth.browserCookie, 32, 128));
            if (!current.authorized || !current.accountId) throw new ApiError(403, 'forbidden', 'Нет доступа оператора.');
            return current.accountId;
        }
        throw new ApiError(401, 'unauthorized', 'Нужен вход оператора.');
    }

    private view(account: Account) {
        const expired = account.pairing_expires && new Date(account.pairing_expires).getTime() <= Date.now();
        const runtime = this.runtimes.status(account.id);
        const pending = ['waiting','ready','starting','restarting','pairing_expired'].includes(runtime) ? 'awaiting_telegram' : runtime;
        const status = account.owner_id || account.runtime_mode === 'api_only' ? runtime
            : account.bot_id ? expired ? 'pairing_expired' : pending : 'not_connected';
        return { id: account.id, username: account.username, accountState: account.account_state || 'active',
            displayName:account.display_name || account.username,revision:accountRevision(account),canDelete:Boolean(this.options.deletion),
            canReplaceBot:Boolean(account.owner_id && account.runtime_mode!=='api_only' && (account.account_state || 'active')==='active'),
            runtimeMode: account.runtime_mode || 'telegram', status,
            bot: account.bot_id ? { username: account.bot_username, connected: Boolean(account.owner_id) } : null,
            canConnectBot: !account.owner_id && account.runtime_mode !== 'api_only' && (account.account_state || 'active') === 'active' };
    }

    async route(req: IncomingMessage, path: string, json: (status: number, body: unknown) => void): Promise<boolean> {
        if (path !== '/internal/operator/accounts') return false;
        if (req.url !== path) throw new ApiError(404, 'not_found', 'Ресурс не найден.');
        if (req.method !== 'POST') throw new ApiError(405, 'method_not_allowed', 'Ожидается POST.');
        const body = await readBody(req,128*1024);
        v.fields(body, ['version', 'operator', 'operation', 'input', 'requestKey'], ['version', 'operator', 'operation', 'input']); v.version(body);
        const actor = await this.authorize(req, body.operator);
        const input = v.object(body.input);
        if(['rename','delete','replace_bot'].includes(String(body.operation))){
            const operation=String(body.operation);
            v.fields(input,operation==='rename'?['accountId','displayName','revision']:operation==='replace_bot'?['accountId','botToken','confirmation','revision']:['accountId','confirmation','revision']);
            const id=v.uuid(input.accountId),revision=v.text(input.revision,64,64),key=v.idempotency(body.requestKey);
            if(!/^[0-9a-f]{64}$/.test(revision))v.invalid();
            if(operation==='delete'){
                if(!this.options.deletion)throw new ApiError(503,'deletion_unavailable','Удаление на сервере не настроено.');
                const result=await this.options.deletion.requestByOperator(id,v.text(input.confirmation,3,40),revision);
                json(202,result);return true;
            }
            const target=await this.store.byId(id);
            if(!target || ['deleting','deleted'].includes(target.account_state || ''))throw new ApiError(404,'account_not_found','Аккаунт недоступен.');
            const data=operation==='rename'?{displayName:accountDisplayName(input.displayName),revision}
                :{botToken:v.text(input.botToken,1,128),confirmation:v.text(input.confirmation,3,40),revision};
            await this.receipts.run(id,`operator:${actor}:${key}`,operation==='rename'?'PATCH':'POST',operation==='rename'?'/account/name':'/account/bot/replacement',data,async()=>{
                if(operation==='rename'){
                    if(!this.store.renameManaged)throw new ApiError(503,'administration_unavailable','Переименование недоступно.');
                    await this.store.renameManaged(id,data.displayName!,revision);
                }else{
                    await this.bots.replace(id,data.botToken!,revision,data.confirmation!);
                    await this.runtimes.restart(id);
                }
                return {changed:true};
            });
            const account=await this.store.byId(id);
            if(!account || ['deleting','deleted'].includes(account.account_state || ''))throw new ApiError(404,'account_not_found','Аккаунт недоступен.');
            json(200,{version:1,account:this.view(account)});return true;
        }
        if (['scope','settings','restart','quota','embedding'].includes(String(body.operation))) {
            const administration = this.options.administration;
            if (!administration) throw new ApiError(503, 'administration_unavailable', 'Управление аккаунтом временно недоступно.');
            v.fields(input, body.operation === 'settings' ? ['accountId','updates','revision'] : body.operation==='embedding'?['accountId','text','profile']:['accountId'], ['accountId']);
            const id = v.uuid(input.accountId);
            const result = body.operation === 'scope' ? { scope: await administration.context(id) }
                : body.operation === 'settings' ? await administration.settings(id, input.updates, v.text(input.revision, 64, 64))
                : body.operation === 'restart' ? await administration.restart(id)
                : body.operation === 'embedding' ? await administration.embedding(id,v.text(input.text,1,20000),v.text(input.profile,1,100),v.idempotency(body.requestKey)) : await administration.quota(id);
            json(200, { version: 1, ...result }); return true;
        }
        if (body.operation === 'list') {
            v.fields(input, []);
            json(200, { version: 1, available: true, capacity: this.options.capacity, accounts: (await this.store.listManaged()).map(a => this.view(a)) });
            return true;
        }
        if (body.operation === 'create') {
            v.fields(input, ['username', 'password'], ['username', 'password']);
            const username = v.text(input.username, 3, 40).toLowerCase(), password = v.text(input.password, 12, 256);
            if (!/^[a-z0-9_]+$/.test(username)) throw new ApiError(400, 'invalid_username', 'Логин: 3–40 латинских букв, цифр или _.');
            const key = v.idempotency(body.requestKey);
            // A keyed fingerprint avoids retaining a password-derived dictionary oracle.
            const fingerprint = createHmac('sha256', this.secrets.derive('operator-accounts', 'api')).update(v.canonicalJson({ username, password })).digest('hex');
            const account = await this.store.createManaged(username, await passwordHash(password), digest(`${actor}:${key}`), fingerprint);
            json(201, { version: 1, account: this.view(account) }); return true;
        }
        if (body.operation !== 'connect' && body.operation !== 'pairing') throw new ApiError(400, 'invalid_operation', 'Неизвестное действие.');
        v.fields(input, body.operation === 'connect' ? ['accountId', 'botToken'] : ['accountId'], body.operation === 'connect' ? ['accountId', 'botToken'] : ['accountId']);
        const id = v.uuid(input.accountId);
        let account = await this.store.byId(id);
        if (!account || ['deleting', 'deleted'].includes(account.account_state || '')) throw new ApiError(404, 'account_not_found', 'Аккаунт не найден.');
        if (body.operation === 'connect') {
            const token = v.text(input.botToken, 1, 128), key = v.idempotency(body.requestKey);
            await this.receipts.run(id, `operator:${actor}:${key}`, 'PUT', '/account/bot', { botToken: token }, async () => {
                await this.bots.connect(id, token);
                // Never put a pairing URL or bot token in a plaintext receipt.
                return { connected: true };
            });
            account = (await this.store.byId(id))!;
        }
        if (!account || ['deleting', 'deleted'].includes(account.account_state || '')) throw new ApiError(404, 'account_not_found', 'Аккаунт не найден.');
        json(body.operation === 'connect' ? 202 : 200, { version: 1, account: this.view(account), pairing: this.bots.pairing(account) });
        return true;
    }
}
