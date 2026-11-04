import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { runInNewContext } from 'node:vm';

class Element {
    clientWidth = 252; hidden = false; open = false; disabled = false; value = ''; textContent = ''; type = ''; className = '';
    children: any[] = []; listeners = new Map<string,Function>(); classList = {add:()=>{}};
    elements: any = {username:{value:'synthetic_operator',focus(){}},password:{value:'synthetic-operator-password'}};
    addEventListener(name:string,handler:Function){this.listeners.set(name,handler);}
    append(...items:any[]){this.children.push(...items);} replaceChildren(...items:any[]){this.children=items;}
    setAttribute(){} showModal(){this.open=true;} close(){this.open=false;} focus(){} remove(){} reset(){this.elements.password.value='';}
    async fire(name:string){await this.listeners.get(name)?.({preventDefault(){},currentTarget:this});}
}
function latch(){let resolve!:(value?:any)=>void;const promise=new Promise<any>(done=>{resolve=done;});return{promise,resolve};}
const accountId = '11111111-1111-4111-8111-111111111111';
const session = (operatorAccess=false) => ({account:{id:accountId,username:'synthetic_account',runtimeState:'ready',consent:{aiAllowed:false}},operatorAccess,operatorLinkingAvailable:true});
const response = (value:any,status=200)=>new Response(JSON.stringify(value),{status,headers:{'content-type':'application/json'}});
function fixture(fetcher:(path:string,init:any)=>Promise<Response>){
    const elements = new Map<string,Element>(), get=(id:string)=>{if(!elements.has(id))elements.set(id,new Element());return elements.get(id)!;};
    const document = {getElementById:get,createElement:()=>new Element(),createElementNS:()=>new Element(),head:new Element()};
    const context:any={document,window:{crypto:{randomUUID}},fetch:fetcher,Headers,AbortController,URL,TextDecoder,Uint8Array,atob,Date,Intl,setTimeout,clearTimeout,matchMedia:()=>({matches:false}),location:{origin:'https://synthetic.example.invalid',assign(){}},sessionStorage:{getItem:()=>null,setItem(){},removeItem(){}}};
    const source=readFileSync('account-console/account.js','utf8').replace('  void start();','  globalThis.fixture = {state,applyIntent,loginView,logout,saveHint,captcha};');
    runInNewContext(source,context);
    const api=context.fixture;api.state.config={csrfToken:'synthetic-csrf',providers:[],hasBrowserSession:true};api.state.session=session();
    return{...api,get,window:context.window};
}

for(const kind of ['link','unlink']) test(`cancel while validating ${kind} intent prevents a stale mutation or next flow`,async()=>{
    const reached=latch(),resume=latch(),calls:string[]=[];
    const f=fixture(async(path,init)=>{
        calls.push(`${init?.method||'GET'} ${path}`);
        if(path==='/api/v1/web/session'){reached.resolve();await resume.promise;return response(session());}
        if(path.endsWith('identities'))return response({identities:[]});
        return response({});
    });
    f.state.intent={kind,provider:'google',identityId:'22222222-2222-4222-8222-222222222222',accountId};
    f.state.grant={value:'synthetic-reauth',expiresAt:Date.now()+60000};
    const pending=f.applyIntent();await reached.promise;
    await f.get('proof-cancel').fire('click');
    const next={kind:'operator',accountId};f.saveHint(next);resume.resolve();await pending;
    assert.equal(f.state.intent,next);
    assert.ok(!calls.some(call=>call.startsWith('DELETE')||call.includes('/auth/challenges')),calls.join('\n'));
});

test('cancel during final operator readback cannot clear a newer intent or its proof',async()=>{
    const reached=latch(),resume=latch();let sessions=0,grants=0;
    const f=fixture(async(path)=>{
        if(path==='/api/v1/web/session'){if(++sessions===3){reached.resolve();await resume.promise;}return response(session(sessions===3));}
        if(path==='/operator/api/auth/context')return response({csrfToken:'synthetic-operator-csrf'});
        if(path==='/operator/api/login')return response({success:true,csrfToken:'synthetic-after-login'});
        if(path==='/operator/api/operator/link-account'){grants++;return response({version:1,accountId,operatorAccess:true});}
        return response({});
    });
    f.state.intent={kind:'operator',accountId};f.state.grant={value:'synthetic-reauth',expiresAt:Date.now()+60000};f.get('operator-dialog').showModal();
    const pending=f.get('operator-form').fire('submit');await reached.promise;
    await f.get('operator-cancel').fire('click');
    const next={kind:'link',provider:'telegram',accountId},grant={value:'synthetic-new-proof',expiresAt:Date.now()+60000};f.saveHint(next);f.state.grant=grant;
    resume.resolve();await pending;
    assert.equal(grants,1);assert.equal(f.state.intent,next);assert.equal(f.state.grant,grant);
    assert.equal(f.get('notice').children[0].textContent,'Результат пока не подтверждён. Проверь доступ аккаунта.');
});

test('terminal credential failure retains logout and the UI calls server logout without requiring live access',async()=>{
    const calls:string[]=[];
    const f=fixture(async(path)=>{calls.push(path);return response(path.endsWith('/config')?{csrfToken:'fresh',providers:[],hasBrowserSession:false}:{version:1,ok:true});});
    f.state.session=null;f.loginView();assert.equal(f.get('logout').hidden,false);
    await f.logout();assert.deepEqual(calls,['/api/v1/web/auth/logout','/api/v1/web/config']);assert.equal(f.get('logout').hidden,true);
});

test('narrow proof dialog selects compact CAPTCHA rather than clipping a required control',async()=>{
    const f=fixture(async()=>response({})),options:any[]=[];
    f.window.hcaptcha={render:(_slot:any,value:any)=>{options.push(value);return 1;}};
    f.state.config.proof={hcaptchaSiteKey:'synthetic-site-key'};
    const context={sequence:0};f.state.flow=context;await f.captcha(context);
    assert.equal(options.length,1);assert.equal(options[0].size,'compact');
});
