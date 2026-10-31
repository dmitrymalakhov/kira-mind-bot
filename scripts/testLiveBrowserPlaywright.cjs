'use strict';
process.env.KIRA_RUNTIME_DATA_DIR = '/tmp/kira-browser-synthetic';
process.env.KIRA_TENANT_ID = 'synthetic-browser-harness';
// All fixture requests are fulfilled by Playwright. Any accidental network request must fail.
process.env.KIRA_BROWSER_PROXY_URL = 'http://127.0.0.1:9';
// Run with the project's installed Playwright/Chromium, e.g. in an isolated server-image container.
// All fixtures and provider responses are synthetic. This is protocol/agent integration, not an AI-quality eval.
const test = require('node:test');
const assert = require('node:assert/strict');
const { randomUUID } = require('node:crypto');
const { chromium } = require('playwright');
const { LiveBrowserSession, BrowserInterrupted } = require('../services/liveBrowserSession');
const { LivePlaywrightAdapter } = require('../services/liveBrowserPlaywright');
const { runReviewedBrowserAction } = require('../services/liveBrowserActionPolicy');
const chat = require('../ai/chatCompletion');
chat.createJsonChatCompletionForTask = async () => ({ kind: 'routine', summary: 'Synthetic navigation.' });
const fixtureHtml = `<!doctype html><title>TEST browser fixture</title><style>input{display:block;width:250px;height:32px;margin:15px}iframe{width:300px;height:100px}</style>
<h1>TEST ONLY: no booking is sent</h1><input id="name" aria-label="Name"><input id="secret" type="password" aria-label="Password">
<iframe srcdoc='<input id="custom" aria-label="Private custom input">'></iframe><button id="book">Submit TEST booking</button><output id="result"></output>
<script>nameField=document.querySelector('#name'); nameField.oninput=()=>document.title='TEST name '+nameField.value;
document.querySelector('#book').onclick=()=>document.querySelector('#result').textContent='TEST submitted';</script>`;
async function fixture(t) {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.route('https://fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
    await page.goto('https://fixture.example/');
    let now = Date.now();
    const session = new LiveBrowserSession(94001, 'api:94001', randomUUID(), () => now);
    const adapter = new LivePlaywrightAdapter(session, browser, context, page); session.attach(adapter);
    const observerId = randomUUID(), events = []; session.registerObserver(observerId);
    session.subscribe(observerId, e => { events.push(e); return true; }, () => {});
    const command = (type, extra = {}) => session.command(randomUUID(), { type, observerId, expectedRevision: session.snapshot().revision, ...extra });
    const refresh = async () => { await new Promise(r => setTimeout(r, 100)); now += 1001; await session.capture(); };
    const input = async value => { await refresh(); const s = session.snapshot(), f = s.frame; assert.ok(f, 'real current frame');
        return session.humanInput(randomUUID(), { observerId, leaseId: s.control.leaseId, expectedRevision: s.revision,
            frameSeq: f.frameSeq, pageId: f.pageId, navigationEpoch: f.navigationEpoch, viewportRevision: f.viewportRevision, input: value }); };
    t.after(async () => { session.dispose(); await adapter.close(); });
    await refresh(); return { browser, context, page, session, adapter, events, observerId, command, input, refresh };
}
test('real Chromium: same page survives takeover, human text, resume and rejected final commitment', { timeout: 30000 }, async t => {
    const f = await fixture(t); const original = f.adapter.rawPage;
    await f.command('take_control');
    const box = await f.page.locator('#name').boundingBox();
    await f.input({ type: 'tap', x: box.x + 15, y: box.y + 15 });
    await f.input({ type: 'text', text: 'Anna Harness' });
    assert.equal(await f.page.locator('#name').inputValue(), 'Anna Harness');
    let resumeDone;
    const resumed = new Promise(r => resumeDone = r);
    f.session.resume = async () => {
        await f.session.runAgent(async () => {
            const guarded = f.adapter.guard(f.page);
            assert.equal(await guarded.locator('#name').inputValue(), 'Anna Harness');
            await assert.rejects(runReviewedBrowserAction({ action: 'click', selector: '#book' }, {},
                () => guarded.locator('#book').click(), async () => ({ kind: 'commitment', summary: 'Submit TEST for Anna Harness?' })), BrowserInterrupted);
        }); resumeDone();
    };
    await f.command('resume', { leaseId: f.session.snapshot().control.leaseId }); await resumed;
    assert.equal(f.adapter.rawPage, original); assert.equal(f.session.state, 'awaiting_confirmation');
    assert.match(f.session.snapshot().pendingConfirmation.summary, /Anna Harness/);
    await f.command('confirm', { confirmationId: f.session.snapshot().pendingConfirmation.confirmationId, decision: 'reject' });
    assert.equal(f.session.state, 'paused'); assert.equal(await f.page.locator('#result').innerText(), '');
    const frame = f.events.find(e => e.event === 'frame'); assert.ok(frame);
    const bytes = Buffer.from(frame.jpegBase64, 'base64'); assert.equal(bytes.readUInt16BE(0), 0xffd8); assert.ok(bytes.length > 1000);
    await f.command('stop'); assert.equal(f.session.state, 'cancelled');
});
test('real Chromium: private fields and iframe secure input are masked and excluded from observations', { timeout: 30000 }, async t => {
    const f = await fixture(t); await f.command('take_control');
    await f.page.locator('#secret').focus(); await f.input({ type: 'text', text: 'synthetic-passphrase' });
    const child = f.page.frames()[1]; await child.locator('#custom').focus();
    await f.input({ type: 'text', text: 'synthetic-private-code', secure: true });
    assert.equal(await child.locator('#custom').getAttribute('data-kira-private-input'), 'true');
    // Pixel equality with an independently requested black mask proves the stream didn't use an unmasked fallback.
    const captured = await f.adapter.capture();
    const masked = await f.page.screenshot({ type:'jpeg', quality:55, scale:'css', fullPage:false, maskColor:'#242424',
        mask:[f.page.locator('#secret'), child.locator('#custom')] });
    assert.deepEqual(captured.jpeg, masked);
    await f.page.evaluate(() => document.title = 'synthetic-private-code');
    assert.doesNotMatch((await f.adapter.inspect()).title, /synthetic-private-code/);
    f.session.resume = async () => {}; await f.command('resume', { leaseId:f.session.snapshot().control.leaseId });
    await f.session.runAgent(async () => {
        assert.equal(await f.adapter.guard(f.page).locator('#secret').inputValue(), '[private input]');
        assert.equal(await f.adapter.guard(child).locator('#custom').inputValue(), '[private input]');
    });
});
test('real Chromium: navigation during review and late helper operations after pause cannot click', { timeout:30000 }, async t => {
    const f = await fixture(t); let release;
    const review = new Promise(r => release = r);
    const pending = f.session.runAgent(() => runReviewedBrowserAction({ selector:'#book' }, {},
        () => f.adapter.guard(f.page).locator('#book').click(), async () => review));
    await new Promise(r => setTimeout(r, 100)); await f.page.goto('https://fixture.example/next');
    release({kind:'routine',summary:'Synthetic action'}); await assert.rejects(pending, BrowserInterrupted);
    assert.equal(f.session.state, 'paused'); assert.equal(await f.page.locator('#result').innerText(), '');
    assert.throws(() => f.adapter.guard(f.page).locator('#book'), BrowserInterrupted);
});

test('HTTP opt-in drives the existing browserAgent; takeover interrupts its pending model and fresh resume retains human state', { timeout: 60000 }, async t => {
    process.env.BROWSER_PERSISTENT_PROFILE = 'false';
    const { browserAgent } = require('../agents/browserAgent');
    const { liveBrowserSessions } = require('../services/liveBrowserSession');
    const { BrowserSessionApi } = require('../api/browser');
    const { createExternalApiServer } = require('../api/server');
    const memory = require('../utils/agentMemoryContext');
    memory.fetchAgentMemoryContext = async () => ({ text: '', memories: [], memoryContext: '' });
    memory.buildMemoryContextBlock = () => '';
    const launch = chromium.launch.bind(chromium);
    chromium.launch = async options => {
        const browser = await launch(options), newContext = browser.newContext.bind(browser);
        browser.newContext = async options => {
            const context = await newContext(options);
            await context.route('https://fixture.example/**', route => route.fulfill({ contentType:'text/html', body:fixtureHtml }));
            return context;
        }; return browser;
    };
    let releaseModel, enteredModel;
    const heldModel = new Promise(r => releaseModel = r), modelEntered = new Promise(r => enteredModel = r);
    let navigationPlanned = false, modelHeld = false, freshObservation = false;
    const response = value => ({ choices:[{message:{content:JSON.stringify(value)}}] });
    chat.createChatCompletionForTask = async (_task, options) => {
        const text = JSON.stringify(options.messages);
        if (!modelHeld && session?.adapter?.rawPage.url() === 'https://fixture.example/') {
            modelHeld = true; enteredModel(); await heldModel;
        }
        if (text.includes('Anna Harness')) freshObservation = true;
        if (text.includes('Что делать дальше?')) {
            if (!navigationPlanned) { navigationPlanned = true; return response({ action:'navigate',value:'https://fixture.example/' }); }
            return response({ action:'click', selector:'#book', comment:'Submit TEST for Anna Harness' });
        }
        return response({});
    };
    chat.createJsonChatCompletionForTask = async (_task, options) => {
        const text = JSON.stringify(options.messages);
        return text.includes('#book') ? {kind:'commitment',summary:'Submit TEST for Anna Harness?'} : {kind:'routine',summary:'Synthetic safe navigation'};
    };
    const owner = 94003, scope = `api:${owner}`, token = 'synthetic-browser-token';
    const ctx = { from:{id:owner}, chat:{id:owner,type:'private'}, sessionStorageKey:scope,
        session:{isAllowedUser:true,messageHistory:[]}, reply:async()=>({message_id:1}), replyWithChatAction:async()=>{}, api:{} };
    const api = new BrowserSessionApi(owner, scope, work => work());
    const backend = { browserSession:api, turnReady:async()=>{}, message:async(text, options)=> {
        ctx.liveBrowserRequest = options.liveBrowserRequest;
        const result = await browserAgent(ctx,text,false,'',[],undefined,'Synthetic empty memory.');
        return {messages:[{role:'assistant',text:result.responseText}]};
    }};
    const server = createExternalApiServer({ownerId:owner,token,host:'127.0.0.1',port:0},backend,{run:async(_key,_fp,work)=>work()});
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const get = p => fetch(base+p,{headers:{Authorization:`Bearer ${token}`}});
    const post = (p,body,headers={}) => fetch(base+p,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers},body:JSON.stringify(body)});
    let session, streamAbort = new AbortController();
    t.after(async()=> { releaseModel(); session?.dispose(); server.closeAllConnections(); server.close(); chromium.launch=launch; streamAbort.abort(); });
    const key = randomUUID();
    const pending = post('/messages',{text:'Open https://fixture.example/ and submit the TEST form. I will enter my name myself. Ask before the final submission.'},{'Idempotency-Key':key,'X-Kira-Browser-Session':'v1'});
    pending.catch(()=>{});
    const until = async (predicate, label) => { const end=Date.now()+25000; while(!predicate()) {if(Date.now()>end) throw Error(`Timed out: ${label}; state=${session?.state}`);await new Promise(r=>setTimeout(r,50));} };
    await until(()=>Boolean(session=api.active(key)),'discovery');
    const observerId=randomUUID(), route=`/browser/sessions/${session.id}`;
    assert.equal((await post(route+'/observers',{observerId})).status,200);
    const stream=await fetch(base+route+`/events?observerId=${observerId}`,{headers:{Authorization:`Bearer ${token}`},signal:streamAbort.signal});
    assert.equal(stream.status,200);
    const reader=stream.body.getReader(); void (async()=>{try{while(!(await reader.read()).done){}}catch{}})();
    const heart=setInterval(()=>void post(route+'/heartbeat',{observerId}),4000); t.after(()=>clearInterval(heart));
    await Promise.race([modelEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error(`Agent did not reach held model; state=${session.state}`)),25000))]);
    const page=session.adapter.rawPage; assert.equal(page.url(),'https://fixture.example/');
    const command = async(type,extra={})=> {const response=await post(route+'/commands',{type,observerId,expectedRevision:session.snapshot().revision,...extra});const ack=await response.json();assert.equal(response.status,200,JSON.stringify(ack));return ack;};
    await command('take_control'); assert.equal(session.state,'user_control'); releaseModel();
    assert.equal((await pending).status,200);
    const enter = async input => {
        await until(()=>Boolean(session.snapshot().frame),'current frame');const s=session.snapshot(),f=s.frame;
        const response=await post(route+'/input',{observerId,leaseId:s.control.leaseId,expectedRevision:s.revision,frameSeq:f.frameSeq,pageId:f.pageId,navigationEpoch:f.navigationEpoch,viewportRevision:f.viewportRevision,input});
        assert.equal(response.status,200,JSON.stringify(await response.json()));
    };
    const box=await page.locator('#name').boundingBox();await enter({type:'tap',x:box.x+10,y:box.y+10});await enter({type:'text',text:'Anna Harness'});
    await command('resume',{leaseId:session.snapshot().control.leaseId});
    await until(()=>session.state==='awaiting_confirmation','confirmation after fresh observation');
    assert.equal(session.adapter.rawPage,page); assert.equal(await page.locator('#name').inputValue(),'Anna Harness');assert.equal(freshObservation,true);
    assert.match(session.snapshot().pendingConfirmation.summary,/Anna Harness/);
    await command('confirm',{confirmationId:session.snapshot().pendingConfirmation.confirmationId,decision:'reject'});
    assert.equal(await page.locator('#result').innerText(),'');await command('stop');assert.equal(session.state,'cancelled');
});
