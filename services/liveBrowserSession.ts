import { AsyncLocalStorage } from 'node:async_hooks';
import { createHash, randomUUID } from 'node:crypto';
import { ApiError } from '../api/contracts';

export type LiveBrowserState = 'starting' | 'running' | 'pausing' | 'paused' | 'user_control' | 'needs_user' |
    'awaiting_confirmation' | 'completed' | 'cancelled' | 'failed' | 'disconnected';
export type BrowserInput = { type: 'tap'; x: number; y: number } | { type: 'scroll'; deltaX: number; deltaY: number } |
    { type: 'text'; text: string; secure?: boolean } | { type: 'key'; key: string } | { type: 'back' | 'reload' };
export interface BrowserFocus { editable: boolean; kind: 'none' | 'text' | 'password' | 'otp' | 'payment'; }
export interface BrowserPageInfo {
    pageId: string; navigationEpoch: number; viewportRevision: number; url: string; origin: string; title: string;
    viewport: { width: number; height: number; deviceScaleFactor: number }; focus: BrowserFocus;
}
export interface BrowserFrame {
    frameSeq: number; eventSeq: number; pageId: string; navigationEpoch: number; viewportRevision: number;
    revision: number; imageWidth: number; imageHeight: number; capturedAt: string; mime: 'image/jpeg'; focus: BrowserFocus;
}
export interface LiveBrowserAdapter {
    inspect(): Promise<BrowserPageInfo>;
    capture(): Promise<{ page: BrowserPageInfo; jpeg: Buffer; width: number; height: number }>;
    input(input: BrowserInput): Promise<void>;
    close(): Promise<void>;
    readyToResume?(): Promise<void>;
}
export interface BrowserSnapshot {
    version: 1; sessionId: string; operationId: string; revision: number; eventSeq: number; state: LiveBrowserState;
    control: { owner: 'agent' | 'user' | 'none'; observerId: string | null; leaseId: string | null };
    page: BrowserPageInfo | null; frame: BrowserFrame | null;
    pendingConfirmation: { confirmationId: string; summary: string; revision: number } | null;
    assistanceRequest: { requestId: string; revision: number; kind: 'information' | 'login' | 'otp' | 'captcha' | 'clarification' | 'blocked'; prompt: string; responseActions: Array<'answer' | 'take_control' | 'pause' | 'stop'> } | null;
    inFlight: boolean; externalEffect: 'none' | 'possible' | 'confirmed' | 'unknown'; expiresAt: string;
    lastCommand: { commandId: string; type: string; accepted: boolean } | null; reason: string | null;
}
export interface BrowserEvent { seq: number; event: 'snapshot' | 'state' | 'frame'; session?: BrowserSnapshot;
    sessionId?: string; frame?: BrowserFrame; jpegBase64?: string; resync?: boolean; }
export interface BrowserAck { commandId: string; accepted: boolean; session: BrowserSnapshot; interpretation?: string; reply?: string; }
export const LIVE_BROWSER_CAPABILITY = { version: 1, available: true, transport: 'sse-jpeg',
    activePath: '/api/v1/browser/sessions/active', maxObservers: 2, maxFrameRate: 1,
    inputs: ['tap', 'scroll', 'text', 'key', 'back', 'reload'], backgroundPolicy: 'pause', observerTimeoutMs: 15_000,
    accessibility: { structuredPageControls: false }, secureFocus: true } as const;
