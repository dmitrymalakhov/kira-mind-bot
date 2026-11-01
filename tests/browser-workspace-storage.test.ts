import test from 'node:test';
import assert from 'node:assert/strict';
import {AppDataSource} from '../data-source';
import {TypeORMSessionStorage,persistBrowserWorkspace} from '../services/SessionStorage';
import {createBrowserWorkspace,attachBrowserWorkspace} from '../services/browserWorkspace';
import type {SessionData} from '../types';
const owner=94212,key=`api:${owner}`;
const empty=():SessionData=>({reminders:[],messageHistory:[],dialogueSummary:'',lastSummarizedIndex:-1,domains:{}});
function fixture(t:any){
    const rows=new Map<string,any>();
    t.mock.method(AppDataSource,'getRepository',(()=>({findOne:async({where}:any)=>rows.has(where.key)?structuredClone(rows.get(where.key)):null,
        upsert:async(row:any)=>rows.set(row.key,JSON.parse(JSON.stringify(row)))})) as any);
    return {rows,storage:new TypeORMSessionStorage(true)};
}
test('real storage extract/write/read restores a workspace across separate instances and respects scope/expiry',async t=>{
    const {storage,rows}=fixture(t);let clock=Date.parse('2026-11-01T09:00:00Z');t.mock.method(Date,'now',()=>clock);
    const first=empty();first.browserWorkspace=createBrowserWorkspace(owner,key,'operation-first','Compare synthetic tools; never submit',clock);
    first.browserWorkspace.status='completed';first.browserWorkspace.turns=['Only blue'];first.browserWorkspace.questions=['Which size?'];
    first.browserWorkspace.records=[{id:'synthetic-item',title:'TEST Tool',url:'https://catalog.example/item',sourceUrl:'https://catalog.example/list',attributes:{price:'20 EUR'},excerpt:'Synthetic tool',observedAt:new Date(clock).toISOString()}];
    await storage.write(key,first);
    const row=[...rows.values()][0];row.data=JSON.stringify(row.data); // PostgreSQL legacy string and object representations.
    const next=(await new TypeORMSessionStorage(true).read(key))!;
    assert.equal(next.browserWorkspace?.originalGoal,first.browserWorkspace.originalGoal);assert.equal(next.browserWorkspace?.records[0].attributes.price,'20 EUR');
    assert.deepEqual(next.browserWorkspace?.questions,['Which size?']);assert.deepEqual(next.browserWorkspace?.turns,['Only blue']);
    assert.equal(await storage.read('api:94213'),undefined);assert.equal(await storage.read(String(owner)),undefined);
    await storage.write(String(owner),next);assert.equal((await storage.read(String(owner)))?.browserWorkspace,undefined);
    clock+=46*60_000;assert.equal((await storage.read(key))?.browserWorkspace,undefined);
    await storage.write(key,next);assert.equal((await storage.read(key))?.browserWorkspace,undefined);
});
test('cancellation and a successor operation cannot be overwritten by a stale held request',async t=>{
    const {storage}=fixture(t),first=empty();first.browserWorkspace=createBrowserWorkspace(owner,key,'operation-first','Synthetic research');
    await storage.write(key,first);
    const stale=(await storage.read(key))!,cancel=(await storage.read(key))!;
    cancel.browserWorkspace=undefined;await storage.write(key,cancel);
    stale.browserWorkspace!.turns.push('Late stale correction');await storage.write(key,stale);
    assert.equal((await storage.read(key))?.browserWorkspace,undefined);
    const fresh=empty();fresh.browserWorkspace=createBrowserWorkspace(owner,key,'operation-a','New synthetic comparison');await storage.write(key,fresh);
    const old=(await storage.read(key))!,following=(await storage.read(key))!;
    following.browserWorkspace=attachBrowserWorkspace(following.browserWorkspace!,'operation-b','The second source');await storage.write(key,following);
    old.browserWorkspace!.turns.push('Late old operation');await storage.write(key,old);
    const final=(await storage.read(key))!.browserWorkspace!;
    assert.equal(final.operationId,'operation-b');assert.deepEqual(final.turns,['The second source']);
    old.browserWorkspace=undefined;await storage.write(key,old);
    assert.equal((await storage.read(key))?.browserWorkspace?.operationId,'operation-b');
});
test('live workspace persistence updates only its field and clears cancellation without losing newer history',async t=>{
    const {storage}=fixture(t),value=empty();const workspace=createBrowserWorkspace(owner,key,'operation-live','Synthetic form; do not submit');
    value.browserWorkspace=workspace;await storage.write(key,value);
    const newer=(await storage.read(key))!;newer.dialogueSummary='Newer ordinary turn';await storage.write(key,newer);
    workspace.turns.push('Use education as purpose');await persistBrowserWorkspace(key,workspace);
    assert.equal((await storage.read(key))?.dialogueSummary,'Newer ordinary turn');assert.deepEqual((await storage.read(key))?.browserWorkspace?.turns,workspace.turns);
    workspace.status='cancelled';await persistBrowserWorkspace(key,workspace);
    assert.equal((await storage.read(key))?.browserWorkspace,undefined);
});
