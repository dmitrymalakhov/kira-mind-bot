'use strict';
// Real App/API client in an isolated browser. Every account and response is synthetic.
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { pathToFileURL } = require('node:url');

async function buildHarness(outDir) {
  const root = path.resolve(__dirname, '../admin-panel');
  const { build } = await import(pathToFileURL(require.resolve('vite', { paths: [root] })).href);
  const { default: react } = await import(pathToFileURL(require.resolve('@vitejs/plugin-react', { paths: [root] })).href);
  const result = await build({ root, configFile: false, plugins: [react(), {
    name: 'switching-ui-fixture', resolveId(id) { if (id === 'virtual:switching-ui') return '\0switching-ui.tsx'; },
    load(id) { if (id === '\0switching-ui.tsx') return `
      import React from 'react';import {createRoot} from 'react-dom/client';
      import {ThemeProvider,CssBaseline} from '@mui/material';import {theme} from '/src/theme.ts';import App from '/src/App.tsx';
      createRoot(document.getElementById('root')).render(<ThemeProvider theme={theme}><CssBaseline/><App/></ThemeProvider>);
    `; },
  }], build: { outDir, emptyOutDir: true, rollupOptions: { input: 'virtual:switching-ui' } } });
  const entry = (Array.isArray(result) ? result[0] : result).output.find(item => item.type === 'chunk' && item.isEntry);
  await fs.writeFile(path.join(outDir, 'index.html'), `<!doctype html><html lang="ru"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><div id="root"></div><script type="module" src="/${entry.fileName}"></script></html>`);
}

