import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { Bot } from 'grammy';
import type { BotContext } from '../types';
import { registerAccountConsentHandlers } from '../handlers/accountConsent';
import { attachAccountAuthority } from '../platform/publicAccounts/runtimeBridge';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { publicTestPort, publicTestConfig, withPublicRegistry } from './support/publicAccounts';

function consentBot() {
    let clock = Date.parse('2037-05-01T12:00:00Z'), seq = 1, accepted = false, fail = false;
    let catalog = { version: 'synthetic-consent-v1', recipients: [{ id: 'synthetic-ai', name: 'Synthetic AI <provider>',
        data: ['messages', 'images'], purposes: ['answers'], policyUrl: 'https://synthetic.example.invalid/privacy' }] };
    const writes: any[] = [], sends: Array<{ method: string; payload: any }> = [];
    const bot = new Bot<BotContext>('111111:abcdefghijklmnopqrstuvwxyzABCDE', { botInfo: { id: 111111, is_bot: true, first_name: 'Synthetic', username: 'synthetic_bot' } as any });
    bot.api.config.use(async (previous, method, payload) => {
        sends.push({ method, payload });
        return { ok: true, result: method === 'answerCallbackQuery' ? true : { message_id: seq++, date: 1, chat: { id: 10001, type: 'private' }, text: 'Synthetic' } } as any;
    });
    registerAccountConsentHandlers(bot, { ownerId: 10001, key: 'synthetic-account-key', now: () => clock,
        authority: async (operation, data) => {
            if (fail) throw Error('synthetic-provider-secret');
            assert.equal(data.ownerId, 10001);
            if (operation === 'consent-write') { writes.push(data); accepted = (data.consent as any).accepted; }
            return { catalog, aiAllowed: accepted };
        } });
    const message = (text = '/ai_consent', id = 10001, group = false) => bot.handleUpdate({ update_id: seq++, message: {
        message_id: seq++, date: 1, chat: { id, type: group ? 'group' : 'private' }, from: { id, is_bot: false, first_name: 'Synthetic Owner' },
        text, entities: [{ type: 'bot_command', offset: 0, length: text.split(' ')[0].length }],
    } } as any);
    const click = (data: string, id = 10001, group = false) => bot.handleUpdate({ update_id: seq++, callback_query: { id: 'synthetic_callback', data,
        chat_instance: 'synthetic_chat_instance', from: { id, is_bot: false, first_name: 'Synthetic Owner' },
        message: { message_id: 9, date: 1, chat: { id, type: group ? 'group' : 'private' }, text: 'Synthetic consent' } } } as any);
    const buttons = () => sends.flatMap(send => send.payload.reply_markup?.inline_keyboard?.flat() || []);
    return { message, click, buttons, writes, sends, fail: () => { fail = true; }, expire: () => { clock += 25 * 3600_000; },
        replaceCatalog: () => { catalog = { ...catalog, version: 'synthetic-consent-v2' }; }, emptyCatalog: () => { catalog = { ...catalog, recipients: [] }; } };
}

test('a paired Telegram owner can review the complete catalog and explicitly accept or revoke AI consent without mobile or AI calls', async () => {
    const h = consentBot();
    await h.message('/start ai_consent');
    const [refuse, allow] = h.buttons(); assert.ok(allow); assert.ok(refuse);
    const shown = JSON.stringify(h.sends);
    assert.match(shown, /Synthetic AI &lt;provider&gt;/); assert.match(shown, /messages, images/); assert.match(shown, /synthetic.example.invalid\/privacy/);
    assert.equal(h.writes.length, 0);
    assert.ok(Buffer.byteLength(allow.callback_data) <= 64);
    await h.click(allow.callback_data);
    assert.deepEqual(h.writes[0].consent, { version: 1, consentVersion: 'synthetic-consent-v1', accepted: true, recipientIds: ['synthetic-ai'] });
    await h.message();
    await h.click(h.buttons().slice(-2)[0].callback_data);
    assert.equal(h.writes.length, 2); assert.equal(h.writes[1].consent.accepted, false); assert.deepEqual(h.writes[1].consent.recipientIds, []);
});
test('Telegram consent refuses other users, groups, forged, expired and superseded decisions and keeps failures distinct from acceptance', async () => {
    for (const kind of ['other','group','forged','expired','changed','unavailable']) {
        const h = consentBot(); await h.message(); const allow = h.buttons()[1].callback_data;
        if (kind === 'expired') h.expire();
        if (kind === 'changed') h.replaceCatalog();
        if (kind === 'unavailable') h.fail();
        await h.click(kind === 'forged' ? allow.slice(0, -1) + (allow.endsWith('a') ? 'b' : 'a') : allow, kind === 'other' ? 10002 : 10001, kind === 'group');
        assert.equal(h.writes.length, 0, kind);
        assert.doesNotMatch(JSON.stringify(h.sends), /synthetic-provider-secret/);
    }
    const h = consentBot(); await h.message('/ai_consent', 10002); await h.message('/ai_consent', 10001, true);
    assert.equal(h.sends.length, 0);
    h.fail(); await h.message(); assert.equal(h.writes.length, 0); assert.match(JSON.stringify(h.sends), /Не удалось прочитать/);
});
test('an unconfigured AI recipient catalog cannot offer an acceptance button or infer consent from opening the command', async () => {
    const h = consentBot(); h.emptyCatalog(); await h.message();
    assert.equal(h.buttons().length, 1); assert.match(h.buttons()[0].callback_data, /^account_ai:no:/);
    assert.equal(h.writes.length, 0); assert.match(JSON.stringify(h.sends), /Список получателей ещё не настроен/);
});
test('parent authority binds Telegram consent to its actual account and confirmed owner, preserving isolation and autonomous defaults', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const account = await store.createManaged('synthetic_consent', 'synthetic-unused-hash', 'synthetic-key', 'synthetic-fingerprint');
        await db.query('UPDATE kira_accounts SET owner_id=$2 WHERE id=$1', [account.id, '10001']);
        const policy = new PublicAccountPolicy(db, () => publicTestConfig());
        const child = new EventEmitter() as any; child.connected = true;
        const answers = new Map<string, (data: any) => void>(); child.send = (data: any) => { answers.get(data.id)?.(data); };
        attachAccountAuthority(child, account.id, db, policy, {} as any);
        const call = (operation: string, data: any) => new Promise<any>(resolve => {
            const id = require('node:crypto').randomUUID(); answers.set(id, resolve); child.emit('message', { type: 'kira-account-request', id, operation, data });
        });
        assert.equal((await call('consent-read', { ownerId: 10002 })).ok, false);
        const state = await call('consent-read', { ownerId: 10001 }); assert.equal(state.result.aiAllowed, false);
        const catalog = state.result.catalog;
        const consent = { version: 1, accepted: true, consentVersion: catalog.version, recipientIds: catalog.recipients.map((r: any) => r.id) };
        assert.equal((await call('consent-write', { ownerId: 10002, consent })).ok, false);
        assert.equal((await call('consent-write', { ownerId: 10001, consent, accountId: 'other' })).ok, false);
        assert.equal((await call('consent-write', { ownerId: 10001, consent })).result.aiAllowed, true);
        assert.equal((await store.byId(account.id))!.autonomous_ai_enabled, false);
        await db.query("UPDATE kira_accounts SET account_state='deleting' WHERE id=$1", [account.id]);
        assert.equal((await call('consent-read', { ownerId: 10001 })).ok, false);
    });
});
