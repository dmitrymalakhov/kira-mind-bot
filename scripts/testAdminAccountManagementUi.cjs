'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs/promises'),path=require('node:path'),os=require('node:os');
const {buildHarness}=require('./testAdminAccountSwitchingUi.cjs');
async function run(harness){
 const {chromium}=require('playwright');
 const browser=await chromium.launch({executablePath:process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH,headless:true,args:['--no-sandbox','--disable-dev-shm-usage']});
 const context=await browser.newContext({viewport:{width:1280,height:950}}),page=await context.newPage();
 const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
 let accounts=ids.map((id,index)=>({id,username:`synthetic_${index}`,displayName:`Synthetic ${index}`,revision:String(index+1).padStart(64,'0'),
   accountState:'active',runtimeMode:'telegram',status:'ready',bot:{username:`synthetic_${index}_bot`,connected:true},canConnectBot:false,canReplaceBot:true,canDelete:true}));
 const writes=[],errors=[],receipts=new Map();let loseRename=true,holdReplacement=false,releaseReplacement,sequence=2;
 const origin='https://synthetic.example.invalid';
 page.on('pageerror',error=>errors.push(error.message));
 try{
  await context.route('**/*',async route=>{
   const request=route.request(),url=new URL(request.url()),endpoint=url.pathname,method=request.method();
   if(url.origin!==origin)return route.abort();
   const scoped=/^\/api\/account-scopes\/([^/]+)\/(.+)$/.exec(endpoint),id=scoped?.[1],resource=scoped?'/api/'+scoped[2]:endpoint;
   const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{...(id?{'x-kira-account-id':id}:{}),'cache-control':'no-store'},body:JSON.stringify(body)});
   if(endpoint==='/api/auth/context')return json({csrfEnabled:true,csrfToken:'synthetic-csrf',accountLoginEnabled:false});
   if(endpoint==='/api/accounts')return json({version:1,available:true,capacity:10,accounts});
   const mutation=/^\/api\/accounts\/([^/]+)(\/bot\/replacement)?$/.exec(endpoint);
   if(mutation){
    const body=request.postDataJSON(),key=request.headers()['idempotency-key'];assert.ok(key);assert.equal(request.headers()['x-csrf-token'],'synthetic-csrf');
    writes.push({id:mutation[1],method,body,key});
    if(receipts.has(key))return json(receipts.get(key),method==='DELETE'?202:200);
    const account=accounts.find(item=>item.id===mutation[1]);assert.ok(account);assert.equal(body.revision,account.revision);
    if(method==='PATCH'){
     account.displayName=body.displayName;account.revision=String(++sequence).padStart(64,'0');
     const result={version:1,account:{...account}};receipts.set(key,result);
     if(loseRename){loseRename=false;return json({error:'Synthetic lost rename reply'},503);}return json(result);
    }
    assert.equal(body.confirmation,account.username);
    if(method==='POST'){
     if(body.botToken==='synthetic-invalid-token')return json({error:'Synthetic token rejected'},400);
     assert.equal(body.botToken,'synthetic-new-bot-token');
     if(holdReplacement){holdReplacement=false;await new Promise(resolve=>{releaseReplacement=resolve;});}
     account.bot={username:'synthetic_replacement_bot',connected:true};account.revision=String(++sequence).padStart(64,'0');
     const result={version:1,account:{...account}};receipts.set(key,result);return json(result);
    }
    assert.equal(method,'DELETE');accounts=accounts.filter(item=>item.id!==account.id);
    const result={version:1,status:'deleting',deletionId:ids[1],requestedAt:new Date().toISOString()};receipts.set(key,result);return json(result,202);
   }
   if(resource.startsWith('/api/')){
    if(resource==='/api/config')return json({USER_TIMEZONE:{value:'UTC',masked:false,readOnly:id==='instance'}});
    if(resource==='/api/status')return json({containers:[],serverTime:new Date().toISOString()});
    return json({error:'Synthetic optional service unavailable'},503);
   }
   const file=endpoint.startsWith('/brand/')?path.resolve(__dirname,'../admin-panel/public',endpoint.slice(1)):path.join(harness,endpoint==='/'?'index.html':endpoint.slice(1));
   return route.fulfill({contentType:endpoint.endsWith('.js')?'application/javascript':endpoint.endsWith('.css')?'text/css':'text/html',body:await fs.readFile(file)});
  });
  await page.goto(origin);await page.getByRole('combobox',{name:'Аккаунт',exact:true}).waitFor();
  await page.getByRole('button',{name:'Аккаунты и боты',exact:true}).click();
  const card=()=>page.locator(`[data-account="${ids[0]}"]`),dialog=()=>page.getByRole('dialog');
  await card().getByRole('button',{name:'Переименовать',exact:true}).click();
  await page.setViewportSize({width:360,height:780});
  await page.getByLabel(/^Название аккаунта/).fill('Синтетическая Кира');
  assert.equal(await dialog().evaluate(element=>element.scrollWidth<=element.clientWidth),true);
  await page.getByRole('button',{name:'Сохранить название',exact:true}).click();
  await page.getByText('Synthetic lost rename reply',{exact:true}).waitFor();
  assert.equal(await page.getByLabel(/^Название аккаунта/).inputValue(),'Синтетическая Кира');
  await page.getByRole('button',{name:'Сохранить название',exact:true}).click();await dialog().waitFor({state:'hidden'});
  await card().getByRole('heading',{name:'Синтетическая Кира',exact:true}).waitFor();
  assert.equal(writes[0].key,writes[1].key);assert.equal(accounts[0].username,'synthetic_0');
  assert.match(await page.getByRole('combobox',{name:'Аккаунт',exact:true}).innerText(),/Синтетическая Кира/);
  await page.setViewportSize({width:1280,height:950});
  await card().getByRole('button',{name:'Сменить бота',exact:true}).click();
  assert.equal(await page.getByRole('button',{name:'Заменить бота',exact:true}).isDisabled(),true);
  await page.getByLabel(/^Токен нового бота/).fill('synthetic-invalid-token');await page.getByLabel(/^Логин для подтверждения/).fill('Synthetic 0');
  assert.equal(await page.getByRole('button',{name:'Заменить бота',exact:true}).isDisabled(),true);
  await page.getByLabel(/^Логин для подтверждения/).fill('synthetic_0');await page.getByRole('button',{name:'Заменить бота',exact:true}).click();
  await page.getByText('Synthetic token rejected',{exact:true}).waitFor();
  await page.getByLabel(/^Токен нового бота/).fill('synthetic-new-bot-token');holdReplacement=true;
  await page.getByRole('button',{name:'Заменить бота',exact:true}).click();
  for(let i=0;i<100&&!releaseReplacement;i++)await page.waitForTimeout(20);assert.ok(releaseReplacement);
  assert.equal(await page.getByRole('combobox',{name:'Аккаунт',exact:true,includeHidden:true}).isDisabled(),true);releaseReplacement();
  await page.getByRole('link',{name:'Открыть нового бота',exact:true}).waitFor();
  assert.equal(await page.getByRole('link',{name:'Открыть нового бота',exact:true}).getAttribute('href'),'https://t.me/synthetic_replacement_bot');
  assert.equal(await page.getByLabel(/^Токен нового бота/).count(),0);
  assert.equal(await page.evaluate(()=>JSON.stringify({...sessionStorage,...localStorage}).includes('synthetic-new-bot-token')),false);
  await dialog().getByRole('button',{name:'Закрыть',exact:true}).click();
  assert.equal(accounts[0].id,ids[0]);assert.equal(accounts[1].bot.username,'synthetic_1_bot');
  await card().getByRole('button',{name:'Удалить аккаунт',exact:true}).click();
  await page.getByText(/память, чаты, задачи, настройки и файлы будут безвозвратно удалены/).waitFor();
  assert.equal(await page.getByRole('button',{name:'Удалить навсегда',exact:true}).isDisabled(),true);
  await page.getByLabel(/^Логин для подтверждения/).fill('Синтетическая Кира');
  assert.equal(await page.getByRole('button',{name:'Удалить навсегда',exact:true}).isDisabled(),true);
  await page.getByRole('button',{name:'Отмена',exact:true}).click();assert.equal(writes.filter(item=>item.method==='DELETE').length,0);
  await card().getByRole('button',{name:'Удалить аккаунт',exact:true}).click();await page.getByLabel(/^Логин для подтверждения/).fill('synthetic_0');
  await page.getByRole('button',{name:'Удалить навсегда',exact:true}).click();await dialog().waitFor({state:'hidden'});
  await card().waitFor({state:'detached'});assert.equal(accounts.length,1);assert.equal(accounts[0].id,ids[1]);
  await page.getByText('Выбранный аккаунт больше недоступен. Выберите другую Киру.',{exact:true}).waitFor();
  assert.match(await page.getByRole('combobox',{name:'Аккаунт',exact:true}).innerText(),/Недоступный аккаунт/,'deleted selection never silently opens another tenant');
  await page.getByRole('combobox',{name:'Аккаунт',exact:true}).click();await page.getByRole('option',{name:'Synthetic 1 · @synthetic_1_bot',exact:true}).click();
  await page.getByRole('heading',{name:'Аккаунты и боты',exact:true}).waitFor();
  assert.deepEqual(errors,[]);assert.ok(writes.every(item=>item.id===ids[0]));assert.equal(writes.filter(item=>item.method==='DELETE').length,1);
  console.log('Admin account management UI passed: rename retry, stable login/selection, token correction, confirmation, busy lock, secret clearing, permanent deletion, isolation and mobile forms');
 }finally{releaseReplacement?.();await context.close();await browser.close();}
}
async function main(){const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'kira-account-management-ui-'));try{await buildHarness(scratch);await run(scratch);}finally{await fs.rm(scratch,{recursive:true,force:true});}}
main().catch(error=>{console.error(error);process.exitCode=1;});
