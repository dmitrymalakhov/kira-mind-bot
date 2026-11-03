import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { ProviderSecurityEvents } from '../platform/publicAccounts/securityEvents';
import { PublicSessions } from '../platform/publicAccounts/sessions';
import { loadJose } from '../platform/publicAccounts/cryptoModules';
import { publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

test('signed provider security events revoke only associated sessions, dedupe and ignore older events after fresh login', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const a=await store.create('synthetic_event_a','disabled'),b=await store.create('synthetic_event_b','disabled');
        const appleId=randomUUID();
        await db.query("INSERT INTO kira_public_identities(id,account_id,provider,subject) VALUES($1,$1,'google','synthetic-google-a'),($2,$2,'google','synthetic-google-b'),($3,$1,'apple','synthetic-apple-a')",[a.id,b.id,appleId]);
        const sessions=new PublicSessions(db,publicTestSecrets),device=randomUUID();
        const ga=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,device,'Synthetic phone'));
        const aa=await db.transaction(tx=>sessions.issue(tx,a.id,appleId,device,'Synthetic phone'));
        const gb=await db.transaction(tx=>sessions.issue(tx,b.id,b.id,randomUUID(),'Other phone'));
        const jose=await loadJose(),rsa=await jose.generateKeyPair('RS256',{extractable:true}),jwk=await jose.exportJWK(rsa.publicKey);jwk.kid='synthetic-event-key';
        const keys=jose.createLocalJWKSet({keys:[jwk]}),config=publicTestConfig(),now=new Date(),stamp=Math.floor(now.getTime()/1000);
        const events=new ProviderSecurityEvents(db,config,()=>now,{google:keys,apple:keys});
        const jwt=(provider:'google'|'apple',payload:Record<string,unknown>,extra:Record<string,unknown>={})=>new jose.SignJWT({iss:provider==='google'?'https://accounts.google.com':'https://appleid.apple.com',aud:config[provider].clientId,iat:stamp,jti:randomUUID(),events:payload,...extra})
            .setProtectedHeader({alg:'RS256',kid:jwk.kid}).sign(rsa.privateKey);
        const event={['https://schemas.openid.net/secevent/risc/event-type/sessions-revoked']:{subject:{subject_type:'iss-sub',iss:'https://accounts.google.com',sub:'synthetic-google-a'}}};
        await assert.rejects(()=>jwt('google',event,{aud:'wrong-audience'}).then(token=>events.receive('google',token)),(e:any)=>e.code==='invalid_provider_event');
        assert.ok(await sessions.authenticate(ga.accessToken));
        const signed=await jwt('google',event);await events.receive('google',signed);await events.receive('google',signed);
        assert.equal(await sessions.authenticate(ga.accessToken),undefined);assert.ok(await sessions.authenticate(aa.accessToken));assert.ok(await sessions.authenticate(gb.accessToken));
        assert.equal((await db.query('SELECT count(*) FROM kira_public_security_events'))[0].count,'1');
        await db.query('UPDATE kira_public_identities SET last_used_at=$2 WHERE id=$1',[a.id,new Date((stamp+1)*1000)]);
        const fresh=await db.transaction(tx=>sessions.issue(tx,a.id,a.id,device,'Synthetic phone'));
        await events.receive('google',await jwt('google',event,{jti:randomUUID(),iat:stamp-10}));assert.ok(await sessions.authenticate(fresh.accessToken));
        await events.receive('apple',await jwt('apple',{type:'email-disabled',sub:'synthetic-apple-a',event_time:stamp}));assert.ok(await sessions.authenticate(aa.accessToken),'Hide My Email forwarding is not login revocation');
        await events.receive('apple',await jwt('apple',{type:'consent-revoked',sub:'synthetic-apple-a',event_time:stamp}));assert.equal(await sessions.authenticate(aa.accessToken),undefined);
        assert.ok(await sessions.authenticate(gb.accessToken));
    });
});
