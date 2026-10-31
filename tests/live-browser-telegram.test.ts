import test from 'node:test';
import assert from 'node:assert/strict';
import { config } from '../config';
import type { BotContext } from '../types';
import { LiveBrowserSession, liveBrowserSessions } from '../services/liveBrowserSession';
import { bindBrowserAssistanceMessage, browserAssistanceForReply, liveBrowserKeyboard, runTelegramBrowserResponsive, handleLiveBrowserCallback } from '../services/liveBrowserTelegram';

test('Telegram text/voice work releases the update reader only after browser startup, then retains the original operation', async () => {
    const old = config.allowedUserId; config.allowedUserId = 94001;
    try {
        for (const source of ['text','voice']) {
            const ctx = {from:{id:94001},chat:{id:94001,type:'private'},session:{},update:{update_id:1}} as unknown as BotContext;
            let done!:()=>void; const pending = new Promise<void>(r=>done=r); let completed=false;
            const responsive = runTelegramBrowserResponsive(ctx,async()=>{await pending;completed=true;});
            await new Promise(r=>setImmediate(r)); assert.equal(completed,false,source);
            ctx.releaseBrowserUpdate!(); await responsive; assert.equal(completed,false);
            done(); await pending; await new Promise(r=>setImmediate(r)); assert.equal(completed,true);
        }
    } finally {config.allowedUserId=old;}
});

test('Telegram replies retain the question actually sent; replaced or unknown message never binds to new help', async t => {
    const session = new LiveBrowserSession(94001,'94001','synthetic-telegram');t.after(()=>session.dispose());
    await session.needsUser('На сколько человек нужен стол?','information');const first=session.snapshot().assistanceRequest!.requestId;
    bindBrowserAssistanceMessage(session,101,first);
    await session.needsUser('В какое время?','information');const second=session.snapshot().assistanceRequest!.requestId;
    bindBrowserAssistanceMessage(session,102,second);
    assert.equal(browserAssistanceForReply(session,101),first);assert.equal(browserAssistanceForReply(session,102),second);
    assert.equal(browserAssistanceForReply(session,999),undefined);assert.equal(browserAssistanceForReply(session),second);
    await assert.rejects(session.answerAssistance('telegram-answer',session.telegramBody({assistanceRequestId:browserAssistanceForReply(session,101)}),'На четверых'),/прежнему вопросу/);
});

test('Telegram Stop button stays responsive to a pending model; callbacks are owner-bound and fit Telegram limits', async t => {
    const old=config.allowedUserId;config.allowedUserId=94001;t.after(()=>{config.allowedUserId=old;});
    const session=liveBrowserSessions.create(94001,'94001','synthetic-telegram-stop');t.after(()=>session.dispose());
    let release!:()=>void;const pending=new Promise<void>(r=>release=r);
    const running=session.runAgent(async()=>{await pending;session.assertAgent(1);}).catch(()=>{});
    const keyboard=liveBrowserKeyboard(session);
    for(const row of keyboard.inline_keyboard) for(const button of row) if('callback_data' in button) assert.ok(Buffer.byteLength(button.callback_data)<=64);
    const replies:string[]=[];const ctx={from:{id:94001},chat:{id:94001,type:'private'},session:{},callbackQuery:{id:'synthetic-stop-callback'},
        answerCallbackQuery:async()=>{},reply:async(text:string)=>{replies.push(text);return {message_id:1};}} as unknown as BotContext;
    const data=`lb:stop:${session.id}:0`;
    assert.equal(await handleLiveBrowserCallback({...ctx,from:{id:94002}} as BotContext,data),true);assert.equal(session.state,'starting');
    assert.equal(await handleLiveBrowserCallback(ctx,data),true);await new Promise(r=>setImmediate(r));assert.equal(session.state,'cancelled');
    release();await running;assert.equal(session.state,'cancelled');assert.equal(replies.length,1);
});
