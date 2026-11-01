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
const { createBrowserWorkspace, attachBrowserWorkspace, observeBrowserWorkspace, readBrowserSourceRecords, browserWorkspaceContext } = require('../services/browserWorkspace');
const { runBrowserTargetAction, BrowserTargetError } = require('../services/browserActionTarget');
const chat = require('../ai/chatCompletion');
chat.createJsonChatCompletionForTask = async () => ({ kind: 'routine', summary: 'Synthetic navigation.' });
const fixtureHtml = `<!doctype html><title>TEST browser fixture</title><style>input{display:block;width:250px;height:32px;margin:15px}iframe{width:300px;height:100px}</style>
<h1>TEST ONLY: no booking is sent</h1><input id="name" aria-label="Name"><input id="secret" type="password" aria-label="Password">
<iframe srcdoc='<input id="custom" aria-label="Private custom input">'></iframe><button id="book">Submit TEST booking</button><output id="result"></output>
<script>nameField=document.querySelector('#name'); nameField.oninput=()=>document.title='TEST name '+nameField.value;
document.querySelector('#book').onclick=()=>document.querySelector('#result').textContent='TEST submitted';</script>`;
async function fixture(t, realClock = false) {
    const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
    const context = await browser.newContext({ viewport: { width: 1280, height: 720 } });
    const page = await context.newPage();
    await page.route('https://fixture.example/**', route => route.fulfill({ contentType: 'text/html', body: fixtureHtml }));
    await page.goto('https://fixture.example/');
    let now = Date.now();
    const session = new LiveBrowserSession(94001, 'api:94001', randomUUID(), realClock ? Date.now : () => now);
    const adapter = new LivePlaywrightAdapter(session, browser, context, page); session.attach(adapter);
    const observerId = randomUUID(), events = []; session.registerObserver(observerId);
    session.subscribe(observerId, e => { events.push(e); return true; }, () => {});
    const command = (type, extra = {}) => session.command(randomUUID(), { type, observerId, expectedRevision: session.snapshot().revision, ...extra });
    const refresh = async () => {
        if (!realClock) { await new Promise(r=>setTimeout(r,100)); now+=1001; await session.capture(); return; }
        const before=session.snapshot().frame?.frameSeq??0,end=Date.now()+2500;
        while(Date.now()<end) { await session.capture(true); if((session.snapshot().frame?.frameSeq??0)>before)return; await new Promise(r=>setTimeout(r,25)); }
        throw Error('No fresh real-clock frame');
    };
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

test('real Chromium: twenty seconds of manual scroll/navigation publish fresh frames without agent work', { timeout:45000 }, async t => {
    const f = await fixture(t, true), original = f.adapter.rawPage;
    await f.context.addCookies([{name:'synthetic-continuity',value:'retained',url:'https://fixture.example/'}]);
    await f.page.evaluate(()=>{const content=document.createElement('div');content.style.height='12000px';content.textContent='Synthetic scroll surface';document.body.append(content);});
    let release;
    const held = new Promise(resolve=>release=resolve);
    const oldRun = f.session.runAgent(async()=>{await held;await f.adapter.guard(f.page).locator('#book').click();}).catch(error=>error);
    await f.command('take_control'); release(); assert.ok(await oldRun instanceof BrowserInterrupted);
    const baseline = {...f.session.metrics}, started = Date.now(); let inputs=0;const inputFrameMs=[];
    while(Date.now()-started<20500) {
        f.session.heartbeat(f.observerId);
        const ack=await f.input(inputs===10?{type:'reload'}:{type:'scroll',deltaX:0,deltaY:120}); inputs++;
        const acknowledged=Date.now();
        const fresh=()=>{const s=f.session.snapshot(),frame=s.frame;return frame&&frame.revision>=ack.session.revision&&frame.eventSeq>ack.session.eventSeq&&frame.revision===s.revision&&frame.navigationEpoch===s.page.navigationEpoch;};
        while(!fresh()&&Date.now()-acknowledged<1000)await new Promise(resolve=>setTimeout(resolve,10));
        assert.ok(fresh(),'input must promptly produce a fresh frame matching the current page, including post-ACK navigation metadata');
        inputFrameMs.push(Date.now()-acknowledged);
        await new Promise(resolve=>setTimeout(resolve,500));
    }
    await f.refresh();
    assert.ok(inputs>=20); assert.equal(f.session.state,'user_control');
    assert.equal(f.session.metrics.agentModelCalls,baseline.agentModelCalls);
    assert.equal(f.session.metrics.agentPageActions,baseline.agentPageActions);
    const p95=inputFrameMs.slice().sort((a,b)=>a-b)[Math.ceil(inputFrameMs.length*.95)-1];
    console.log(JSON.stringify({type:'manual-stream-metrics',synthetic:true,durationMs:Date.now()-started,inputs,inputAckToFrameP95Ms:p95,viewport:f.session.snapshot().page.viewport,metrics:f.session.snapshot().metrics,agentModelDelta:f.session.metrics.agentModelCalls-baseline.agentModelCalls,agentActionDelta:f.session.metrics.agentPageActions-baseline.agentPageActions}));
    assert.ok(f.session.metrics.framesPublished-baseline.framesPublished>=50,'manual cadence must exceed the previous one-frame-per-second limit');
    assert.ok(p95<750,'fresh frame after acknowledged input must stay within the bounded synthetic latency budget');
    assert.ok(f.session.metrics.lastInputToFrameMs>=0);
    assert.equal(f.adapter.rawPage,original);
    assert.equal((await f.context.cookies()).find(cookie=>cookie.name==='synthetic-continuity').value,'retained');
    let resumed;
    const returned = new Promise(resolve=>resumed=resolve);
    f.session.resume=()=>f.session.runAgent(async()=>{await f.adapter.guard(f.page).title();resumed();});
    await f.command('resume',{leaseId:f.session.snapshot().control.leaseId}); await returned;
    assert.equal(f.adapter.rawPage,original);
    await f.command('stop'); const stoppedFrames=f.session.metrics.framesPublished;
    await new Promise(resolve=>setTimeout(resolve,300));
    assert.equal(f.session.metrics.framesPublished,stoppedFrames);
});

const workspaceFixtures = require('./browserWorkspaceFixtures.cjs');
for(const scenario of workspaceFixtures)test(`rendered general workspace transfers across task/layout: ${scenario.id}`,{timeout:15000},async t=>{
    const f=await fixture(t),url=`https://${scenario.host}/list`;
    await f.context.route(`https://${scenario.host}/**`,route=>route.fulfill({contentType:'text/html',body:`<meta charset="utf-8"><div id="loading" aria-busy="true">Loading</div><script>setTimeout(()=>document.body.innerHTML=${JSON.stringify(scenario.html)},100)</script>`}));
    await f.page.goto(url);await f.page.waitForTimeout(180);
    const records=await readBrowserSourceRecords(f.page,new Date('2026-11-01T09:00:00Z'));
    assert.ok(records.some(row=>row.title===scenario.title),JSON.stringify(records));
    assert.ok(records.some(row=>JSON.stringify(row).includes(scenario.attribute)),JSON.stringify(records));
    const workspace=createBrowserWorkspace(94009,'api:94009',randomUUID(),scenario.goal);
    observeBrowserWorkspace(workspace,{url,records,excerpt:await f.page.locator('body').innerText()});workspace.status='completed';
    const followup=attachBrowserWorkspace(JSON.parse(JSON.stringify(workspace)),randomUUID(),scenario.turn);
    assert.equal(followup.originalGoal,scenario.goal);assert.match(browserWorkspaceContext(followup),new RegExp(scenario.title));
    assert.deepEqual(followup.turns,[scenario.turn]);assert.notEqual(followup.operationId,workspace.operationId);assert.equal(workspace.status,'completed');
});
test('real target validation rejects tool-name/stale/ambiguous hover and recovers from a fresh semantic locator',async t=>{
    const f=await fixture(t);let effects=0;
    await assert.rejects(runBrowserTargetAction('hover',()=>[f.page.locator('hover')],async()=>effects++),BrowserTargetError);
    await assert.rejects(runBrowserTargetAction('text=Missing',()=>[f.page.getByText('Missing')],async()=>effects++),error=>error.kind==='stale');
    await f.page.evaluate(()=>{document.body.insertAdjacentHTML('beforeend','<button>TEST choice</button><button>TEST choice</button>');});
    await assert.rejects(runBrowserTargetAction('role=button[name="TEST choice"]',()=>[f.page.getByRole('button',{name:'TEST choice',exact:true})],async()=>effects++),error=>error.kind==='ambiguous');
    assert.equal(effects,0);
    await runBrowserTargetAction('role=button[name="Submit TEST booking"]',()=>[f.page.getByRole('button',{name:'Submit TEST booking',exact:true})],async target=>{await target.hover();effects++;});
    assert.equal(effects,1);assert.equal(await f.page.locator('#result').innerText(),'');
});
test('delayed native dialog after takeover never dismisses itself or revokes human ownership; explicit response and Stop work', {timeout:15000},async t=>{
    const f=await fixture(t);
    await f.page.evaluate(()=>{setTimeout(()=>{document.querySelector('#result').textContent=confirm('TEST delayed website question')?'accepted':'rejected';},250);});
    const takeover=await f.command('take_control'),lease=takeover.session.control.leaseId;
    await new Promise(resolve=>setTimeout(resolve,400));
    const pending=f.session.snapshot().pendingConfirmation;
    assert.equal(f.session.state,'awaiting_confirmation');assert.equal(f.session.snapshot().control.owner,'user');assert.equal(f.session.snapshot().control.leaseId,lease);
    assert.equal(pending.kind,'website_dialog');assert.equal(pending.dialogType,'confirm');
    const metrics={...f.session.metrics};
    const started=Date.now();await assert.rejects(f.command('resume',{leaseId:lease}),error=>error.code==='browser_dialog_pending');assert.ok(Date.now()-started<1000);
    await new Promise(resolve=>setTimeout(resolve,100));assert.equal(f.session.snapshot().pendingConfirmation.confirmationId,pending.confirmationId);
    await f.command('confirm',{leaseId:lease,confirmationId:pending.confirmationId,decision:'reject'});
    assert.equal(await f.page.locator('#result').innerText(),'rejected');assert.equal(f.session.state,'user_control');assert.equal(f.session.snapshot().control.leaseId,lease);
    assert.equal(f.session.metrics.agentModelCalls,metrics.agentModelCalls);assert.equal(f.session.metrics.agentPageActions,metrics.agentPageActions);
    await f.page.evaluate(()=>{setTimeout(()=>alert('TEST pending alert at Stop'),50);});await new Promise(resolve=>setTimeout(resolve,100));
    assert.equal(f.session.snapshot().pendingConfirmation.kind,'website_dialog');
    await f.command('stop');assert.equal(f.session.state,'cancelled');assert.equal(f.session.snapshot().pendingConfirmation,null);
});

for (const persistent of [false, true]) test(`HTTP opt-in (${persistent ? 'persistent' : 'ephemeral'}): existing agent, tenant temp path, takeover, fresh resume and cleanup`, { timeout: 60000 }, async t => {
    const fs = require('node:fs/promises'), path = require('node:path');
    const root = await fs.mkdtemp('/tmp/k-'), parentTemp = path.join(root,'kt_00000000_0000_0000_0000_000000000000','temp');
    await fs.mkdir(parentTemp,{recursive:true}); assert.equal(parentTemp.length,58);
    const originalEnv = {TMPDIR:process.env.TMPDIR,BROWSER_PROFILE_DIR:process.env.BROWSER_PROFILE_DIR,BROWSER_PERSISTENT_PROFILE:process.env.BROWSER_PERSISTENT_PROFILE};
    process.env.TMPDIR=parentTemp; process.env.BROWSER_PROFILE_DIR=path.join(root,'profiles');
    process.env.BROWSER_PERSISTENT_PROFILE = String(persistent);
    const { browserAgent } = require('../agents/browserAgent');
    const { liveBrowserSessions } = require('../services/liveBrowserSession');
    const { BrowserSessionApi } = require('../api/browser');
    const { createExternalApiServer } = require('../api/server');
    const memory = require('../utils/agentMemoryContext');
    memory.fetchAgentMemoryContext = async () => ({ text: '', memories: [], memoryContext: '' });
    memory.buildMemoryContextBlock = () => '';
    const launch = chromium.launch.bind(chromium);
    const launchPersistent = chromium.launchPersistentContext.bind(chromium);
    let childTemp;
    chromium.launch = async options => {
        childTemp=options.env.TMPDIR;
        const browser = await launch(options), newContext = browser.newContext.bind(browser);
        browser.newContext = async options => {
            const context = await newContext(options);
            await context.route('https://fixture.example/**', route => route.fulfill({ contentType:'text/html', body:fixtureHtml }));
            return context;
        }; return browser;
    };
    chromium.launchPersistentContext = async (directory,options) => {
        childTemp=options.env.TMPDIR;
        const context=await launchPersistent(directory,options);
        await context.route('https://fixture.example/**',route=>route.fulfill({contentType:'text/html',body:fixtureHtml}));
        return context;
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
        if (_task === 'intentClassification' || _task === 'fastDialogue') {
            const workspaceId=options.messages.map(item=>String(item.content)).join('\n').match(/"workspaceId"\s*:\s*"([^"]+)"/)?.[1];
            return { intent:'БРАУЗЕР_ЗАДАЧА', confidenceLevel:'ВЫСОКИЙ',
                details:{ memoryNeed:'none', responseComplexity:'routine', browserTaskControl:'continue',...(workspaceId?{browserWorkspace:{id:workspaceId,relation:'continue'}}:{}) }, fastReply:{mode:'route'} };
        }
        const text = JSON.stringify(options.messages);
        return text.includes('#book') ? {kind:'commitment',summary:'Submit TEST for Anna Harness?'} : {kind:'routine',summary:'Synthetic safe navigation'};
    };
    const owner = 94003, scope = `api:${owner}`, token = 'synthetic-browser-token-at-least-thirty-two-characters';
    const { config } = require('../config'), oldOwner=config.allowedUserId; config.allowedUserId=owner; t.after(()=>config.allowedUserId=oldOwner);
    const { Bot } = require('grammy'), { BotApiBackend } = require('../api/backend');
    const { TypeORMSessionStorage } = require('../services/SessionStorage');
    let stored;
    t.mock.method(TypeORMSessionStorage.prototype,'read',async()=>stored && structuredClone(stored));
    t.mock.method(TypeORMSessionStorage.prototype,'write',async(_key,value)=>{stored=structuredClone(value);});
    t.mock.method(require('../services/ChatGroupRepository').ChatGroupRepository,'findAll',async()=>[]);
    t.mock.method(require('../services/DialogueJobRepository').DialogueJobRepository,'beginTurn',async()=>{});
    t.mock.method(require('../services/communicationProfileService'),'communicationProfileContext',async()=>'');
    t.mock.method(require('../services/behaviorMemoryService'),'getBehaviorMemoryContext',async()=>'');
    t.mock.method(require('../services/MemoryReconsolidationService'),'reconsolidateAfterResponse',async()=>{});
    t.mock.method(require('../utils/factAnalysisTimer').factAnalysisManager,'scheduleAnalysis',()=>{});
    t.mock.method(require('../utils/history'),'addToHistory',async(ctx,role,content)=>{ctx.session.messageHistory.unshift({role,content,timestamp:new Date()});});
    const bot=new Bot(process.env.KIRA_BOT_TOKEN,{botInfo:{id:1234567890,is_bot:true,first_name:'Synthetic',username:'synthetic_bot'}});
    bot.api.config.use(async()=>{throw Error('No Telegram traffic');});
    const backend=new BotApiBackend(bot,{ownerId:owner,token,host:'127.0.0.1',port:0},
        {read:async()=>({preset:null,revision:'none'}),write:async()=>{throw Error('No settings writes');}});
    const api=backend.browserSession;
    const server = createExternalApiServer({ownerId:owner,token,host:'127.0.0.1',port:0},backend,{run:async(_key,_fp,work)=>work()});
    await new Promise(r => server.listen(0,'127.0.0.1',r));
    const base = `http://127.0.0.1:${server.address().port}/api/v1`;
    const get = p => fetch(base+p,{headers:{Authorization:`Bearer ${token}`}});
    const post = (p,body,headers={}) => fetch(base+p,{method:'POST',headers:{Authorization:`Bearer ${token}`,'Content-Type':'application/json','Idempotency-Key':randomUUID(),...headers},body:JSON.stringify(body)});
    let session, streamAbort = new AbortController(), lastSseFrame, receivedFrames=0;
    const states=[];
    t.after(async()=> {
        releaseModel(); session?.dispose(); await session?.adapter?.close();
        server.closeAllConnections(); server.close(); chromium.launch=launch; chromium.launchPersistentContext=launchPersistent; streamAbort.abort();
        if(childTemp) await assert.rejects(fs.stat(childTemp),{code:'ENOENT'});
        for(const [key,value] of Object.entries(originalEnv)) {if(value===undefined)delete process.env[key];else process.env[key]=value;}
        await fs.rm(root,{recursive:true,force:true});
    });
    const key = randomUUID();
    const pending = post('/messages',{text:'Открой https://fixture.example/. Ничего не бронируй без подтверждения. Я сам введу имя; спроси перед финальной отправкой.'},
        {'Idempotency-Key':key,'X-Kira-Browser-Session':'v1',...(persistent?{Prefer:'respond-async'}:{})});
    pending.catch(()=>{});
    const until = async (predicate, label) => { const end=Date.now()+25000; while(!predicate()) {if(Date.now()>end) throw Error(`Timed out: ${label}; state=${session?.state}`);await new Promise(r=>setTimeout(r,50));} };
    await until(()=>Boolean(session=api.active(key)),'discovery');
    const observerId=randomUUID(), route=`/browser/sessions/${session.id}`;
    assert.equal((await post(route+'/observers',{observerId})).status,200);
    const stream=await fetch(base+route+`/events?observerId=${observerId}`,{headers:{Authorization:`Bearer ${token}`},signal:streamAbort.signal});
    assert.equal(stream.status,200);
    const reader=stream.body.getReader(); void (async()=>{let text='';const decoder=new TextDecoder();try{
        while(true){const chunk=await reader.read();if(chunk.done)break;text+=decoder.decode(chunk.value,{stream:true});
            let cut;while((cut=text.indexOf('\n\n'))>=0){const block=text.slice(0,cut);text=text.slice(cut+2);
                const data=block.split('\n').find(line=>line.startsWith('data: '));if(!data)continue;
                const event=JSON.parse(data.slice(6));if(event.session?.state)states.push(event.session.state);
                if(event.event==='frame'){receivedFrames++;lastSseFrame=event;}
            }
        }
    }catch{}})();
    const heart=setInterval(()=>void post(route+'/heartbeat',{observerId}),4000); t.after(()=>clearInterval(heart));
    await Promise.race([modelEntered,new Promise((_,reject)=>setTimeout(()=>reject(Error(`Agent did not reach held model; state=${session.state}`)),25000))]);
    const page=session.adapter.rawPage; assert.equal(page.url(),'https://fixture.example/');
    assert.equal(process.env.TMPDIR,parentTemp); assert.notEqual(childTemp,parentTemp);
    assert.equal((await fs.stat(childTemp)).mode&0o777,0o700);
    const command = async(type,extra={})=> {const response=await post(route+'/commands',{type,observerId,expectedRevision:session.snapshot().revision,...extra});const ack=await response.json();assert.equal(response.status,200,JSON.stringify(ack));return ack;};
    await command('take_control'); assert.equal(session.state,'user_control'); releaseModel();
    assert.equal((await pending).status,200);
    const enter = async input => {
        await until(()=>Boolean(session.snapshot().frame),'current frame');const s=session.snapshot(),f=s.frame;
        const response=await post(route+'/input',{observerId,leaseId:s.control.leaseId,expectedRevision:s.revision,frameSeq:f.frameSeq,pageId:f.pageId,navigationEpoch:f.navigationEpoch,viewportRevision:f.viewportRevision,input});
        assert.equal(response.status,200,JSON.stringify(await response.json()));
    };
    const box=await page.locator('#name').boundingBox();await enter({type:'tap',x:box.x+10,y:box.y+10});await enter({type:'text',text:'Anna Harness'});
    await until(()=>lastSseFrame?.session?.page?.title==='TEST name Anna Harness','actual updated JPEG through HTTP SSE');
    const qaFrame=lastSseFrame;
    assert.equal(Buffer.from(qaFrame.jpegBase64,'base64').readUInt16BE(0),0xffd8);
    const correction=await post('/messages',{text:'Не бронируй и ничего не отправляй, оставь эту же страницу для дальнейшего просмотра.'},
        {'X-Kira-Browser-Session':'v1',...(persistent?{Prefer:'respond-async'}:{})});
    assert.equal(correction.status,200,JSON.stringify(await correction.json()));
    assert.equal(session.state,'paused'); assert.equal(api.active(key).id,session.id);
    assert.equal(session.adapter.rawPage,page); assert.equal(await page.locator('#name').inputValue(),'Anna Harness');
    await command('resume',{leaseId:session.snapshot().control.leaseId});
    await until(()=>session.state==='awaiting_confirmation','confirmation after fresh observation');
    assert.equal(session.adapter.rawPage,page); assert.equal(await page.locator('#name').inputValue(),'Anna Harness');assert.equal(freshObservation,true);
    assert.match(session.snapshot().pendingConfirmation.summary,/Anna Harness/);
    await command('confirm',{confirmationId:session.snapshot().pendingConfirmation.confirmationId,decision:'reject'});
    assert.equal(await page.locator('#result').innerText(),'');await command('stop');assert.equal(session.state,'cancelled');
    await until(()=>states.includes('cancelled'),'cancelled state through HTTP SSE');
    if(persistent&&process.env.KIRA_BROWSER_QA_DIR){
        await fs.mkdir(process.env.KIRA_BROWSER_QA_DIR,{recursive:true});
        await fs.writeFile(path.join(process.env.KIRA_BROWSER_QA_DIR,'live-browser-frame.jpg'),Buffer.from(qaFrame.jpegBase64,'base64'));
        await fs.writeFile(path.join(process.env.KIRA_BROWSER_QA_DIR,'browser-session-evidence.json'),JSON.stringify({
            syntheticOnly:true,realChromium:true,authenticatedHttp:true,operationId:key,sessionId:session.id,
            parentTempLength:parentTemp.length,receivedFrames,states:[...new Set(states)],samePage:true,
            manualTextRetained:true,freshObservation,finalSubmissionRejected:true,
            frame:{...qaFrame.frame,pageId:qaFrame.session.page.pageId},
        },null,2)+'\n');
    }
});

