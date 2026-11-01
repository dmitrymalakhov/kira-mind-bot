import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { LiveBrowserSession, BrowserInterrupted, type BrowserPageInfo } from '../services/liveBrowserSession';
import { runReviewedBrowserAction } from '../services/liveBrowserActionPolicy';
import { createChatCompletionForTask } from '../ai/chatCompletion';
import { openaiProviderAdapter } from '../ai/providers/openai';
import { runWithChannelPreset } from '../services/aiRuntimeConfigService';

function deferred<T = void>() { let resolve!: (value: T) => void; const promise = new Promise<T>(r => { resolve = r; }); return { promise, resolve }; }
function fixture(t: any) {
    const session = new LiveBrowserSession(94103, '94103', randomUUID());
    const page: BrowserPageInfo = { pageId:randomUUID(), navigationEpoch:1, viewportRevision:1, title:'Synthetic', url:'https://fixture.example/',
        origin:'https://fixture.example', viewport:{width:1280,height:720,deviceScaleFactor:1},focus:{editable:false,kind:'none'} };
    session.attach({inspect:async()=>page,capture:async()=>({page,jpeg:Buffer.from('synthetic'),width:1280,height:720}),input:async()=>{},close:async()=>{}});
    t.after(()=>session.dispose());
    const command = (type: string, extra = {}) => session.command(randomUUID(),{type,...session.telegramBody(),...extra});
    return {session,page,command};
}

test('takeover aborts the provider request and cannot schedule a retry/fallback or a late page action', async t => {
    const f=fixture(t), started=deferred(); let calls=0, aborted=false, actions=0;
    t.mock.method(openaiProviderAdapter.client.chat.completions,'create',async (_body: unknown, options?: {signal?:AbortSignal}) => {
        calls++; assert.ok(options?.signal);
        if(calls>1)return {choices:[{message:{content:'Synthetic resumed result'}}]} as any;
        started.resolve();
        return new Promise((_resolve,reject)=>options!.signal!.addEventListener('abort',()=>{aborted=true;reject(new Error('Synthetic request cancelled'));},{once:true}));
    });
    const running=f.session.runAgent(()=>runWithChannelPreset('gpt-balanced',async()=>{
        await createChatCompletionForTask('browserPlanning',{messages:[{role:'user',content:'Synthetic task'}]});
        f.session.agentCall(f.session.generation,()=>{actions++;});
    })).catch(error=>error);
    await started.promise; const ack=await f.command('take_control');
    assert.equal(ack.session.state,'user_control'); assert.equal(aborted,true);
    assert.ok(await running instanceof BrowserInterrupted); assert.equal(calls,1); assert.equal(actions,0);
    await assert.rejects(f.session.runAgent(async()=>{throw Error('Must not enter');}),BrowserInterrupted);
    const baseline=f.session.metrics.agentModelCalls;
    await new Promise(r=>setTimeout(r,30)); assert.equal(f.session.metrics.agentModelCalls,baseline);
    f.session.resume=()=>f.session.runAgent(()=>runWithChannelPreset('gpt-balanced',()=>createChatCompletionForTask('browserPlanning',{messages:[{role:'user',content:'Synthetic explicit return'}]})));
    await f.command('resume',{leaseId:ack.session.control.leaseId});
    await new Promise(r=>setImmediate(r)); assert.equal(calls,2); assert.equal(f.session.state,'running');
});

test('takeover during raw safety inspection prevents even starting the following review model', async t => {
    const f=fixture(t), inspection=deferred<BrowserPageInfo>();let reviews=0,actions=0;
    f.session.adapter!.inspect=()=>inspection.promise;
    const running=f.session.runAgent(()=>runReviewedBrowserAction({method:'hover'}, {},async()=>{actions++;},async()=>{reviews++;return{kind:'routine',summary:'Synthetic review'};})).catch(error=>error);
    await new Promise(r=>setImmediate(r));await f.command('take_control');inspection.resolve(f.page);
    assert.ok(await running instanceof BrowserInterrupted);assert.equal(reviews,0);assert.equal(actions,0);
});
