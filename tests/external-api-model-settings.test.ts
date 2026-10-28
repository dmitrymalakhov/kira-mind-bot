import assert from 'node:assert/strict';
import { test, type TestContext } from 'node:test';
import type { AddressInfo } from 'node:net';
import { Bot, InlineKeyboard } from 'grammy';
import { ApiBackend, ApiError, ApiOperationStore, ApiReply } from '../api/contracts';
import { createExternalApiServer } from '../api/server';
import { BotApiBackend } from '../api/backend';
import {
    API_AI_MODEL_PRESET_SETTING_KEY, ApiModelCatalog, BotSettingsApiModelStore, apiTurnPreset, buildApiModelSettings,
    saveApiModelSelection, type ApiModelSelection, type ApiModelSettingsStore,
} from '../api/modelSettings';
import { AppDataSource } from '../data-source';
import { TypeORMSessionStorage } from '../services/SessionStorage';
import { getActiveAiPresetName, refreshActiveAiPresetName, runWithChannelPreset } from '../services/aiRuntimeConfigService';
import { resolveModelForTaskAsync } from '../ai/modelResolver';
import { allowsCrossProviderFallback } from '../ai/runtimeSupport';
import * as orchestrator from '../orchestrator';
import * as history from '../utils/history';
import * as reconsolidation from '../services/MemoryReconsolidationService';
import type { AiPresetName } from '../ai/modelPresets';
import type { BotContext, SessionData } from '../types';

const token = 'synthetic-test-token-with-at-least-32-characters';
const owner = 730001;
const botToken = '1234567890:abcdefghijklmnopqrstuvwxyzABCDE';
const localModel = 'synthetic-local-model';

class MemoryStore implements ApiModelSettingsStore {
    selection: ApiModelSelection = { preset: null, revision: 'none' };
    async read() { return { ...this.selection }; }
    async write(preset: AiPresetName | null, expectedRevision: string) {
        if (expectedRevision !== this.selection.revision) throw new ApiError(409, 'revision_conflict', 'conflict');
        this.selection = { preset, revision: `rev-${Math.random().toString(36).slice(2)}` };
        return { ...this.selection };
    }
}

/** LM Studio as the admin catalog sees it: answering with one synthetic model, or not answering at all. */
const lmStudio = (reachable: boolean) => async () => {
    if (!reachable) throw new Error('synthetic: connection refused');
    return [{ id: localModel, loadedIds: [] }];
};

function withLocalModel(t: TestContext) {
    const previous = process.env.LM_STUDIO_MODEL;
    process.env.LM_STUDIO_MODEL = localModel;
    t.after(() => { if (previous === undefined) delete process.env.LM_STUDIO_MODEL; else process.env.LM_STUDIO_MODEL = previous; });
}

class Receipts implements ApiOperationStore {
    keys: string[] = [];
    async run(key: string, _fingerprint: string, work: () => Promise<ApiReply>) { this.keys.push(key); return work(); }
}

async function server(t: TestContext, changes: Partial<ApiBackend> = {}) {
    let executions = 0;
    const receipts = new Receipts();
    const backend: ApiBackend = {
        status: async () => ({ ok: true }), capabilities: async () => ({}), history: async () => ({}),
        reminders: async () => ({}), tasks: async () => ({}), file: async () => ({ data: Buffer.alloc(0), filename: 'x' }),
        message: async text => { executions++; return { messages: [{ id: -1, type: 'text', text }] }; },
        action: async () => ({ messages: [] }),
        modelSettings: async () => ({ scope: 'app' }), saveModelSettings: async body => ({ saved: body }),
        turnReady: async () => {},
        photoReady: async () => null, photo: async () => ({ messages: [] }),
        sceneCapabilities: async () => ({ version: 1 }), sceneReady: async () => null,
        sceneTurn: async () => ({ messages: [] }), sceneActionResult: async () => ({ ok: true }),
        ...changes,
    };
    const http = createExternalApiServer({ token, ownerId: owner, host: '127.0.0.1', port: 0 }, backend, receipts);
    await new Promise<void>(resolve => http.listen(0, '127.0.0.1', resolve));
    t.after(() => { http.closeAllConnections(); return new Promise<void>(resolve => http.close(() => resolve())); });
    const url = `http://127.0.0.1:${(http.address() as AddressInfo).port}/api/v1`;
    const request = (path: string, init: RequestInit = {}) => fetch(url + path, { ...init, headers: { Authorization: `Bearer ${token}`, ...init.headers } });
    return { url, request, receipts, executions: () => executions };
}

