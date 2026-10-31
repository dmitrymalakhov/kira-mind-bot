import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LiveBrowserSession, LiveBrowserRegistry, BrowserInterrupted, type BrowserInput, type BrowserPageInfo } from '../services/liveBrowserSession';
import { browserUtterance, type BrowserControlMeaning } from '../services/liveBrowserConversation';

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
async function fixture(t: any, scope = 'api:94001') {
    let now = 10_000;
    const session = new LiveBrowserSession(94001, scope, 'synthetic-operation', () => now);
    const observer = session.requiresObserver ? randomUUID() : session.telegramObserverId, other = randomUUID(); const inputs: BrowserInput[] = []; const events: any[] = [];
    let closed = 0;
    const page: BrowserPageInfo = { pageId: randomUUID(), navigationEpoch: 1, viewportRevision: 1, title: 'Synthetic restaurant',
        url: 'https://restaurant.example/', origin: 'https://restaurant.example', viewport: { width: 1280, height: 720, deviceScaleFactor: 1 }, focus: { editable: true, kind: 'text' } };
    session.attach({ inspect: async () => structuredClone(page), capture: async () => ({ page: structuredClone(page), jpeg: Buffer.from('synthetic-frame'), width: 1280, height: 720 }),
        input: async input => { inputs.push(input); }, close: async () => { closed++; } });
    session.registerObserver(observer); session.registerObserver(other);
    const disconnect = session.subscribe(observer, event => { events.push(event); return true; }, () => {});
    await new Promise(r => setImmediate(r));
    const command = (type: string, extra: Record<string, unknown> = {}, key = randomUUID()) => session.command(key,
        { type, observerId: observer, expectedRevision: session.snapshot().revision, ...extra });
    const refresh = async () => { now += 1001; await session.capture(); };
    const take = async () => { const ack = await command('take_control'); await refresh(); return ack.session.control.leaseId; };
    const body = (lease: string | null) => { const s = session.snapshot(), f = s.frame!; return { observerId: observer, leaseId: lease,
        expectedRevision: s.revision, frameSeq: f.frameSeq, pageId: f.pageId, navigationEpoch: f.navigationEpoch, viewportRevision: f.viewportRevision,
        input: { type: 'tap', x: 120, y: 70 } }; };
    t.after(() => session.dispose());
    return { session, observer, other, inputs, events, page, command, refresh, take, body, disconnect, closed: () => closed, advance: (ms: number) => { now += ms; } };
}

test('account and channel scopes cannot discover or control another session; one canonical task per owner', () => {
    const registry = new LiveBrowserRegistry(); const session = registry.create(94001, 'api:94001', 'request-1');
    assert.equal(registry.active(94002, 'api:94002'), null);
    assert.throws(() => registry.get(94002, 'api:94002', session.id), /Сессия недоступна/);
    assert.throws(() => registry.get(94001, 'telegram', session.id), /Сессия недоступна/);
    assert.throws(() => registry.create(94001, 'telegram', 'request-2'), /уже открыта/);
    session.dispose();
});

test('takeover revokes future agent operations before granting user control and drains the operation already in flight', async t => {
    const f = await fixture(t), pending = deferred();
    const generation = f.session.generation;
    const action = f.session.agentCall(generation, () => pending.promise).catch(error => error);
    const takeover = f.command('take_control');
    await new Promise(r => setImmediate(r));
    assert.equal(f.session.state, 'pausing');
    assert.throws(() => f.session.agentCall(generation, () => 'late click'), BrowserInterrupted);
    assert.equal(f.session.snapshot().control.leaseId, null);
    pending.resolve(); await action; const ack = await takeover;
    assert.equal(ack.session.state, 'user_control'); assert.ok(ack.session.control.leaseId);
    assert.equal(ack.session.inFlight, false);
});

test('input binds current frame/page/viewport/revision and duplicate input never submits twice', async t => {
    const f = await fixture(t), lease = await f.take(), body = f.body(lease), key = randomUUID();
    const first = await f.session.humanInput(key, body);
    assert.equal(first.accepted, true); assert.equal(f.inputs.length, 1);
    assert.deepEqual(await f.session.humanInput(key, body), first); assert.equal(f.inputs.length, 1);
    await assert.rejects(f.session.humanInput(key, { ...body, input: { type: 'key', key: 'Enter' } }), /другим запросом/);
    await assert.rejects(f.session.humanInput(randomUUID(), body), /Обнови состояние/);
    await f.refresh(); const changedPage = f.body(lease); f.page.navigationEpoch++;
    await assert.rejects(f.session.humanInput(randomUUID(), changedPage), /Обнови состояние|Кадр устарел/);
    assert.equal(f.inputs.length, 1);
});

