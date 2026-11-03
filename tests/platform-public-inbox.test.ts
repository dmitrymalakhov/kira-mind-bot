import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PublicInbox } from '../platform/publicAccounts/inbox';
import { PublicSessions } from '../platform/publicAccounts/sessions';
import { PublicPushWorker } from '../platform/publicAccounts/pushWorker';
import { genericPushPayload, PushDelivery } from '../platform/publicAccounts/apns';
import { publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

test('durable inbox exists without push permission; retry/restart never loses it; only owning account reads/marks it', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const a=await store.create('synthetic_inbox','disabled'),b=await store.create('synthetic_other_inbox','disabled');
        const inbox=new PublicInbox(db,publicTestSecrets);
        const first=await inbox.append(a.id,'synthetic-reminder-1','reminder',{text:'Synthetic private reminder'});
        assert.deepEqual(await inbox.append(a.id,'synthetic-reminder-1','reminder',{text:'Synthetic private reminder'}),first);
        assert.equal((await db.query('SELECT * FROM kira_public_push_outbox')).length,0);
        assert.equal((await new PublicInbox(db,publicTestSecrets).list(a.id,20)).events.length,1);
        assert.equal((await inbox.list(b.id,20)).events.length,0);
        await assert.rejects(()=>inbox.read(b.id,first.id),(e:any)=>e.code==='not_found');
        await inbox.read(a.id,first.id);assert.ok((await inbox.list(a.id,20)).events[0].readAt);
        for(let n=2;n<=4;n++)await inbox.append(a.id,`synthetic-reminder-${n}`,'reminder',{text:`Synthetic reminder ${n}`});
        const page=await inbox.list(a.id,2);assert.ok(page.nextCursor);
        const next=await inbox.list(a.id,2,page.nextCursor!);
        assert.equal(new Set([...page.events,...next.events].map(e=>e.id)).size,4);
    });
});

test('APNs outbox retries outage, survives restart/expired lease and never includes private content', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const a=await store.create('synthetic_push','disabled'),device=randomUUID();
        await db.query("INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$1,'google','synthetic-push-subject')",[a.id]);
        const sessions=new PublicSessions(db,publicTestSecrets),inbox=new PublicInbox(db,publicTestSecrets);
        const pair=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,device,'Synthetic phone'));
        const auth=(await sessions.authenticate(pair.accessToken))!;
        await inbox.bind(a.id,auth.session,{version:1,deviceId:device,token:'ab'.repeat(32),environment:'sandbox'});
        const event=await inbox.append(a.id,'synthetic-private-result','task_result',{text:'Synthetic private health and chat details'});
        const sent:PushDelivery[]=[];
        await new PublicPushWorker(db,publicTestSecrets,{send:async delivery=>{sent.push(delivery);return 'retry';}}).drain();
        assert.equal((await db.query('SELECT state FROM kira_public_push_outbox'))[0].state,'pending');
        assert.equal((await inbox.list(a.id,20)).events.length,1);
        await db.query("UPDATE kira_public_push_outbox SET state='sending',lease_until=now()-interval '1 second',next_attempt_at=now()-interval '1 second'");
        await new PublicPushWorker(db,publicTestSecrets,{send:async delivery=>{sent.push(delivery);return 'accepted';}}).drain();
        assert.equal((await db.query('SELECT state FROM kira_public_push_outbox'))[0].state,'accepted');
        assert.equal(sent.length,2);assert.equal(sent[0].id,sent[1].id);assert.equal(sent[0].eventId,event.id);assert.equal(sent[0].environment,'sandbox');
        const payload=JSON.parse(genericPushPayload(event.id));assert.equal(payload.eventId,event.id);
        assert.equal(payload.aps.alert.body,'Новое уведомление Kira');
        assert.doesNotMatch(JSON.stringify(sent)+JSON.stringify(payload),/health|chat details/);
    });
});

test('account swap binds actual APNs token to current session; logout and unregistered response revoke binding', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const a=await store.create('synthetic_swap_a','disabled'),b=await store.create('synthetic_swap_b','disabled'),device=randomUUID();
        for(const row of [a,b])await db.query("INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$1,'google',$2)",[row.id,row.id]);
        const sessions=new PublicSessions(db,publicTestSecrets),inbox=new PublicInbox(db,publicTestSecrets);
        const first=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,device,'Synthetic phone'));
        const firstAuth=(await sessions.authenticate(first.accessToken))!;
        await inbox.bind(a.id,firstAuth.session,{version:1,deviceId:device,token:'cd'.repeat(32),environment:'production'});
        await inbox.append(a.id,'before-account-swap','account',{text:'Private old account'});
        const second=await db.transaction(tx=>sessions.issue(tx,b.id,b.id,device,'Synthetic phone'));
        assert.equal((await db.query('SELECT account_id FROM kira_public_push_devices'))[0].account_id,a.id,'a chosen UUID is not authority to delete another account binding');
        const secondAuth=(await sessions.authenticate(second.accessToken))!;
        await inbox.bind(b.id,secondAuth.session,{version:1,deviceId:device,token:'cd'.repeat(32),environment:'production'});
        await inbox.append(b.id,'after-account-swap','account',{text:'Private new account'});
        const sent:PushDelivery[]=[];
        await new PublicPushWorker(db,publicTestSecrets,{send:async delivery=>{sent.push(delivery);return 'unregistered';}}).drain();
        assert.equal(sent.length,1);assert.equal((await db.query('SELECT * FROM kira_public_push_devices')).length,0);
        assert.equal((await inbox.list(a.id,20)).events.length,1);assert.equal((await inbox.list(b.id,20)).events.length,1);
        await inbox.bind(b.id,secondAuth.session,{version:1,deviceId:device,token:'ef'.repeat(32),environment:'sandbox'});
        await sessions.logout(b.id,second.sessionId);
        assert.equal((await db.query('SELECT * FROM kira_public_push_devices')).length,0);
        await assert.rejects(()=>inbox.bind(b.id,secondAuth.session,{version:1,deviceId:device,token:'ef'.repeat(32),environment:'sandbox'}),(e:any)=>e.code==='unauthorized');
    });
});