test('model settings need the owner token, accept only GET and a JSON PUT, and pass no client identity through', async t => {
    let saved: Record<string, unknown> | undefined;
    const s = await server(t, { saveModelSettings: async body => { saved = body; return { ok: true }; } });
    assert.equal((await fetch(s.url + '/model-settings')).status, 401);
    assert.equal((await fetch(s.url + '/model-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' }, body: '{}' })).status, 401);
    assert.deepEqual(await (await s.request('/model-settings')).json(), { scope: 'app' });
    const post = await s.request('/model-settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    assert.equal(post.status, 405);
    assert.equal(post.headers.get('allow'), 'GET, PUT');
    assert.equal((await s.request('/model-settings', { method: 'PUT', body: 'preset=x' })).status, 415);
    const put = await s.request('/model-settings', { method: 'PUT', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ preset: 'lmstudio-local', expectedRevision: 'none' }) });
    assert.equal(put.status, 200);
    assert.deepEqual(saved, { preset: 'lmstudio-local', expectedRevision: 'none' });
});

test('an unavailable app mode is refused before a receipt exists, so the message surely did not run', async t => {
    const s = await server(t, { turnReady: async () => { throw new ApiError(503, 'model_mode_unavailable', 'Режим недоступен'); } });
    const res = await s.request('/messages', { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'synthetic-key-001' },
        body: JSON.stringify({ text: 'Привет' }) });
    assert.equal(res.status, 503);
    assert.equal((await res.json()).error.code, 'model_mode_unavailable');
    assert.equal(s.executions(), 0);
    assert.deepEqual(s.receipts.keys, []);
});

test('saving validates against the server catalog: no unknown names, extra fields or unavailable modes', async t => {
    const store = new MemoryStore();
    const catalog = new ApiModelCatalog(process.env, lmStudio(false));
    for (const body of [{ preset: 'gpt-lean' }, { preset: 'gpt-lean', expectedRevision: 'none', userId: 1 },
                        { preset: 'gpt-lean', expectedRevision: 'none', baseUrl: 'http://evil' }, { preset: 5, expectedRevision: 'none' }]) {
        await assert.rejects(saveApiModelSelection(store, catalog, body), (e: any) => e.code === 'invalid_body');
    }
    await assert.rejects(saveApiModelSelection(store, catalog, { preset: 'my-own-model', expectedRevision: 'none' }), (e: any) => e.code === 'unknown_preset');
    // LM Studio down: the local modes are listed as unavailable with the reason, and cannot be chosen
    await assert.rejects(saveApiModelSelection(store, catalog, { preset: 'lmstudio-local', expectedRevision: 'none' }),
        (e: any) => e.code === 'preset_unavailable' && /не задан LM_STUDIO_MODEL|LM Studio/.test(e.message));
    const state = await saveApiModelSelection(store, catalog, { preset: 'gpt-lean', expectedRevision: 'none' }) as any;
    assert.equal(state.selection.preset, 'gpt-lean');
    assert.equal(state.effectivePreset, 'gpt-lean');
    assert.equal(state.server.allChannels, true);
    assert.equal(state.server.preset, 'gpt-balanced');   // the global mode is untouched
    const local = state.presets.find((p: any) => p.name === 'lmstudio-local');
    assert.equal(local.available, false);
    assert.ok(local.unavailableReason);
    assert.equal(local.cloudFallback, false);
    assert.ok(!JSON.stringify(state).includes('test'));     // no key from the environment leaks into the state
    // a stale revision is refused; null returns to the server's mode
    await assert.rejects(saveApiModelSelection(store, catalog, { preset: 'gpt-max', expectedRevision: 'none' }), (e: any) => e.code === 'revision_conflict');
    const back = await saveApiModelSelection(store, catalog, { preset: null, expectedRevision: state.selection.revision }) as any;
    assert.equal(back.selection.preset, null);
    assert.equal(back.effectivePreset, 'gpt-balanced');
});