async function run(harness) {
  const { chromium } = require('playwright');
  const browser = await chromium.launch({ executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH, headless: true, args: ['--no-sandbox','--disable-dev-shm-usage'] });
  const ids=['11111111-1111-4111-8111-111111111111','22222222-2222-4222-8222-222222222222'];
  const accounts=ids.map((id,i)=>({id,username:`synthetic_${i}`,accountState:'active',runtimeMode:'telegram',status:'ready',bot:{username:`synthetic_${i}_bot`,connected:true},canConnectBot:false}));
  const names=['Synthetic A','Synthetic B'];const writes=[],reads=[],errors=[];let failId,holdRead,holdWrite,releaseRead,releaseWrite;
  const origin='https://synthetic.example.invalid';
  const context=await browser.newContext({viewport:{width:1280,height:950}});
  try {
    await context.route('**/*',async route=>{
      const req=route.request(),url=new URL(req.url()),endpoint=url.pathname;
      if(url.origin!==origin)return route.abort();
      const match=/^\/api\/account-scopes\/([^/]+)\/(.+)$/.exec(endpoint),id=match?.[1],resource=match?'/api/'+match[2]:endpoint,index=ids.indexOf(id);
      const json=(body,status=200)=>route.fulfill({status,contentType:'application/json',headers:{...(id?{'x-kira-account-id':id}:{}),'cache-control':'no-store'},body:JSON.stringify(body)});
      if(resource==='/api/auth/context')return json({csrfEnabled:true,csrfToken:'synthetic-csrf',accountLoginEnabled:false});
      if(resource==='/api/accounts')return json({version:1,available:true,capacity:10,accounts});
      if(resource.startsWith('/api/')){
        assert.ok(id,'all tenant API requests must capture the selected scope');
        if(resource!=='/api/health/export')assert.equal(req.headers()['x-kira-account-id'],id);
        if(req.method()!=='GET'){
          assert.equal(req.headers()['x-csrf-token'],'synthetic-csrf');assert.ok(req.headers()['idempotency-key']);
          writes.push({id,resource,body:req.postDataJSON()});
          if(holdWrite===id){holdWrite=undefined;await new Promise(resolve=>{releaseWrite=resolve;});}
        }else reads.push({id,resource});
        if(resource==='/api/config'){
          if(failId===id)return json({error:'Synthetic selected account unavailable'},503);
          return json({USER_TIMEZONE:{value:index===0?'Europe/Amsterdam':'Asia/Tokyo',masked:false,revision:'a'.repeat(64)},
            KIRA_ALLOWED_USER_ID:{value:String(index+10001),masked:false,readOnly:true}});
        }
        if(resource==='/api/status')return json({containers:[],serverTime:new Date().toISOString()});
        if(resource==='/api/health/export')return route.fulfill({status:200,headers:{'content-type':'text/csv','content-disposition':'attachment; filename="synthetic.csv"','x-kira-account-id':id},body:'synthetic export'});
        if(resource==='/api/personality'){
          if(req.method()==='POST'){names[index]=req.postDataJSON().KiraMindBot.characterName;return json({success:true});}
          if(holdRead===id){holdRead=undefined;await new Promise(resolve=>{releaseRead=resolve;});}
          return json({KiraMindBot:{characterName:names[index],characterGender:'женский',currentCity:'Synthetic City',persona:'Synthetic story'}});
        }
        if(resource==='/api/chats')return json([{chatId:'-10001',profile:'KiraMindBot',title:`Synthetic chat ${index}`,chatType:'supergroup',publicMode:false,allowedDomains:[],firstSeenAt:new Date().toISOString(),lastSeenAt:new Date().toISOString()}]);
        if(resource==='/api/recurring-tasks')return json([{id:ids[0],title:`Synthetic task ${index}`,prompt:'Synthetic request',chatId:String(index+10001),userId:String(index+10001),chatType:'private',status:'paused',
          schedule:{kind:'daily',hour:12,minute:0},timezone:'UTC',nextRunAt:'2037-01-01T12:00:00Z',createdAt:'2036-01-01T12:00:00Z',updatedAt:'2036-01-01T12:00:00Z',runCount:0,consecutiveFailures:0}]);
        if(resource==='/api/memory')return json({records:[{id:ids[0],domain:'general',content:`Synthetic memory ${index}`,userId:String(index+10001),memoryKind:'fact',status:'active',timestamp:new Date().toISOString(),tags:[],confidence:.9,
          importance:.5,strength:1,sourceMemoryIds:[],sourceMessageIds:[],relatedIds:[],previousVersions:[],retrievalCount:0,confirmationCount:0}],
          stats:{total:1,byDomain:[{domain:'general',count:1}],byKind:[{kind:'fact',count:1}],byStatus:[],dreaming:{}},total:1,limit:50,offset:0,domains:['general'],kinds:['fact'],statuses:[],focuses:[]});
        if(resource==='/api/health/logs')return json({records:[],total:0,limit:100,offset:0,filters:{},stats:{total:0,byKind:[]}});
        return json({error:'Synthetic optional service unavailable'},503);
      }
      const file=endpoint.startsWith('/brand/')?path.resolve(__dirname,'../admin-panel/public',endpoint.slice(1)):path.join(harness,endpoint==='/'?'index.html':endpoint.slice(1));
      return route.fulfill({contentType:endpoint.endsWith('.js')?'application/javascript':endpoint.endsWith('.css')?'text/css':'text/html',body:await fs.readFile(file)});
    });
    const page=await context.newPage();page.on('pageerror',error=>errors.push(error.message));
    const waitFor=async(predicate)=>{for(let i=0;i<100;i++){if(predicate())return;await page.waitForTimeout(20);}throw Error('Synthetic request was not issued');};
    const select=async(index)=>{await page.getByRole('combobox',{name:'Аккаунт',exact:true}).click();await page.getByRole('option',{name:index==='instance'?'Инстанс · общие подключения':`synthetic_${index} · @synthetic_${index}_bot`,exact:true}).click();};
    const nav=async(label)=>{
      if(await page.getByRole('button',{name:'Открыть меню',exact:true}).isVisible())await page.getByRole('button',{name:'Открыть меню',exact:true}).click();
      await page.getByRole('button',{name:label,exact:true}).click();
    };
    await page.goto(origin);await page.getByRole('combobox',{name:'Аккаунт',exact:true}).waitFor();
    await nav('Личность');await page.getByLabel('Имя ассистента',{exact:true}).waitFor();assert.equal(await page.getByLabel('Имя ассистента',{exact:true}).inputValue(),'Synthetic A');
    await page.getByLabel('Имя ассистента',{exact:true}).fill('Synthetic unsaved');await select(1);
    await page.getByRole('dialog',{name:'Есть несохранённые изменения'}).waitFor();await page.getByRole('button',{name:'Остаться',exact:true}).click();
    assert.equal(await page.getByLabel('Имя ассистента',{exact:true}).inputValue(),'Synthetic unsaved');assert.equal(writes.length,0);
    await select(1);await page.getByRole('button',{name:'Отбросить и переключить',exact:true}).click();
    await page.waitForFunction(()=>document.querySelector('input[value="Synthetic B"]'));
    assert.equal(await page.getByRole('heading',{name:'Личность',exact:true}).count(),1,'switch preserves current section');
    await page.getByLabel('Имя ассистента',{exact:true}).fill('Synthetic B saved');holdWrite=ids[1];await page.getByRole('button',{name:'Сохранить',exact:true}).click();
    await waitFor(()=>releaseWrite);assert.equal(await page.getByRole('combobox',{name:'Аккаунт',exact:true}).isDisabled(),true);releaseWrite();
    await waitFor(()=>names[1]==='Synthetic B saved');
    await page.waitForFunction(()=>!document.querySelector('[aria-labelledby="account-selector-label"]')?.getAttribute('aria-disabled'));
    await select(0);await page.waitForFunction(()=>document.querySelector('input[value="Synthetic A"]'));
    assert.equal(writes[0].id,ids[1]);assert.equal(names[0],'Synthetic A');
    // A delayed read is aborted on switch, even if its upstream reply arrives afterwards.
    await select(1);await page.waitForFunction(()=>document.querySelector('input[value="Synthetic B saved"]'));holdRead=ids[0];await select(0);await waitFor(()=>releaseRead);
    await select(1);releaseRead();await page.waitForFunction(()=>document.querySelector('input[value="Synthetic B saved"]'));
    for(const [label,text]of [['Чаты','Synthetic chat'],['Задачи','Synthetic task'],['Память','Synthetic memory']]){
      await nav(label);await page.getByText(`${text} 1`,{exact:true}).first().waitFor();await select(0);await page.getByText(`${text} 0`,{exact:true}).first().waitFor();
      assert.equal(await page.getByText(`${text} 1`,{exact:true}).count(),0);await select(1);await page.getByText(`${text} 1`,{exact:true}).first().waitFor();
    }
    await nav('Здоровье');const downloaded=page.waitForEvent('download');await page.getByRole('button',{name:'CSV',exact:true}).click();
    assert.ok((await downloaded).url().includes(`/account-scopes/${ids[1]}/health/export`));
    await page.reload();await page.getByRole('combobox',{name:'Аккаунт',exact:true}).waitFor();assert.match(await page.getByRole('combobox',{name:'Аккаунт',exact:true}).innerText(),/synthetic_1/);
    const tab=await context.newPage();await tab.goto(origin);await tab.getByRole('combobox',{name:'Аккаунт',exact:true}).waitFor();assert.match(await tab.getByRole('combobox',{name:'Аккаунт',exact:true}).innerText(),/synthetic_0/);await tab.close();
    failId=ids[0];await select(0);await page.getByText('Synthetic selected account unavailable',{exact:true}).waitFor();assert.equal(await page.getByLabel('Имя ассистента',{exact:true}).count(),0);
    await nav('Аккаунты и боты');await page.getByRole('button',{name:'Создать аккаунт',exact:true}).waitFor();
    failId=undefined;await page.locator(`[data-account="${ids[1]}"]`).getByRole('button',{name:'Управлять',exact:true}).click();
    await page.getByRole('heading',{name:'Модели',exact:true}).waitFor();
    await select('instance');await page.getByRole('tab',{name:'Подключения',exact:true}).waitFor();assert.equal(await page.getByRole('button',{name:'Память',exact:true}).isDisabled(),true);
    await page.setViewportSize({width:360,height:780});assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    await select(0);assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth<=innerWidth),true);
    assert.deepEqual(errors,[]);assert.ok(reads.every(read=>ids.includes(read.id)||read.id==='instance'));
    console.log('Admin switching UI passed: scopes, drafts, delayed reads, mutation lock, independent tabs, reload, errors, scoped exports, cards and mobile layout');
  }finally{releaseRead?.();releaseWrite?.();await context.close();await browser.close();}
}
async function main(){const scratch=await fs.mkdtemp(path.join(os.tmpdir(),'kira-admin-switch-ui-'));try{await buildHarness(scratch);await run(scratch);}finally{await fs.rm(scratch,{recursive:true,force:true});}}
module.exports={buildHarness};
if(require.main===module)main().catch(error=>{console.error(error);process.exitCode=1;});