const TERMINAL = new Set<LiveBrowserState>(['completed', 'cancelled', 'failed']);
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEYS = new Set(['Enter', 'Tab', 'Backspace', 'Delete', 'Escape', 'ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);
const TTL = 15 * 60_000;
const RETENTION = 60_000;
const digest = (data: unknown) => createHash('sha256').update(JSON.stringify(data)).digest('hex');
export class BrowserInterrupted extends Error { constructor() { super('Browser execution lease changed'); } }
const invocation = new AsyncLocalStorage<{ session: LiveBrowserSession; generation: number }>();
export function liveBrowserInvocation() { return invocation.getStore(); }
export function assertLiveBrowserInvocation() { const current = invocation.getStore(); current?.session.assertAgent(current.generation); }
export function isLiveBrowserTerminal(state: LiveBrowserState) { return TERMINAL.has(state); }
function fail(code: string, message: string, status = 409): never { throw new ApiError(status, code, message); }

/** One account-worker owns this in-memory state. No frames, input text or credentials are persisted here. */
export class LiveBrowserSession {
    readonly id = randomUUID();
    state: LiveBrowserState = 'starting';
    generation = 1;
    private revision = 1;
    private sequence = 0;
    private frameSequence = 0;
    private page: BrowserPageInfo | null = null;
    private frame: BrowserFrame | null = null;
    private frameBytes?: Buffer;
    private frameTime = 0;
    private controller: string | null = null;
    private lease: string | null = null;
    private reason: string | null = null;
    private effect: BrowserSnapshot['externalEffect'] = 'none';
    private confirmation: BrowserSnapshot['pendingConfirmation'] = null;
    private assistance: BrowserSnapshot['assistanceRequest'] = null;
    private confirmationBinding?: string;
    private permittedBinding?: string;
    private lastCommand: BrowserSnapshot['lastCommand'] = null;
    private expires = this.now() + TTL;
    private graceUntil = this.now() + 15_000;
    private receipts = new Map<string, { hash: string; promise: Promise<BrowserAck> }>();
    private observers = new Map<string, { heartbeat: number; sink?: (event: BrowserEvent) => boolean; close?: () => void; connection?: symbol }>();
    private calls = new Set<Promise<unknown>>();
    private run?: Promise<unknown>;
    private timer: NodeJS.Timeout;
    private capturing = false;
    private lastCapture = 0;
    private suspending?: Promise<void>;
    private actionBusy = false;
    adapter?: LiveBrowserAdapter;
    resume?: (answer: string) => Promise<unknown>;
    onSuspend?: () => void;
    onStop?: () => void;
    corrections: string[] = [];
    onState?: () => void;
    backgroundDelivery = false;
    task = '';
    readonly telegramObserverId = randomUUID();
    readonly requiresObserver: boolean;

    constructor(readonly owner: number, readonly scope: string, readonly operationId: string,
        private readonly now: () => number = Date.now) {
        this.requiresObserver = scope.startsWith('api:');
        if (!this.requiresObserver) this.observers.set(this.telegramObserverId, { heartbeat: this.now(), sink: () => true });
        this.timer = setInterval(() => { void this.tick(); }, 500);
        this.timer.unref();
    }
    snapshot(): BrowserSnapshot {
        return { version: 1, sessionId: this.id, operationId: this.operationId, revision: this.revision, eventSeq: this.sequence,
            state: this.state, control: { owner: this.state === 'running' || this.state === 'starting' ? 'agent' : this.state === 'user_control' ? 'user' : 'none',
                observerId: this.controller, leaseId: this.lease }, page: this.page ? structuredClone(this.page) : null,
            frame: this.frame && this.frame.revision === this.revision && this.now() - this.frameTime <= 2000 ? { ...this.frame } : null,
            pendingConfirmation: this.confirmation ? { ...this.confirmation } : null, inFlight: this.calls.size > 0,
            assistanceRequest: this.assistance ? structuredClone(this.assistance) : null,
            externalEffect: this.effect, expiresAt: new Date(this.expires).toISOString(), lastCommand: this.lastCommand ? { ...this.lastCommand } : null, reason: this.reason };
    }
    private publish(event: BrowserEvent) {
        for (const [id, observer] of this.observers) if (observer.sink && !observer.sink(event)) this.disconnect(id, observer.connection);
    }
    private changed() { this.revision++; this.sequence++; this.publish({ event: 'state', seq: this.sequence, session: this.snapshot() }); this.onState?.(); }
    private invalidate() { this.generation++; this.confirmation = null; this.confirmationBinding = undefined; this.permittedBinding = undefined; this.assistance = null; }
    private touch() { this.expires = this.now() + TTL; }
    private checkRevision(value: unknown) { if (value !== this.revision) fail('browser_revision_conflict', 'Обнови состояние браузера.'); }
    private observer(id: unknown) {
        if (typeof id !== 'string' || !this.observers.has(id)) fail('browser_observer_required', 'Сначала подключи наблюдателя.');
        return id as string;
    }
    private assertForeground(id: string) {
        if (!this.requiresObserver && id === this.telegramObserverId) return;
        const observer = this.observers.get(id)!;
        if (!observer.sink || this.now() - observer.heartbeat > 15_000) fail('browser_observer_disconnected', 'Открой браузер перед действием.');
    }
    private assertController(id: string, lease?: unknown) {
        if (this.controller && this.controller !== id) fail('browser_control_busy', 'Браузером управляет другое устройство.');
        if (this.lease && lease !== this.lease) fail('browser_lease_conflict', 'Право управления изменилось.');
    }
    registerObserver(id: unknown) {
        if (typeof id !== 'string' || !UUID.test(id)) fail('invalid_body', 'Нужен UUID наблюдателя.', 422);
        if (!this.observers.has(id) && this.observers.size >= 2) fail('browser_observer_limit', 'Подключено два устройства.', 429);
        if (!this.observers.has(id)) this.observers.set(id, { heartbeat: this.now() });
        return { observerId: id, session: this.snapshot() };
    }
    heartbeat(id: unknown) { const observer = this.observers.get(this.observer(id))!; observer.heartbeat = this.now(); return { session: this.snapshot() }; }
    subscribe(id: unknown, sink: (event: BrowserEvent) => boolean, close: () => void, after?: number): () => void {
        const observerId = this.observer(id), observer = this.observers.get(observerId)!;
        if (after !== undefined && (!Number.isSafeInteger(after) || after < 0 || after > this.sequence)) fail('invalid_cursor', 'Некорректный номер события.', 422);
        observer.close?.();
        const connection = Symbol();
        Object.assign(observer, { sink, close, connection, heartbeat: this.now() });
        if (!sink({ seq: this.sequence, event: 'snapshot', session: this.snapshot(), resync: true })) this.disconnect(observerId, connection);
        void this.capture();
        return () => this.disconnect(observerId, connection);
    }
    private disconnect(id: string, connection?: symbol) {
        const observer = this.observers.get(id);
        if (!observer || (connection && observer.connection !== connection)) return;
        const close = observer.close;
        observer.sink = undefined; observer.close = undefined; observer.connection = undefined;
        close?.();
        if (!TERMINAL.has(this.state) && (this.controller === id || ![...this.observers.values()].some(o => o.sink))) {
            void this.suspend('disconnected', 'observer_disconnected').catch(() => {});
        }
    }
    async tick() {
        if (this.now() - this.frameTime > 2000) { this.frameBytes = undefined; this.frame = null; }
        if (TERMINAL.has(this.state)) { if (this.now() >= this.expires) this.dispose(); return; }
        if (this.now() >= this.expires) { this.stop('session_expired'); return; }
        for (const [id, observer] of this.observers) if (this.requiresObserver && this.now() - observer.heartbeat > 15_000) {
            this.disconnect(id, observer.connection); this.observers.delete(id);
        }
        if (this.requiresObserver && this.now() > this.graceUntil && ![...this.observers.values()].some(o => o.sink) && ['starting', 'running'].includes(this.state))
            await this.suspend('disconnected', 'observer_timeout');
        await this.capture();
    }
    attach(adapter: LiveBrowserAdapter) {
        if (TERMINAL.has(this.state)) { void adapter.close(); throw new BrowserInterrupted(); }
        this.adapter = adapter;
        if (this.state === 'starting') this.state = 'running';
        this.changed(); void this.capture();
    }
    pageChanged() {
        if (TERMINAL.has(this.state)) return;
        if (this.assistance || this.confirmation) {
            this.invalidate(); this.state = 'paused'; this.reason = 'page_changed';
        }
        this.confirmation = null; this.confirmationBinding = undefined; this.permittedBinding = undefined;
        this.frame = null; this.frameBytes = undefined; this.changed();
    }
    private updatePage(page: BrowserPageInfo) {
        if (this.page && digest(this.page) !== digest(page)) {
            this.confirmation = null; this.confirmationBinding = undefined; this.permittedBinding = undefined;
            this.frame = null; this.revision++;
        }
        this.page = page;
    }
    async capture() {
        if (!this.requiresObserver || !this.adapter || this.capturing || TERMINAL.has(this.state) || this.now() - this.lastCapture < 1000 ||
            ![...this.observers.values()].some(o => o.sink)) return;
        this.capturing = true; this.lastCapture = this.now();
        const revision = this.revision, generation = this.generation;
        try {
            const data = await this.adapter.capture();
            if (TERMINAL.has(this.state) || revision !== this.revision || generation !== this.generation || data.jpeg.length > 768 * 1024) return;
            this.updatePage(data.page);
            this.frameTime = this.now(); this.frameBytes = data.jpeg;
            this.frame = { frameSeq: ++this.frameSequence, eventSeq: ++this.sequence, revision: this.revision,
                pageId: data.page.pageId, navigationEpoch: data.page.navigationEpoch, viewportRevision: data.page.viewportRevision,
                imageWidth: data.width, imageHeight: data.height, capturedAt: new Date(this.frameTime).toISOString(), mime: 'image/jpeg', focus: data.page.focus };
            this.publish({ event: 'frame', seq: this.sequence, sessionId: this.id, session: this.snapshot(), frame: this.frame, jpegBase64: data.jpeg.toString('base64') });
        } catch { /* A real capture failure is no frame, never placeholder pixels. */ }
        finally { this.capturing = false; }
    }
    assertAgent(generation: number) {
        if (generation !== this.generation || !['starting', 'running'].includes(this.state)) throw new BrowserInterrupted();
    }
    /** Invoked by the Playwright adapter for every protocol operation, including recovery helpers. */
    agentCall<T>(generation: number, work: () => T): T {
        this.assertAgent(generation);
        const value = work();
        if (value && typeof (value as any).then === 'function') {
            let guarded: Promise<unknown>;
            guarded = Promise.resolve(value).then(result => { this.assertAgent(generation); return result; }).finally(() => this.calls.delete(guarded));
            this.calls.add(guarded);
            return guarded as T;
        }
        return value;
    }
    async runAgent<T>(work: () => Promise<T>): Promise<T> {
        if (this.run) fail('browser_run_busy', 'Прежний шаг ещё завершается.');
        const generation = this.generation;
        this.assertAgent(generation);
        const running = invocation.run({ session: this, generation }, work);
        this.run = running;
        try { return await running; } finally { if (this.run === running) this.run = undefined; }
    }
    private async drain() {
        const calls = [...this.calls];
        if (!calls.length) return;
        let timer: NodeJS.Timeout | undefined;
        const timedOut = await Promise.race([Promise.allSettled(calls).then(() => false), new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), 25_000); })]);
        if (timer) clearTimeout(timer);
        if (timedOut) { this.effect = 'unknown'; this.stop('action_drain_timeout'); fail('browser_action_uncertain', 'Действие не завершилось; браузер остановлен.'); }
    }
    async suspend(target: 'paused' | 'user_control' | 'disconnected' | 'needs_user' | 'awaiting_confirmation', reason: string): Promise<void> {
        if (TERMINAL.has(this.state)) return;
        if (this.suspending) {
            await this.suspending;
            if (!TERMINAL.has(this.state)) return this.suspend(target, reason);
            return;
        }
        this.invalidate(); this.state = 'pausing'; this.reason = reason; this.controller = null; this.lease = null; this.changed();
        const generation = this.generation;
        this.suspending = (async () => {
            await this.drain();
            if (generation !== this.generation || TERMINAL.has(this.state)) return;
            this.onSuspend?.(); this.state = target; this.touch(); this.changed();
        })();
        try { await this.suspending; } finally { this.suspending = undefined; }
    }
    stop(reason = 'user_stop') {
        if (TERMINAL.has(this.state)) return;
        if (this.calls.size || this.effect === 'possible') this.effect = 'unknown';
        this.invalidate(); this.state = 'cancelled'; this.reason = reason; this.controller = null; this.lease = null;
        this.expires = this.now() + RETENTION; this.frame = null; this.frameBytes = undefined;
        this.onStop?.(); this.changed(); void this.adapter?.close().catch(() => {});
    }
    finish(state: 'completed' | 'failed', generation: number) {
        if (generation !== this.generation || TERMINAL.has(this.state)) return;
        this.invalidate(); this.state = state; this.controller = null; this.lease = null;
        this.expires = this.now() + RETENTION; this.frame = null; this.frameBytes = undefined; this.changed();
    }
    async needsUser(summary: string, kind: NonNullable<BrowserSnapshot['assistanceRequest']>['kind'] = 'blocked') {
        if (TERMINAL.has(this.state)) return;
        await this.suspend('needs_user', 'assistance_required');
        if (TERMINAL.has(this.state)) return;
        this.assistance = { requestId: randomUUID(), revision: this.revision + 1, kind, prompt: summary.slice(0, 700),
            responseActions: ['answer','take_control','pause','stop'] };
        this.changed();
    }
    async requireConfirmation(binding: unknown, summary: string) {
        const key = digest(binding);
        if (this.permittedBinding === key) { this.permittedBinding = undefined; this.effect = 'possible'; return true; }
        await this.suspend('awaiting_confirmation', 'confirmation_required');
        if (TERMINAL.has(this.state)) return false;
        this.confirmationBinding = key;
        this.confirmation = { confirmationId: randomUUID(), summary: summary.slice(0, 500), revision: this.revision + 1 };
        this.changed(); return false;
    }
    async receipt(key: string, body: unknown, work: () => Promise<BrowserAck>): Promise<BrowserAck> {
        if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) fail('idempotency_key_required', 'Нужен Idempotency-Key.', 400);
        const hash = digest(body), old = this.receipts.get(key);
        if (old) { if (old.hash !== hash) fail('idempotency_conflict', 'Ключ уже использован с другим запросом.'); return old.promise; }
        if (this.receipts.size >= 256) {
            if ((body as any)?.type === 'stop') return work();
            fail('browser_receipt_limit', 'Достигнут лимит действий сессии.', 429);
        }
        const promise = Promise.resolve().then(work);
        this.receipts.set(key, { hash, promise });
        // Failed validation may be retried only with this exact body/key; no action text is retained.
        return promise;
    }
    private ack(key: string, type: string): BrowserAck {
        this.lastCommand = { commandId: key, type, accepted: true }; this.changed();
        const reply = this.state === 'cancelled' ? this.effect === 'unknown' ? 'Задача остановлена. Последнее действие могло успеть отправиться на сайт; его результат нужно проверить.' : 'Браузерная задача остановлена.'
            : this.state === 'user_control' ? 'Управление у тебя. Верни его явно, когда будешь готов.'
            : this.state === 'paused' || this.state === 'disconnected' ? 'Поставила задачу на паузу. Страница сохранена.'
            : this.state === 'running' ? 'Продолжаю с текущей страницы.' : undefined;
        return { commandId: key, accepted: true, session: this.snapshot(), ...(reply ? { reply } : {}) };
    }
    async command(key: string, body: Record<string, unknown>): Promise<BrowserAck> {
        return this.receipt(key, body, async () => {
            const type = body.type;
            if (!['pause','take_control','resume','stop','background','confirm'].includes(String(type))) fail('invalid_body', 'Неизвестная команда.', 422);
            if (type === 'stop') { this.stop(); return this.ack(key, 'stop'); }
            const observerId = this.observer(body.observerId);
            this.checkRevision(body.expectedRevision);
            if (TERMINAL.has(this.state)) fail('browser_session_gone', 'Сессия завершена.', 404);
            if (type === 'background') {
                const own = this.controller === observerId;
                this.disconnect(observerId, this.observers.get(observerId)?.connection);
                if (own || ![...this.observers.values()].some(o => o.sink)) await this.suspend('disconnected', 'app_background');
                return this.ack(key, String(type));
            }
            if (this.suspending || this.state === 'pausing') fail('browser_transition_busy', 'Смена управления ещё не завершилась.');
            this.assertForeground(observerId);
            this.assertController(observerId, body.leaseId);
            if (type === 'pause' || type === 'take_control') {
                const transitionGeneration = this.generation + 1;
                await this.suspend(type === 'pause' ? 'paused' : 'user_control', String(type));
                if (type === 'take_control' && !TERMINAL.has(this.state)) {
                    if (this.generation !== transitionGeneration || this.state !== 'user_control') fail('browser_control_stale', 'Состояние изменилось; управление не передано.');
                    this.controller = observerId; this.lease = randomUUID();
                }
                return this.ack(key, String(type));
            }
            let answer = this.corrections.slice(-8).join('\n');
            let permitted: string | undefined;
            if (type === 'confirm') {
                if (!['accept','reject'].includes(String(body.decision))) fail('invalid_body', 'Нужно явное accept или reject.', 422);
                if (!this.confirmation || body.confirmationId !== this.confirmation.confirmationId || this.state !== 'awaiting_confirmation')
                    fail('browser_confirmation_expired', 'Подтверждение устарело.', 410);
                if (body.decision === 'reject') {
                    this.corrections.push('Пользователь отклонил предложенное внешнее действие. Не повторяй его без новой просьбы.');
                    await this.suspend('paused', 'confirmation_declined'); return this.ack(key, 'confirm');
                }
                permitted = this.confirmationBinding;
                answer += '\nПользователь подтвердил только предложенное действие; заново проверь текущую страницу.';
            } else if (this.state === 'awaiting_confirmation') fail('browser_confirmation_required', 'Нужно отдельное подтверждение действия.');
            if (this.run) {
                const generation = this.generation;
                await this.run.catch(() => {});
                if (generation !== this.generation || TERMINAL.has(this.state)) fail('browser_control_stale', 'Состояние изменилось; продолжение отменено.');
            }
            if (!this.resume || !this.adapter || !['paused','disconnected','user_control','needs_user','awaiting_confirmation'].includes(this.state))
                fail('browser_not_resumable', 'Сейчас нельзя продолжить сессию.');
            const resumeGeneration = this.generation, resumeState = this.state, resumeController = this.controller;
            await this.adapter.readyToResume?.();
            if (resumeGeneration !== this.generation || resumeState !== this.state || resumeController !== this.controller || TERMINAL.has(this.state))
                fail('browser_control_stale', 'Состояние изменилось; продолжение отменено.');
            this.invalidate(); this.permittedBinding = permitted; this.controller = observerId; this.lease = null;
            this.state = 'running'; this.reason = null; this.touch();
            const generation = this.generation;
            void this.resume(answer || 'Продолжи с текущей страницы после явного возврата управления.').catch(() => this.finish('failed', generation));
            return this.ack(key, String(type));
        });
    }
    async humanInput(key: string, body: Record<string, unknown>): Promise<BrowserAck> {
        return this.receipt(key, body, async () => {
            const observerId = this.observer(body.observerId);
            this.assertForeground(observerId); this.assertController(observerId, body.leaseId); this.checkRevision(body.expectedRevision);
            if (this.state !== 'user_control' || this.controller !== observerId || !this.lease || !this.adapter) fail('browser_control_required', 'Сначала возьми управление.');
            if (this.actionBusy) fail('browser_input_busy', 'Предыдущее действие ещё выполняется.');
            this.actionBusy = true;
            try {
                const generation = this.generation;
                const page = await this.adapter.inspect(); this.updatePage(page); this.checkRevision(body.expectedRevision);
                const frame = this.frame;
                if (!frame || this.now() - this.frameTime > 2000 || body.frameSeq !== frame.frameSeq || body.pageId !== page.pageId ||
                    body.navigationEpoch !== page.navigationEpoch || body.viewportRevision !== page.viewportRevision || frame.revision !== this.revision)
                    fail('browser_stale_frame', 'Кадр устарел. Дождись нового кадра.');
                const input = parseBrowserInput(body.input, page);
                if (generation !== this.generation || this.state !== 'user_control') throw new BrowserInterrupted();
                this.confirmation = null; this.confirmationBinding = undefined; this.permittedBinding = undefined;
                this.effect = 'unknown'; this.frame = null; this.frameBytes = undefined; this.revision++;
                const action = this.adapter.input(input); this.calls.add(action);
                try { await action; } finally { this.calls.delete(action); }
                if (generation !== this.generation || this.state !== 'user_control') fail('browser_action_uncertain', 'Управление изменилось во время действия.');
                this.touch(); this.lastCapture = 0; void this.capture(); return this.ack(key, 'input');
            } finally { this.actionBusy = false; }
        });
    }
    async correct(text: string) {
        await this.suspend('paused', 'requirements_changed');
        this.corrections.push(text.slice(0, 2000)); this.corrections = this.corrections.slice(-8); this.changed();
    }
    validateUtterance(body: Record<string, unknown>) {
        const observer = this.observer(body.observerId); this.assertForeground(observer);
        if (this.controller && this.controller !== observer) fail('browser_control_busy', 'Задачей управляет другое устройство.');
        if (TERMINAL.has(this.state)) fail('browser_session_gone', 'Сессия завершена.', 404);
        return { generation: this.generation, revision: this.revision, assistance: this.assistance ? { ...this.assistance } : null };
    }
    telegramBody(extra: Record<string, unknown> = {}) {
        if (this.requiresObserver) fail('browser_other_channel', 'Управляй этой задачей в приложении.');
        return { observerId: this.telegramObserverId, expectedRevision: this.revision, ...extra };
    }
    async answerAssistance(key: string, body: Record<string, unknown>, text: string): Promise<BrowserAck> {
        if (!this.assistance || body.assistanceRequestId !== this.assistance.requestId || this.state !== 'needs_user')
            fail('browser_assistance_expired', 'Ответ относится к прежнему вопросу.', 410);
        if (['login','otp','captcha'].includes(this.assistance.kind))
            fail('browser_manual_step_required', 'Выполни этот шаг непосредственно на сайте.');
        this.corrections.push(`Ответ на вопрос «${this.assistance.prompt}»: ${text.slice(0, 2000)}`);
        this.corrections = this.corrections.slice(-8);
        return this.command(`${key}_resume`, { type: 'resume', observerId: body.observerId, expectedRevision: this.revision, leaseId: body.leaseId });
    }
    dispose() {
        if (!TERMINAL.has(this.state)) this.stop('session_disposed');
        else void this.adapter?.close().catch(() => {});
        clearInterval(this.timer); this.frame = null; this.frameBytes = undefined;
        for (const observer of this.observers.values()) observer.close?.();
        this.observers.clear(); this.receipts.clear(); this.corrections = [];
    }
    expired() { return TERMINAL.has(this.state) && this.now() >= this.expires; }
}