test('local modes need LM Studio to answer with the routed model', async t => {
    withLocalModel(t);
    const up = await new ApiModelCatalog(process.env, lmStudio(true)).presets();
    assert.equal(up.find(p => p.name === 'lmstudio-local')!.available, true);
    assert.equal(up.find(p => p.name === 'lmstudio-local')!.runsLocally, true);
    const down = await new ApiModelCatalog(process.env, lmStudio(false)).presets();
    assert.match(down.find(p => p.name === 'lmstudio-local')!.unavailableReason!, /LM Studio недоступна/);
    const missing = await new ApiModelCatalog(process.env, async () => [{ id: 'other-model', loadedIds: [] }]).presets();
    assert.match(missing.find(p => p.name === 'hybrid-lmstudio-gpt')!.unavailableReason!, /нет модели/);
    assert.equal(down.find(p => p.name === 'gpt-balanced')!.available, true);   // cloud modes are unaffected
});

test('the selection survives a restart and saves are compare-and-set on the stored value', async t => {
    const rows = new Map<string, { key: string; value: string }>();
    const repo = {
        findOneBy: async ({ key }: any) => rows.get(key) ? { ...rows.get(key)! } : null,
        createQueryBuilder: () => {
            let values: any, set: any, where: any;
            const b: any = {
                insert: () => b, values: (v: any) => { values = v; return b; }, orIgnore: () => b, returning: () => b,
                update: () => b, set: (v: any) => { set = v; return b; }, where: (_sql: string, params: any) => { where = params; return b; },
                execute: async () => {
                    if (values) { if (rows.has(values.key)) return { raw: [] }; rows.set(values.key, { ...values }); return { raw: [{ key: values.key }] }; }
                    const row = rows.get(where.key);
                    if (!row || row.value !== where.old) return { affected: 0 };
                    row.value = set.value; return { affected: 1 };
                },
            };
            return b;
        },
    };
    t.mock.method(AppDataSource, 'getRepository', () => repo as any);
    const initialized = AppDataSource.isInitialized;
    (AppDataSource as any).isInitialized = true;
    t.after(() => { (AppDataSource as any).isInitialized = initialized; });
    const first = new BotSettingsApiModelStore();
    assert.deepEqual(await first.read(), { preset: null, revision: 'none' });
    const saved = await first.write('gpt-lean', 'none');
    const restarted = new BotSettingsApiModelStore();
    assert.deepEqual(await restarted.read(), saved);
    assert.ok(rows.has(API_AI_MODEL_PRESET_SETTING_KEY));
    await assert.rejects(restarted.write('gpt-max', 'none'), (e: any) => e.code === 'revision_conflict');
    // a concurrent writer changed the row between our read and our update
    const stale = (await restarted.read()).revision;
    rows.get(API_AI_MODEL_PRESET_SETTING_KEY)!.value = JSON.stringify({ preset: 'gpt-max', revision: 'someone-else' });
    await assert.rejects(restarted.write('gpt-lean', stale), (e: any) => e.code === 'revision_conflict');
    // an old or damaged stored value means "as on the server", never a guessed mode
    rows.get(API_AI_MODEL_PRESET_SETTING_KEY)!.value = '{"preset":"removed-preset","revision":"r1"}';
    assert.deepEqual(await restarted.read(), { preset: null, revision: 'r1' });
});