test('expired frames, off-viewport coordinates, resize, wrong lease and viewer input fail closed', async t => {
    const f = await fixture(t), lease = await f.take();
    await assert.rejects(f.session.humanInput(randomUUID(), { ...f.body(lease), observerId: f.other }), /Открой браузер|другое устройство/);
    await assert.rejects(f.session.humanInput(randomUUID(), { ...f.body(lease), leaseId: randomUUID() }), /Право управления/);
    await assert.rejects(f.session.humanInput(randomUUID(), { ...f.body(lease), input: { type: 'tap', x: -1, y: 0 } }), /координаты/);
    const old = f.body(lease); f.advance(2500);
    await assert.rejects(f.session.humanInput(randomUUID(), old), /Кадр устарел/);
    await f.refresh(); const resized = f.body(lease); f.page.viewport.width = 900; f.page.viewportRevision++;
    await assert.rejects(f.session.humanInput(randomUUID(), resized), /Обнови состояние|Кадр устарел/);
    assert.equal(f.inputs.length, 0);
});

test('two observers: viewer disconnect leaves controller active; controller disconnect pauses and reconnect does not resume', async t => {
    const f = await fixture(t); const disconnectOther = f.session.subscribe(f.other, () => true, () => {});
    const lease = await f.take(); assert.ok(lease);
    disconnectOther(); await new Promise(r => setImmediate(r)); assert.equal(f.session.state, 'user_control');
    f.disconnect(); await new Promise(r => setImmediate(r)); assert.equal(f.session.state, 'disconnected');
    f.session.subscribe(f.observer, () => true, () => {});
    assert.equal(f.session.state, 'disconnected'); assert.equal(f.session.snapshot().control.leaseId, null);
});

test('stop is idempotent during in-flight work; late completion cannot resurrect the session', async t => {
    const f = await fixture(t), pending = deferred(), generation = f.session.generation;
    const action = f.session.agentCall(generation, () => pending.promise).catch(error => error);
    const key = randomUUID(), body = { type: 'stop', expectedRevision: -10 };
    const ack = await f.session.command(key, body); assert.equal(ack.session.state, 'cancelled');
    assert.deepEqual(await f.session.command(key, body), ack);
    pending.resolve(); await action; f.session.finish('completed', generation);
    assert.equal(f.session.state, 'cancelled'); assert.equal(f.closed(), 1);
    await assert.rejects(f.command('resume'), /Сессия завершена/);
});

test('ordered real frame events reconnect with a current snapshot; old connection closure cannot revoke its replacement', async t => {
    const f = await fixture(t); await f.refresh();
    const before = f.events.at(-1).seq; const newer: any[] = [];
    f.session.subscribe(f.observer, event => { newer.push(event); return true; }, () => {}, before);
    f.disconnect(); assert.equal(f.session.state, 'running');
    assert.equal(newer[0].event, 'snapshot'); assert.ok(newer[0].seq >= before);
    await f.refresh(); const frame = newer.find(e => e.event === 'frame');
    assert.ok(frame); assert.equal(frame.frame.pageId, frame.session.page.pageId);
    assert.equal(frame.frame.revision, frame.session.revision);
    assert.ok(frame.seq > newer[0].seq);
});

test('confirmation is action-specific; explicit rejection pauses, generic resume does not consent', async t => {
    const f = await fixture(t);
    assert.equal(await f.session.requireConfirmation({ target: 'synthetic-submit' }, 'Отправить тестовую заявку?'), false);
    const pending = f.session.snapshot().pendingConfirmation!; assert.ok(pending);
    await assert.rejects(f.command('resume'), /отдельное подтверждение/);
    await assert.rejects(f.command('confirm', { confirmationId: pending.confirmationId }), /accept или reject/);
    const rejected = await f.command('confirm', { confirmationId: pending.confirmationId, decision: 'reject' });
    assert.equal(rejected.session.state, 'paused'); assert.equal(rejected.session.pendingConfirmation, null);
    await assert.rejects(f.command('confirm', { confirmationId: pending.confirmationId, decision: 'accept' }), /устарело/);
});

test('UI, typed and voice pause/stop share revocation; page revision changes do not starve semantic interruption', async t => {
    for (const source of ['button','text','voice'] as const) for (const action of ['pause','stop'] as const) {
        const f = await fixture(t), generation = f.session.generation;
        if (source === 'button') await f.command(action);
        else {
            const pending = deferred<BrowserControlMeaning>();
            const text = action === 'pause' ? 'Погоди с этой формой, я пока хочу подумать' : 'Я передумал, больше ничего на сайте не делай';
            const p = browserUtterance(f.session, randomUUID(), { observerId: f.observer, expectedRevision: f.session.snapshot().revision, text, source,
                assistanceRequestId: randomUUID() }, async () => pending.promise);
            await new Promise(r => setImmediate(r)); f.session.pageChanged();
            pending.resolve({ intent: action, evidence: text, confidence: 1, reply: 'Принято.' }); await p;
        }
        assert.equal(f.session.state, action === 'pause' ? 'paused' : 'cancelled');
        assert.throws(() => f.session.assertAgent(generation), BrowserInterrupted);
    }
});

