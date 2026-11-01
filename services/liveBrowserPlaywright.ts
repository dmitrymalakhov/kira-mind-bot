import type { Browser, BrowserContext, Page, Dialog } from 'playwright';
import { randomUUID } from 'node:crypto';
import { BrowserInterrupted, LiveBrowserSession, liveBrowserInvocation, type BrowserFocus, type BrowserInput, type BrowserPageInfo, type LiveBrowserAdapter } from './liveBrowserSession';
import { hasApprovedBrowserAction, runReviewedBrowserAction } from './liveBrowserActionPolicy';
import { ApiError } from '../api/contracts';
import { reviewedEvaluation } from './browserActionValidation';
import { BrowserActionValidationError } from './browserActionValidation';
import { browserFieldDescriptor } from './browserFormControl';

/** The very same Playwright context used by browserAgent; no second browser or protocol port. */
export class LivePlaywrightAdapter implements LiveBrowserAdapter {
    private current: Page;
    private pageId = randomUUID();
    private navigationEpoch = 0;
    private viewportRevision = 1;
    private viewportKey = '';
    private observed = new WeakSet<Page>();
    private closed = false;
    private closing?: Promise<void>;
    private wrappers = new WeakMap<object, object>();
    private originals = new WeakMap<object, object>();
    private privateValues: string[] = [];
    private websiteDialogs: Array<{id:string;dialog:Dialog}> = [];
    private lastPage?: BrowserPageInfo;
    private redact(value: string) { for (const secret of this.privateValues) if (secret) value = value.split(secret).join('[private input]'); return value; }
    private privateMasks() {
        return this.current.frames().map(frame => frame.locator('input[type="password"],input[autocomplete="one-time-code"],input[autocomplete^="cc-"],[data-kira-private-input]'));
    }
    constructor(private readonly session: LiveBrowserSession, private readonly browser: Browser,
        private readonly context: BrowserContext, page: Page) {
        this.current = page; this.observe(page);
        context.on('page', p => { this.adopt(p); });
        context.on('close', () => { if (!this.closed) session.stop('browser_disconnected'); });
    }
    private observe(page: Page) {
        if (this.observed.has(page)) return;
        this.observed.add(page);
        page.on('framenavigated', () => { if (page === this.current) { this.navigationEpoch++; this.session.pageChanged(); } });
        page.on('close', () => {
            if (page !== this.current || this.closed) return;
            const next = this.context.pages().find(p => !p.isClosed());
            if (next) this.adopt(next); else this.session.stop('page_closed');
        });
        page.on('dialog', dialog => {
            if (this.closed) return;
            this.websiteDialogs.push({id:randomUUID(),dialog});
            if (this.websiteDialogs.length===1) this.publishWebsiteDialog();
        });
    }
    private publishWebsiteDialog() {
        const pending=this.websiteDialogs[0];if(!pending)return;
        const message=this.redact(pending.dialog.message()).replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi,'[private]').slice(0,350);
        this.session.websiteDialog(pending.id,pending.dialog.type(),`Системное окно сайта: ${message || pending.dialog.type()}`);
    }
    async resolveWebsiteDialog(id:string,decision:'accept'|'reject') {
        const pending=this.websiteDialogs[0];
        if(!pending||pending.id!==id)throw new ApiError(410,'browser_confirmation_expired','Системное окно уже изменилось.');
        if(decision==='accept')await pending.dialog.accept();else await pending.dialog.dismiss();
        this.websiteDialogs.shift();this.publishWebsiteDialog();
    }
    adopt(value: Page) {
        const page = (this.originals.get(value) ?? value) as Page;
        if (page !== this.current) { this.current = page; this.pageId = randomUUID(); this.navigationEpoch++; this.session.pageChanged(); }
        this.observe(page);
    }
    get rawPage() { return this.current; }
    private async focus(): Promise<BrowserFocus> {
        for (const frame of this.current.frames()) {
            const focus = await frame.evaluate(() => {
                const e = document.activeElement as HTMLInputElement | HTMLTextAreaElement | HTMLElement | null;
                if (!e || !document.hasFocus()) return null;
                const editable = e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || e.isContentEditable;
                const type = e.getAttribute('type')?.toLowerCase();
                const autocomplete = e.getAttribute('autocomplete')?.toLowerCase() ?? '';
                const kind = type === 'password' ? 'password' : autocomplete === 'one-time-code' ? 'otp' : autocomplete.startsWith('cc-') ? 'payment' : editable ? 'text' : 'none';
                return { editable, kind };
            }).catch(() => null);
            if (focus?.editable) return focus as BrowserFocus;
        }
        return { editable: false, kind: 'none' };
    }
    async inspect(): Promise<BrowserPageInfo> {
        const page = this.current, pageId = this.pageId, epoch = this.navigationEpoch;
        if (this.websiteDialogs.length) {
            if (this.lastPage) return {...this.lastPage,focus:{editable:false,kind:'none'}};
            const viewport=page.viewportSize()??{width:1365,height:900};
            return {pageId,navigationEpoch:epoch,viewportRevision:this.viewportRevision,origin:'',url:'',title:'',viewport:{...viewport,deviceScaleFactor:1},focus:{editable:false,kind:'none'}};
        }
        const metrics = await page.evaluate(() => ({ width: window.innerWidth, height: window.innerHeight, deviceScaleFactor: window.devicePixelRatio }));
        const key = JSON.stringify(metrics);
        if (this.viewportKey && this.viewportKey !== key) { this.viewportRevision++; this.session.pageChanged(); }
        this.viewportKey = key;
        let origin = '';
        try { const url = new URL(page.url()); if (url.protocol === 'http:' || url.protocol === 'https:') origin = url.origin; } catch { /* blank */ }
        const title = this.redact(await page.title()).replace(/[\w.+-]+@[\w.-]+\.[a-z]+/gi, '[private]').replace(/\b[\w-]{24,}\b/g, '[private]').slice(0, 120);
        const focus = await this.focus();
        if (page !== this.current || epoch !== this.navigationEpoch) throw new BrowserInterrupted();
        this.lastPage={ pageId, navigationEpoch: epoch, viewportRevision: this.viewportRevision, origin, url: origin ? `${origin}/` : '', title, viewport: metrics, focus };
        return this.lastPage;
    }
    async capture() {
        if (this.websiteDialogs.length) throw new BrowserInterrupted(); // Native dialogs are reported as metadata, never fabricated pixels.
        const page = await this.inspect(), target = this.current;
        const started = performance.now();
        const jpeg = await target.screenshot({ type: 'jpeg', quality: 55, fullPage: false, scale: 'css', timeout: 5000,
            mask: this.privateMasks(), maskColor: '#242424' });
        const screenshotMs = performance.now() - started;
        const after = await this.inspect();
        if (JSON.stringify(page) !== JSON.stringify(after) || target !== this.current) throw new BrowserInterrupted();
        return { page, jpeg, width: page.viewport.width, height: page.viewport.height, screenshotMs };
    }
    async input(input: BrowserInput) {
        switch (input.type) {
            case 'tap': await this.current.mouse.click(input.x, input.y); break;
            case 'scroll': await this.current.mouse.wheel(input.deltaX, input.deltaY); break;
            case 'text': {
                const focus = await this.focus();
                if (input.secure || ['password','otp','payment'].includes(focus.kind)) {
                    this.privateValues.push(input.text); this.privateValues = this.privateValues.slice(-32);
                    for (const frame of this.current.frames()) await frame.evaluate(() => {
                        const e = document.activeElement;
                        if (document.hasFocus() && e && (e instanceof HTMLInputElement || e instanceof HTMLTextAreaElement || (e as HTMLElement).isContentEditable))
                            e.setAttribute('data-kira-private-input', 'true');
                    });
                }
                await this.current.keyboard.insertText(input.text); break;
            }
            case 'key': await this.current.keyboard.press(input.key); break;
            case 'back': await this.current.goBack({ waitUntil: 'domcontentloaded', timeout: 15_000 }); break;
            case 'reload': await this.current.reload({ waitUntil: 'domcontentloaded', timeout: 15_000 }); break;
        }
    }
    close(): Promise<void> {
        if (!this.closing) {
            const attempt = Promise.resolve().then(async () => {
                this.closed = true;
                let failure: unknown;
                try { await this.context.close(); } catch (error) { failure = error; }
                try { await this.browser.close(); } catch (error) { failure ??= error; }
                this.privateValues = [];
                this.websiteDialogs = [];
                if (failure) throw failure;
            });
            this.closing = attempt;
            void attempt.catch(() => { if (this.closing === attempt) this.closing = undefined; });
        }
        return this.closing;
    }
    async readyToResume() {
        if (this.websiteDialogs.length) throw new ApiError(409,'browser_dialog_pending','Сначала явно закрой системное окно сайта.');
        const body = (await Promise.all(this.current.frames().map(frame => frame.locator('body').innerText()))).join('\n');
        if (this.privateValues.some(value => value.length > 2 && body.includes(value)))
            throw new ApiError(409, 'browser_private_content_visible', 'На странице ещё видны введённые секретные данные. Заверши ручной шаг и перейди дальше перед возвратом управления.');
    }

    /** Protocol calls from ALL existing helpers (including evaluate, nested locators, recovery and frames) share the lease.
     * Sync locator builders retain their original API. The raw objects are private to capture and human input. */
    guard<T extends object>(target: T): T {
        if (this.originals.has(target)) return target;
        const cached = this.wrappers.get(target); if (cached) return cached as T;
        const wrap = (value: any): any => {
            if (typeof value === 'string') return this.redact(value);
            if (Array.isArray(value)) return value.map(wrap);
            if (!value || typeof value !== 'object' || Buffer.isBuffer(value)) return value;
            if (typeof value.then === 'function') return value.then(wrap);
            if (['Page','Frame','Locator','FrameLocator','BrowserContext','Browser','Mouse','Keyboard','Touchscreen','ElementHandle','JSHandle'].includes(value.constructor?.name)) return this.guard(value);
            if (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
                return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, wrap(v)]));
            return value;
        };
        const unwrap = (value: any): any => this.originals.get(value) ?? value;
        const proxy = new Proxy(target, { get: (object, property) => {
            const value = Reflect.get(object, property, object);
            if (typeof value !== 'function') return wrap(value);
            // Public event/config/identity methods don't issue browser actions and must work during teardown.
            if (['on','once','off','removeListener','removeAllListeners','setDefaultTimeout','setDefaultNavigationTimeout','isClosed','isConnected','url','viewportSize'].includes(String(property)))
                return (...args: unknown[]) => wrap(value.apply(object, args.map(unwrap)));
            return (...args: unknown[]) => {
                const current = liveBrowserInvocation();
                if (!current || current.session !== this.session) throw new BrowserInterrupted();
                const name = String(property);
                if (name === 'screenshot') args[0] = { ...(args[0] as object ?? {}),
                    mask: this.privateMasks(), maskColor: '#242424' };
                const act = () => this.session.agentCall(current.generation, () => {
                    const assertTextField=this.session.assertTextField;
                    if (assertTextField && ['fill','type','pressSequentially','insertText'].includes(name)) {
                        return (async () => {
                        const targetKind=object.constructor?.name;
                        const locator=targetKind==='Locator'?object as any:targetKind==='Keyboard'?this.current.locator('input:focus,textarea:focus,[contenteditable="true"]:focus'):undefined;
                        const handle=targetKind==='ElementHandle'?object as any:await locator?.elementHandle({timeout:1000});
                        if (!handle) throw new BrowserActionValidationError('unverifiable_action');
                        try {
                            const field=await browserFieldDescriptor(handle);
                            this.session.assertAgent(current.generation);
                            assertTextField(field,String(args[0]??''));
                            this.session.assertAgent(current.generation);
                            // The same checked node receives the native input events; no selector is resolved again after review.
                            const method=name==='pressSequentially'||name==='insertText'?'type':name;
                            return await handle[method](...args.map(unwrap));
                        } finally { if(targetKind!=='ElementHandle')await handle.dispose().catch(()=>{}); }
                        })();
                    }
                    return value.apply(object,args.map(unwrap));
                });
                const mutating = ['click','dblclick','tap','fill','type','press','pressSequentially','insertText','selectOption','check','uncheck','setChecked',
                    'dispatchEvent','dragTo','goto','reload','goBack','goForward','wheel','down','up','move','hover','setInputFiles','setViewportSize'].includes(name);
                // These are code-owned Playwright evaluation functions, never natural-language control routing.
                // DOM writes outside doAction receive the same review as direct clicks (legacy helper recovery).
                const evaluationFunction=args[name==='$eval'||name==='$$eval'?1:0];
                const evaluationWrite = ['evaluate','evaluateHandle','$eval','$$eval'].includes(name) &&
                    /\.(?:click|focus|submit|requestSubmit|dispatchEvent|scrollTo|scrollBy|scrollIntoView|setRangeText|write)\s*\(|\.value\s*=(?!=)|location\s*=(?!=)|location\.(?:replace|assign)\s*\(/.test(String(evaluationFunction));
                if ((mutating || evaluationWrite) && !hasApprovedBrowserAction()) {
                    const target = object.constructor?.name === 'Locator' ? String(object) : name;
                    const evaluation = evaluationWrite ? reviewedEvaluation(name,args) : undefined;
                    const proposal = { method: name, target, pageId: this.pageId, navigationEpoch: this.navigationEpoch,
                        // No typed values, cookies or passwords are sent to the review call.
                        argumentKinds: args.map(a => typeof a), evaluation: evaluation?.source, evaluationProof:evaluation&&{sha256:evaluation.sha256,length:evaluation.length,complete:true} };
                    return wrap(runReviewedBrowserAction(proposal, { task: this.session.task, page: this.session.snapshot().page }, async () => act()));
                }
                return wrap(act());
            };
        } });
        this.wrappers.set(target, proxy); this.originals.set(proxy, target); return proxy;
    }
}
