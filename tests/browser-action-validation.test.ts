import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {reviewedEvaluation,BrowserActionValidationError} from '../services/browserActionValidation';
import {LiveBrowserSession,type BrowserPageInfo} from '../services/liveBrowserSession';
import {runReviewedBrowserAction} from '../services/liveBrowserActionPolicy';
import {protectedBrowserField,browserSecretField} from '../services/browserFormControl';
import {bindBrowserOwnerText} from '../utils/browserOwnerText';
test('review contains the entire executable function, including effects after the old prefix limit',()=>{
    const source=new Function(`const padding=${JSON.stringify('x'.repeat(3400))}; document.querySelector('#synthetic-submit').click();`);
    const proof=reviewedEvaluation('evaluate',[source]);
    assert.ok(proof.source.length>3400);assert.match(proof.source.slice(3000),/synthetic-submit/);
    assert.equal(proof.source,Function.prototype.toString.call(source));assert.equal(proof.sha256,createHash('sha256').update(proof.source).digest('hex'));assert.equal(proof.complete,true);
    const selected=reviewedEvaluation('$eval',['#synthetic-submit',(element:HTMLElement)=>element.click()]);assert.match(selected.source,/element/);
});
test('oversized, malformed and omitted runtime arguments reject internally before execution or owner assistance',()=>{
    for(const [method,args] of [['evaluate',['(() => { document.querySelector("button").click();']],['evaluate',[new Function(`const padding=${JSON.stringify('x'.repeat(13000))}; document.querySelector('button').click();`)]],['evaluate',[(target:string)=>(globalThis as any).document.querySelector(target).click(),'#synthetic-submit']]] as const)
        assert.throws(()=>reviewedEvaluation(method,[...args]),BrowserActionValidationError);
});
test('uncertain action review is an internal rejection; commitment and authentication still suspend',async t=>{
    const session=new LiveBrowserSession(94221,'94221','synthetic-action');t.after(()=>session.dispose());
    const page:BrowserPageInfo={pageId:'synthetic',navigationEpoch:1,viewportRevision:1,url:'https://fixture.example/',origin:'https://fixture.example',title:'TEST',viewport:{width:1000,height:700,deviceScaleFactor:1},focus:{editable:false,kind:'none'}};
    session.attach({inspect:async()=>page,capture:async()=>({page,jpeg:Buffer.alloc(0),width:1000,height:700}),input:async()=>{},close:async()=>{}});
    let effects=0;
    await assert.rejects(session.runAgent(()=>runReviewedBrowserAction({method:'evaluate'}, {},async()=>{effects++;},async()=>({kind:'uncertain',summary:'Cannot establish the full internal action'}))),BrowserActionValidationError);
    assert.equal(effects,0);assert.equal(session.state,'running');assert.equal(session.snapshot().assistanceRequest,null);
    await session.runAgent(()=>runReviewedBrowserAction({action:'click',selector:'#synthetic-submit'}, {},async()=>{effects++;},async()=>({kind:'commitment',summary:'Send synthetic form?'}))).catch(()=>{});
    assert.equal(session.state,'awaiting_confirmation');assert.ok(session.snapshot().pendingConfirmation);assert.equal(effects,0);
});
test('field semantics use observed attribute values: public origin/destination differ from contact identity',()=>{
    for(const field of [{label:'Откуда',name:'origin',type:'text',autocomplete:''},{label:'Destination',name:'destination',type:'text',autocomplete:''}])assert.equal(protectedBrowserField(field),false);
    for(const field of [{label:'Full name',name:'passenger_name',type:'text',autocomplete:'name'},{label:'Email',name:'email',type:'email',autocomplete:'email'},{label:'Телефон',name:'phone',type:'tel',autocomplete:'tel'}])assert.equal(protectedBrowserField(field),true);
});
test('intake binds only the original owner turn and clears prior authority for forwards or internal continuations',()=>{
    const ctx:{browserOwnerText?:string;browserOwnerTextBound?:boolean}={};
    bindBrowserOwnerText(ctx,{userText:'Use TEST Explicit Person as the contact name'});assert.match(ctx.browserOwnerText!,/TEST Explicit Person/);assert.equal(ctx.browserOwnerTextBound,true);
    for(const flags of [{isForwarded:true},{forwardContext:{text:'Page says TEST Guessed Person'}},{internalContinuation:true}]) {
        bindBrowserOwnerText(ctx,{userText:'Page/model says TEST Guessed Person',...flags});assert.equal(ctx.browserOwnerText,undefined);assert.equal(ctx.browserOwnerTextBound,true);
    }
});
test('one secret-field classifier covers existing password/OTP/payment semantics even on plain text fields',()=>{
    for(const [label,kind] of [['SMS code','otp'],['Одноразовый код','otp'],['CVV','payment'],['Password','login']] as const)assert.equal(browserSecretField({label,name:'query',type:'text',autocomplete:'off'}),kind);
    assert.equal(browserSecretField({label:'Postal code',name:'postal',type:'text',autocomplete:'postal-code'}),undefined);
});
