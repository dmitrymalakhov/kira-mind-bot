'use strict';

// Operator-only semantic check: configured provider, fictional inputs, no application data.
// Run in an isolated image without account/profile/memory mounts. Ordinary npm test is offline.
const assert = require('node:assert/strict');
const root = process.env.KIRA_PROBE_DIST || '/app/dist';
const { classifyMessage } = require(root + '/orchestrator');
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
    console.log(JSON.stringify({ type:'semantic-result', total:cases.length, failures }));
    assert.equal(failures, 0, 'Browser intake semantic cases failed');
})().catch(error => { console.error(error.name + ': ' + error.message); process.exitCode = 1; });