test('real browserAgent model failure returns safe text and a discoverable terminal reason', {timeout:20000}, async t=>{
    const fs=require('node:fs/promises'),path=require('node:path');
    const root=await fs.mkdtemp('/tmp/k-'),previous=process.env.BROWSER_PROFILE_DIR;
    process.env.BROWSER_PROFILE_DIR=path.join(root,'profiles');
    const {browserAgent}=require('../agents/browserAgent'),{liveBrowserSessions}=require('../services/liveBrowserSession');
    const failure=()=>{throw Error('Unsupported synthetic model: token=synthetic-private-marker https://synthetic.invalid/private');};
    chat.createChatCompletionForTask=failure;chat.createJsonChatCompletionForTask=failure;
    const operationId=randomUUID(),scope='api:94007';
    const ctx={from:{id:94007},chat:{id:94007,type:'private'},sessionStorageKey:scope,liveBrowserRequest:{operationId},
        session:{isAllowedUser:true,messageHistory:[]},reply:async()=>({message_id:1}),replyWithChatAction:async()=>{},api:{}};
    let session;
    t.after(async()=>{session?.dispose();await session?.adapter?.close();if(previous===undefined)delete process.env.BROWSER_PROFILE_DIR;else process.env.BROWSER_PROFILE_DIR=previous;await fs.rm(root,{recursive:true,force:true});});
    const result=await browserAgent(ctx,'Найди синтетическую публичную страницу',false,'',[],undefined,'Synthetic empty memory.');
    session=liveBrowserSessions.active(94007,scope,operationId);
    assert.equal(session.state,'failed');assert.equal(session.snapshot().reason,'browser_model_unavailable');
    assert.equal(result.responseText,'❌ Не удалось выполнить задачу.\n\nНе удалось получить следующий шаг от модели. Попробуй продолжить задачу позже.');
    assert.doesNotMatch(JSON.stringify({reply:result.responseText,session:session.snapshot()}),/synthetic-private-marker|Unsupported|https:\/\/synthetic.invalid/);
});