test('late semantic resume and help answers cannot act after stop; current help answers stay in the original task', async t => {
    const f = await fixture(t); await f.session.needsUser('На сколько человек нужен стол?', 'information');
    const assistance = f.session.snapshot().assistanceRequest!;
    let resumed = '';
    f.session.resume = async answer => { resumed = answer; };
    const pending = deferred<BrowserControlMeaning>();
    const body = { observerId: f.observer, expectedRevision: f.session.snapshot().revision, assistanceRequestId: assistance.requestId, text: 'На четверых', source: 'voice' };
    const p = browserUtterance(f.session, randomUUID(), body, async () => pending.promise);
    await new Promise(r => setImmediate(r)); await f.command('stop');
    pending.resolve({ intent: 'answer', evidence: 'На четверых', confidence: 1, reply: 'Поняла.' });
    await assert.rejects(p, /Состояние изменилось/); assert.equal(resumed, '');
    await assert.rejects(f.session.answerAssistance(randomUUID(), body, body.text), /прежнему вопросу/);
});

test('Telegram sessions use the same generation gate and assistance without an iPhone heartbeat', async t => {
    const f = await fixture(t, '94001'); f.advance(20_000); await f.session.tick();
    assert.equal(f.session.state, 'running');
    await f.session.command(randomUUID(), f.session.telegramBody({ type: 'pause' })); assert.equal(f.session.state, 'paused');
    f.session.resume = async () => {};
    await f.session.command(randomUUID(), f.session.telegramBody({ type: 'resume' })); assert.equal(f.session.state, 'running');
    f.advance(16 * 60_000); await f.session.tick(); assert.equal(f.session.state, 'cancelled');
});

test('an answer to replaced question A never binds to current question B', async t => {
    const f = await fixture(t); await f.session.needsUser('Сколько гостей?', 'information');
    const oldId = f.session.snapshot().assistanceRequest!.requestId;
    await f.session.needsUser('Какое время?', 'information');
    let resumed = false; f.session.resume = async () => { resumed = true; };
    await assert.rejects(browserUtterance(f.session, randomUUID(), { observerId: f.observer, expectedRevision: f.session.snapshot().revision,
        assistanceRequestId: oldId, source: 'text', text: 'Четыре' }, async text => ({ intent: 'answer', confidence: 1, evidence: text, reply: 'Поняла' })),
        (error: any) => error.status === 410);
    assert.equal(resumed, false); assert.equal(f.session.state, 'needs_user');
});

test('Stop during awaited resume privacy check cannot resurrect the browser', async t => {
    const f = await fixture(t), pending = deferred(); await f.command('pause');
    f.session.adapter!.readyToResume = () => pending.promise;
    let resumed = false; f.session.resume = async () => { resumed = true; };
    const resume = f.command('resume'); await new Promise(r => setImmediate(r));
    await f.command('stop'); pending.resolve();
    await assert.rejects(resume, /Состояние изменилось/);
    assert.equal(resumed, false); assert.equal(f.session.state, 'cancelled');
});

test('navigation invalidates a pending question or confirmation without leaving an unanswerable state', async t => {
    const f = await fixture(t);
    await f.session.needsUser('Какое время выбрать?', 'information'); const request = f.session.snapshot().assistanceRequest!;
    f.session.pageChanged(); assert.equal(f.session.state, 'paused'); assert.equal(f.session.snapshot().assistanceRequest, null);
    await assert.rejects(f.session.answerAssistance(randomUUID(), { assistanceRequestId: request.requestId }, '19:30'), /прежнему вопросу/);
    await f.session.requireConfirmation({ target: 'test-submit' }, 'Отправить?'); f.session.pageChanged();
    assert.equal(f.session.state, 'paused'); assert.equal(f.session.snapshot().pendingConfirmation, null);
});

test('a second observer cannot acquire a lease while the first takeover is draining', async t => {
    const f = await fixture(t), pending = deferred(); f.session.subscribe(f.other, () => true, () => {});
    const action = f.session.agentCall(f.session.generation, () => pending.promise).catch(() => {});
    const first = f.command('take_control'); await new Promise(r => setImmediate(r));
    await assert.rejects(f.session.command(randomUUID(), { type: 'take_control', observerId: f.other, expectedRevision: f.session.snapshot().revision }), /Смена управления/);
    pending.resolve(); await action; await first;
    assert.equal(f.session.snapshot().control.observerId, f.observer); assert.equal(f.session.state, 'user_control');
});