function parseBrowserInput(value: unknown, page: BrowserPageInfo): BrowserInput {
    if (!value || typeof value !== 'object' || Array.isArray(value)) fail('invalid_input', 'Некорректный ввод.', 422);
    const v = value as Record<string, unknown>;
    const finite = (n: unknown) => typeof n === 'number' && Number.isFinite(n);
    if (v.type === 'tap' && finite(v.x) && finite(v.y) && Number(v.x) >= 0 && Number(v.y) >= 0 && Number(v.x) < page.viewport.width && Number(v.y) < page.viewport.height)
        return { type: 'tap', x: Number(v.x), y: Number(v.y) };
    if (v.type === 'scroll' && finite(v.deltaX) && finite(v.deltaY) && Math.abs(Number(v.deltaX)) <= 2000 && Math.abs(Number(v.deltaY)) <= 2000)
        return { type: 'scroll', deltaX: Number(v.deltaX), deltaY: Number(v.deltaY) };
    if (v.type === 'text' && typeof v.text === 'string' && v.text.length > 0 && v.text.length <= 2000 && page.focus.editable)
        return { type: 'text', text: v.text, ...(v.secure === true ? { secure: true } : {}) };
    if (v.type === 'key' && typeof v.key === 'string' && KEYS.has(v.key)) return { type: 'key', key: v.key };
    if (v.type === 'back' || v.type === 'reload') return { type: v.type };
    fail('invalid_input', 'Неподдерживаемый ввод или координаты вне страницы.', 422);
}

export class LiveBrowserRegistry {
    private sessions = new Map<string, LiveBrowserSession>();
    create(owner: number, scope: string, operationId: string) {
        this.prune();
        if ([...this.sessions.values()].some(s => s.owner === owner && !TERMINAL.has(s.state))) fail('browser_session_busy', 'Браузерная задача уже открыта в одном из каналов.');
        const session = new LiveBrowserSession(owner, scope, operationId); this.sessions.set(session.id, session); return session;
    }
    get(owner: number, scope: string, id: string) {
        this.prune(); const session = this.sessions.get(id);
        if (!session || session.owner !== owner || session.scope !== scope) fail('browser_session_gone', 'Сессия недоступна.', 404);
        return session;
    }
    active(owner: number, scope: string, operationId?: string) {
        this.prune(); return [...this.sessions.values()].reverse().find(s => s.owner === owner && s.scope === scope &&
            (operationId ? s.operationId === operationId : !TERMINAL.has(s.state))) ?? null;
    }
    private prune() { for (const [id, session] of this.sessions) if (session.expired()) { session.dispose(); this.sessions.delete(id); } }
}
export const liveBrowserSessions = new LiveBrowserRegistry();
