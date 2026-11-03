import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash,generateKeyPairSync,randomBytes,randomUUID,sign } from 'node:crypto';
import * as cbor from 'cbor';
import { PublicIdentities } from '../platform/publicAccounts/identities';
import { PublicSessions } from '../platform/publicAccounts/sessions';
import { PublicLimits } from '../platform/publicAccounts/limits';
import { OfficialAppProof,proofPayload } from '../platform/publicAccounts/proof';
import { digest } from '../platform/crypto';
import { loadPublicAccountConfig } from '../platform/publicAccounts/config';
import { publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry } from './support/publicAccounts';

test('risk CAPTCHA is explicit and retryable; valid App Attest is checked, malformed crypto never downgrades to CAPTCHA', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const config=publicTestConfig(),deviceId=randomUUID(),keyId=randomBytes(32).toString('base64'),keys=generateKeyPairSync('ec',{namedCurve:'prime256v1'});
        await db.query("INSERT INTO kira_public_app_keys(key_hash,device_id,public_key,environment,sign_count) VALUES($1,$2,$3,'production',0)",[digest(keyId),deviceId,keys.publicKey.export({type:'spki',format:'pem'})]);
        let providerCalls=0;
        const limits=new PublicLimits(db,'synthetic-risk-window-secret-32-chars');
        const identities=new PublicIdentities(db,store,publicTestSecrets,new PublicSessions(db,publicTestSecrets),config,
            {verify:async(provider)=>{providerCalls++;return {provider,subject:'synthetic-risk-subject'};},revokeApple:async()=>{}},
            new OfficialAppProof(db,config,async()=>new Response(JSON.stringify({success:true,hostname:config.captcha.hostname,challenge_ts:new Date().toISOString()}))),limits);
        const challenge=await identities.challenge({version:1,provider:'google',purpose:'login',deviceId},undefined,true);
        assert.deepEqual(challenge.proofRequirement,{mode:'hcaptcha',reason:'risk'});
        const plain={version:1 as const,challengeId:challenge.challengeId,state:challenge.state,deviceId,deviceName:'Synthetic phone',identityToken:'synthetic-subject-proof'};
        const assertion=(body:typeof plain,nonce:string,count:number)=>{
            const auth=Buffer.alloc(37);createHash('sha256').update(`${config.app.teamId}.${config.app.bundleId}`).digest().copy(auth);auth.writeUInt32BE(count,33);
            const nonceHash=createHash('sha256').update(Buffer.concat([auth,createHash('sha256').update(proofPayload('google',body,nonce)).digest()])).digest();
            return cbor.encode({authenticatorData:auth,signature:sign('sha256',nonceHash,keys.privateKey)}).toString('base64');
        };
        const body={...plain,proof:{type:'app_attest' as const,keyId,assertion:assertion(plain,challenge.challenge,1)}};
        for(let n=0;n<2;n++)await assert.rejects(()=>identities.authenticate('google',body,'synthetic-risk-login','192.0.2.1'),(e:any)=>{
            assert.equal(e.code,'captcha_required');assert.deepEqual(e.proofRequirement,{type:'hcaptcha',reason:'risk',challengeId:challenge.challengeId,
                siteKey:config.captcha.siteKey,baseUrl:config.captcha.baseUrl,hostname:config.captcha.hostname});return true;
        });
        assert.equal((await db.query('SELECT sign_count FROM kira_public_app_keys'))[0].sign_count,'1','receipt-only preflight replay does not reuse the assertion counter');
        assert.equal(providerCalls,0,'risk negotiation never exchanges provider code');
        const login=await identities.authenticate('google',{...plain,proof:{type:'hcaptcha',token:'synthetic-risk-human-token',reason:'risk'}},'synthetic-risk-login','192.0.2.1');
        assert.equal(login.kind,'login');assert.equal(providerCalls,1);
        const bad=await identities.challenge({version:1,provider:'google',purpose:'login',deviceId},undefined,true);
        const badBody={...plain,challengeId:bad.challengeId,state:bad.state,proof:{type:'app_attest',keyId,assertion:Buffer.from('invalid crypto').toString('base64')}};
        await assert.rejects(()=>identities.authenticate('google',badBody,'synthetic-invalid-crypto','192.0.2.1'),(e:any)=>e.code==='app_proof_invalid');
        await assert.rejects(()=>identities.authenticate('google',{...badBody,proof:{type:'hcaptcha',token:'synthetic-no-downgrade-token',reason:'risk'}},'synthetic-retry-as-human','192.0.2.1'),(e:any)=>e.code==='challenge_invalid');
        assert.equal(providerCalls,1);
        for(let n=0;n<10;n++)await limits.take('public-auth-ip:192.0.2.9',30,60);
        assert.equal(await new PublicLimits(db,'synthetic-risk-window-secret-32-chars').captchaRequired('public-auth-ip:192.0.2.9'),true,'risk survives process replacement');
    });
});

test('hCaptcha base URL is explicit HTTPS origin matching verified hostname, never inferred from arbitrary request headers',()=>{
    const config=loadPublicAccountConfig({KIRA_PUBLIC_HCAPTCHA_HOSTNAME:'captcha.example.invalid'});
    assert.equal(config.captcha.baseUrl,'https://captcha.example.invalid');
    assert.throws(()=>loadPublicAccountConfig({KIRA_PUBLIC_HCAPTCHA_HOSTNAME:'captcha.example.invalid',KIRA_PUBLIC_HCAPTCHA_BASE_URL:'https://other.example.invalid'}));
    assert.throws(()=>loadPublicAccountConfig({KIRA_PUBLIC_HCAPTCHA_HOSTNAME:'captcha.example.invalid',KIRA_PUBLIC_HCAPTCHA_BASE_URL:'https://captcha.example.invalid/path'}));
});
