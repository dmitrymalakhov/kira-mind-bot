'use strict';

// Operator-only semantic check: configured provider, fictional inputs, no application data.
// Run in an isolated image without account/profile/memory mounts. Ordinary npm test is offline.
const assert = require('node:assert/strict');
const root = process.env.KIRA_PROBE_DIST || '/app/dist';
const { classifyMessage } = require(root + '/orchestrator');
const { createBrowserWorkspace, attachBrowserWorkspace } = require(root + '/services/browserWorkspace');
const cases = [
    { id: 'open-view', text: 'Открой https://example.com и оставь страницу открытой, дальше я сам.', intent: 'БРАУЗЕР_ЗАДАЧА', control: 'continue' },
    { id: 'scoped-prohibition', text: 'Посмотри страницу https://example.com. Не бронируй и не отправляй форму; покажи мне её для ручного управления.', intent: 'БРАУЗЕР_ЗАДАЧА', control: 'continue' },
    { id: 'wait-for-user', text: 'Это технический тест браузера, все данные демонстрационной страницы вымышлены. Открой https://example.com. Ничего не бронируй и не отправляй, ничего из теста не запоминай. Пока ничего не заполняй: я сам возьму ручное управление. Спроси, готов ли я, и оставь эту же страницу открытой для продолжения, ожидая моего ответа.', intent: 'БРАУЗЕР_ЗАДАЧА', control: 'continue' },
    { id: 'continued-limits', text: 'Не оформляй заявку, только продолжи просмотр этой страницы.', history: [{role:'user',content:'Открой https://example.com и покажи форму.'},{role:'bot',content:'Страница открыта. Заполнить заявку?'}], intent: 'БРАУЗЕР_ЗАДАЧА', control: 'continue' },
    { id: 'whole-refusal', text: 'Я передумал записываться, останови всю браузерную задачу.', history: [{role:'user',content:'Открой форму записи на https://example.com.'}], intent: 'БРАУЗЕР_ЗАДАЧА', control: 'cancel' },
    { id: 'scoped-stop', text: 'Останови все бронирования, но страницу оставь открытой для просмотра.', history: [{role:'user',content:'Открой форму записи на https://example.com.'}], intent: 'БРАУЗЕР_ЗАДАЧА', control: 'continue' },
    { id: 'explanation', text: 'Ничего не бронируй, просто объясни, как обычно устроено бронирование столиков.', intent: 'РАЗГОВОР' },
    { id: 'quoted-request', text: 'Переведи на английский фразу: «Открой страницу и не бронируй ничего».', intent: 'РАЗГОВОР' },
    { id: 'greeting-opt-in', text: 'Привет!', intent: 'РАЗГОВОР', fast: true },
    { id: 'research-opt-in', text: 'Поищи в интернете актуальные новости об астрономии.', intent: 'ВЕБ_ПОИСК', fast: true },
];
(async () => {
    let failures = 0;
    for (const item of cases) {
        const result = await classifyMessage(item.text, false, '', item.history || [], [], item.fast ? {} : undefined);
        const passed = result.intent === item.intent && (!item.control || result.details.browserTaskControl === item.control) &&
            (item.intent !== 'БРАУЗЕР_ЗАДАЧА' || !result.fastReply || result.fastReply.mode === 'route');
        if (!passed) failures++;
        console.log(JSON.stringify({ type:'semantic-case', id:item.id, passed, intent:result.intent,
            control:result.details.browserTaskControl, fastMode:result.fastReply?.mode }));
    }
    const continuations=[
        ['schedule','Inspect the synthetic schedule, preserving dates and direct links.','А что из этого на следующую пятницу?'],
        ['restaurant','Prepare a restaurant request; ask for party size; never submit.','Нас будет четверо. Пока оставь черновик.'],
        ['catalog','Compare two lamps by price, color and power; do not buy.','Открой тот, который дешевле, но проверь цвет.'],
        ['research','Read a list and its detail sources; compare maintenance limitations.','А у второго какие ограничения?'],
        ['held-out-form','Prepare a fictional equipment-loan form; ask for purpose and duration; never submit.','Исправь назначение на учебное и переходи к следующему шагу.'],
    ];
    for(const [id,goal,text] of continuations){
        const workspace=createBrowserWorkspace(94208,'api:94208','synthetic-'+id,goal);
        workspace.status='completed';workspace.currentUrl=`https://${id}.example/list`;
        workspace.records=[{id:'synthetic-first',title:'TEST First',url:`https://${id}.example/first`,sourceUrl:workspace.currentUrl,attributes:{price:'20 EUR',date:'2026-11-06'},excerpt:'Synthetic first source',observedAt:new Date().toISOString()},
            {id:'synthetic-second',title:'TEST Second',url:`https://${id}.example/second`,sourceUrl:workspace.currentUrl,attributes:{price:'30 EUR',date:'2026-11-07'},excerpt:'Synthetic second source',observedAt:new Date().toISOString()}];
        const result=await classifyMessage(text,false,'',[],[],undefined,undefined,undefined,workspace);
        const passed=result.intent==='БРАУЗЕР_ЗАДАЧА'&&result.details.browserWorkspace?.id===workspace.id&&result.details.browserWorkspace?.relation==='continue';
        if(!passed)failures++;
        console.log(JSON.stringify({type:'workspace-semantic-case',id,passed,intent:result.intent,relation:result.details.browserWorkspace?.relation}));
        const updated=attachBrowserWorkspace(workspace,'synthetic-next-'+id,text);
        const followup=await classifyMessage('Теперь проверь подробности выбранного варианта с учётом моих уточнений.',false,'',[],[],undefined,undefined,undefined,updated);
        const followed=followup.intent==='БРАУЗЕР_ЗАДАЧА'&&followup.details.browserWorkspace?.id===updated.id&&followup.details.browserWorkspace?.relation==='continue';
        if(!followed)failures++;
        console.log(JSON.stringify({type:'workspace-semantic-followup',id,passed:followed,intent:followup.intent,relation:followup.details.browserWorkspace?.relation}));
    }
    const unrelatedWorkspace=createBrowserWorkspace(94208,'api:94208','synthetic-unrelated','Compare synthetic sources; never submit.');
    const unrelated=await classifyMessage('Сочини короткое четверостишие про снег.',false,'',[],[],undefined,undefined,undefined,unrelatedWorkspace);
    const unrelatedPassed=unrelated.intent==='РАЗГОВОР'&&['new','unrelated'].includes(unrelated.details.browserWorkspace?.relation);
    if(!unrelatedPassed)failures++;
    console.log(JSON.stringify({type:'workspace-semantic-new-topic',passed:unrelatedPassed,intent:unrelated.intent,relation:unrelated.details.browserWorkspace?.relation}));
    console.log(JSON.stringify({ type:'semantic-result', total:cases.length+continuations.length*2+1, failures }));
    assert.equal(failures, 0, 'Browser intake semantic cases failed');
})().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
