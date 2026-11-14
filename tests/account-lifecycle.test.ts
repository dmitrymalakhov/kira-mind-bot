import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { accountDisplayName,accountRevision,checkAccountRevision } from '../platform/accountMetadata';
import { telegramSessionTransport } from '../services/telegramSessionTransport';

test('account titles preserve login and lifecycle revisions reject changed owner, credentials or bot',()=>{
    assert.equal(accountDisplayName('  Синтетическая Кира  '),'Синтетическая Кира');
    assert.equal(accountDisplayName('e\u0301'),'é');
    assert.equal(accountDisplayName('😀'.repeat(80)),'😀'.repeat(80));
    for(const value of ['', ' '.repeat(10),'x'.repeat(81),'😀'.repeat(81),'Synthetic\nname','Synthetic\u202ename',null,{}])assert.throws(()=>accountDisplayName(value));
    const account:any={id:randomUUID(),username:'synthetic_login',bot_id:'100001',bot_username:'synthetic_bot',owner_id:'10001',secrets:'synthetic-encrypted'};
    const revision=accountRevision(account);assert.match(revision,/^[0-9a-f]{64}$/);checkAccountRevision(account,revision);
    for(const change of [{display_name:'New name'},{owner_id:'10002'},{secrets:'synthetic-new-secret'},{bot_id:'100002'},{account_state:'deleting'}])
        assert.throws(()=>checkAccountRevision({...account,...change},revision),(e:any)=>e.code==='account_changed');
    assert.doesNotMatch(revision,/synthetic/);
});

test('changing Telegram bot keeps account dialogue and durable work but removes old transport message IDs and pending UI',()=>{
    const state={messageHistory:[{role:'user',content:'Synthetic question',messageId:17,replyToMessageId:16}],dialogueSummary:'Synthetic dialogue',domains:{work:['Synthetic fact']},
        workingMemory:{goal:'Synthetic goal'},agentRuntime:{id:'synthetic-task'},sentMessages:{17:true},sentMessageContexts:{17:{text:'Synthetic sent text'}},
        pendingQuickChoices:{messageId:19},pendingRecurringTaskEdit:{messageId:20},lastSchedulableRequest:{messageId:21}};
    const env={KIRA_BOT_TOKEN:'200002:synthetic-new-token',KIRA_SESSION_LEGACY_TELEGRAM_BOT_ID:'100001'};
    const changed=telegramSessionTransport(state,'10001',env);
    assert.equal(changed.telegramBotId,'200002');assert.deepEqual(changed.messageHistory,[{role:'user',content:'Synthetic question'}]);
    assert.deepEqual(changed.sentMessages,{});assert.deepEqual(changed.sentMessageContexts,{});assert.equal(changed.pendingQuickChoices,undefined);
    assert.equal(changed.pendingRecurringTaskEdit,undefined);assert.equal(changed.lastSchedulableRequest,undefined);
    assert.deepEqual(changed.domains,state.domains);assert.deepEqual(changed.agentRuntime,state.agentRuntime);assert.deepEqual(changed.workingMemory,state.workingMemory);
    assert.equal(changed.dialogueSummary,state.dialogueSummary);assert.equal(state.messageHistory[0].messageId,17,'stored snapshot is never mutated in place');
    const next={...changed,sentMessageContexts:{30:{text:'Synthetic new bot text'}}};
    assert.deepEqual(telegramSessionTransport(next,'10001',env).sentMessageContexts,next.sentMessageContexts);
    assert.deepEqual(telegramSessionTransport(state,'10001',env,true).sentMessageContexts,state.sentMessageContexts,'new output is stamped without discarding its own IDs');
    assert.equal(telegramSessionTransport(state,'api:10001',env),state);
    assert.equal(telegramSessionTransport(state,'10001',{...env,KIRA_RUNTIME_MODE:'api_only'}),state);
    assert.equal(telegramSessionTransport(state,'10001',{KIRA_BOT_TOKEN:'200002:synthetic-token'}),state,'ordinary legacy sessions retain prior behavior');
    assert.equal(telegramSessionTransport(state,'10001',{...env,KIRA_BOT_TOKEN:'100001:synthetic-rotated-token'}).messageHistory[0].messageId,17,'token rotation for the same bot retains message references');
});
