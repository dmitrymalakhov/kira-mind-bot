import test from 'node:test';
import assert from 'node:assert/strict';
import {createBrowserWorkspace,availableBrowserWorkspace,attachBrowserWorkspace,observeBrowserWorkspace,mergeBrowserRecords,browserWorkspaceContext,browserSourceUrl,type BrowserSourceRecord} from '../services/browserWorkspace';
import {validateBrowserTarget,BrowserTargetError} from '../services/browserActionTarget';
import {completeClassificationContract} from '../orchestration/intentPrompt';
const now=Date.parse('2026-11-01T09:00:00Z');
const row=(id:string,url:string,attributes:Record<string,string>={}):BrowserSourceRecord=>({id,title:'Synthetic source',url,sourceUrl:'https://fixture.example/list',attributes,excerpt:'Synthetic facts',observedAt:new Date(now).toISOString()});
test('workspace round trip preserves scope, goal, evolving constraints, evidence and unresolved questions',()=>{
    const old=createBrowserWorkspace(94201,'api:94201','operation-a','Compare synthetic objects; never submit',now);
    old.status='completed';old.questions=['Which size?'];
    observeBrowserWorkspace(old,{url:'https://fixture.example/list',title:'Synthetic list',tabs:'1 list, 2 detail',records:[row('a','https://fixture.example/a',{price:'20 EUR'})],excerpt:'Observed source'},now);
    const persisted=JSON.parse(JSON.stringify(old));
    assert.ok(availableBrowserWorkspace(persisted,94201,'api:94201',now));
    for(const [owner,scope,time] of [[94202,'api:94202',now],[94201,'94201',now],[94201,'api:94201',now+46*60_000]] as const)assert.equal(availableBrowserWorkspace(persisted,owner,scope,time),undefined);
    const next=attachBrowserWorkspace(persisted,'operation-b','The cheaper one, in blue',now+1000);
    assert.equal(next.originalGoal,old.originalGoal);assert.deepEqual(next.turns,['The cheaper one, in blue']);
    assert.equal(next.records[0].attributes.price,'20 EUR');assert.deepEqual(next.questions,['Which size?']);
    assert.equal(old.operationId,'operation-a');assert.equal(old.status,'completed');assert.equal(next.operationId,'operation-b');
    assert.match(browserWorkspaceContext(next),/never submit/);
    persisted.status='cancelled';assert.equal(availableBrowserWorkspace(persisted,94201,'api:94201',now),undefined);
});
test('general records merge source identities while keeping distinct same-title objects and missing fields',()=>{
    const merged=mergeBrowserRecords([row('a','https://fixture.example/a',{date:'2026-11-06'})],[row('a','https://fixture.example/a',{price:'30 EUR'}),row('b','https://fixture.example/b',{date:'2026-11-07'})]);
    assert.equal(merged.length,2);assert.deepEqual(merged[0].attributes,{date:'2026-11-06',price:'30 EUR'});
    assert.equal('availability' in merged[0].attributes,false);
    let workspace=createBrowserWorkspace(94201,'api:94201','op','Synthetic research',now);
    for(let index=0;index<100;index++)observeBrowserWorkspace(workspace,{url:`https://fixture.example/${index}`,records:[row(String(index),`https://fixture.example/${index}`)],excerpt:'Observed'},now+index);
    assert.equal(workspace.records.length,40);assert.equal(workspace.evidence.length,12);assert.ok(browserWorkspaceContext(workspace).length<=24000);
});
test('source references exclude credentials and preserve meaningful navigation/filter identifiers',()=>{
    assert.equal(browserSourceUrl('https://fixture.example/item?token=private'),undefined);
    const credentialUrl=new URL('https://fixture.example/item');credentialUrl.username='synthetic-user';credentialUrl.password='synthetic-password';
    assert.equal(browserSourceUrl(credentialUrl.toString()),undefined);
    assert.equal(browserSourceUrl('javascript:alert(1)'),undefined);
    assert.equal(browserSourceUrl('/list?page=2&utm_source=test','https://fixture.example/'),'https://fixture.example/list?page=2');
});
test('tool names and missing targets are schema failures; concrete semantic targets remain supported',()=>{
    for(const target of ['', 'hover', 'click','selector','*'])assert.throws(()=>validateBrowserTarget(target),BrowserTargetError);
    for(const target of ['role=button[name="Continue"]','text=hover','#synthetic-next','frame=0 >> label=Size'])validateBrowserTarget(target);
});
test('the existing classification contract repairs a missing relation and rejects a foreign or still-missing workspace ID',async()=>{
    let calls=0;
    const fixed=await completeClassificationContract(async repair=>{calls++;return {intent:'РАЗГОВОР',confidenceLevel:'ВЫСОКИЙ',details:repair?{browserWorkspace:{id:'bound-workspace',relation:'unrelated'}}:{}};},undefined,{id:'bound-workspace'});
    assert.equal(calls,2);assert.equal(fixed.details.browserWorkspace?.relation,'unrelated');
    const rejected=await completeClassificationContract(async()=>({intent:'БРАУЗЕР_ЗАДАЧА',confidenceLevel:'ВЫСОКИЙ',details:{browserWorkspace:{id:'another-owner',relation:'continue'}}}),undefined,{id:'bound-workspace'});
    assert.equal(rejected.intent,'НЕОПРЕДЕЛЕНО');assert.equal(rejected.details.browserWorkspace,undefined);
});