test('the app mode applies only inside its turn; Telegram, background timers and the global preset stay as they were', async t => {
    withLocalModel(t);
    assert.equal(await getActiveAiPresetName(), 'gpt-balanced');
    let timer: Promise<string> | undefined;
    await runWithChannelPreset('lmstudio-local', async () => {
        assert.equal(await getActiveAiPresetName(), 'lmstudio-local');
        assert.equal(await refreshActiveAiPresetName(), 'lmstudio-local');
        const { presetName, modelRef } = await resolveModelForTaskAsync('conversation');
        assert.equal(presetName, 'lmstudio-local');
        assert.equal(modelRef.provider, 'lmstudio');
        // deferred work started in the turn (memory analysis, reminders) runs after it on the server's mode
        timer = new Promise(resolve => setTimeout(async () => resolve(await getActiveAiPresetName()), 20));
    });
    assert.equal(await getActiveAiPresetName(), 'gpt-balanced');
    assert.equal(await timer, 'gpt-balanced');
    // the local mode never falls back to the cloud silently (true-full preset)
    assert.equal(allowsCrossProviderFallback('lmstudio-local'), false);
    assert.equal(allowsCrossProviderFallback('hybrid-lmstudio-gpt'), true);   // its cloud half is part of its name and description
});

test('a stored local mode that lost its configuration fails closed instead of answering from the cloud', async () => {
    const store = new MemoryStore();
    store.selection = { preset: 'lmstudio-local', revision: 'r1' };
    delete process.env.LM_STUDIO_MODEL;
    await assert.rejects(apiTurnPreset(store), (e: any) => e.status === 503 && e.code === 'model_mode_unavailable');
});

test('switching the mode keeps the API dialogue, the owner scope of memory and the persona between turns', async t => {
    withLocalModel(t);
    let stored: SessionData | undefined;
    t.mock.method(TypeORMSessionStorage.prototype, 'read', async () => stored && structuredClone(stored));
    t.mock.method(TypeORMSessionStorage.prototype, 'write', async (_key: string, session: SessionData) => { stored = structuredClone(session); });
    t.mock.method(history, 'addToHistory', async (ctx: BotContext, role: string, content: string) => {
        ctx.session.messageHistory.unshift({ role, content, timestamp: new Date() });
    });
    t.mock.method(reconsolidation, 'reconsolidateAfterResponse', async () => {});
    const seen: Array<{ preset: string; chat: number; key: string; earlier: string[] }> = [];
    t.mock.method(orchestrator, 'processMessage', async (ctx: BotContext, text: string) => {
        seen.push({ preset: await getActiveAiPresetName(), chat: ctx.chat!.id, key: ctx.sessionStorageKey!,
            earlier: ctx.session.messageHistory.map(item => item.content) });
        return { responseText: `Синтетический ответ на «${text}»`, keyboard: new InlineKeyboard() };
    });
    const bot = new Bot<BotContext>(botToken, { botInfo: { id: 1234567890, is_bot: true, first_name: 'Test', username: 'synthetic_bot' } as any });
    bot.api.config.use(async () => { throw new Error('No Telegram traffic expected'); });
    const store = new MemoryStore();
    const catalog = new ApiModelCatalog(process.env, lmStudio(true));
    const backend = new BotApiBackend(bot, { token, ownerId: owner, host: '127.0.0.1', port: 0 }, store, catalog);
    await backend.message('Синтетическая реплика один');
    const state = await buildApiModelSettings(store, catalog);
    await backend.saveModelSettings({ preset: 'lmstudio-local', expectedRevision: state.selection.revision });
    await backend.message('Синтетическая реплика два');
    assert.deepEqual(seen.map(s => s.preset), ['gpt-balanced', 'lmstudio-local']);
    assert.ok(seen.every(s => s.chat === owner && s.key === `api:${owner}`));   // same owner scope for shared memory
    assert.ok(seen[1].earlier.some(item => item.includes('реплика один')));      // the dialogue continued across the switch
    assert.equal(await getActiveAiPresetName(), 'gpt-balanced');                 // outside the app turn nothing changed
    const modes = await backend.modelSettings() as any;
    assert.equal(modes.selection.preset, 'lmstudio-local');
    assert.equal(modes.server.preset, 'gpt-balanced');
});
