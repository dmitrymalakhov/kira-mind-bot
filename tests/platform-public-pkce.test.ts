import assert from 'node:assert/strict';
import test from 'node:test';
import {createHash,randomBytes,randomUUID} from 'node:crypto';
import {PublicIdentities} from '../platform/publicAccounts/identities';
import {PublicSessions} from '../platform/publicAccounts/sessions';
import {PublicLimits} from '../platform/publicAccounts/limits';
import {OfficialIdentityVerifier} from '../platform/publicAccounts/providers';
import {OfficialAppProof} from '../platform/publicAccounts/proof';
import {loadJose} from '../platform/publicAccounts/cryptoModules';
import {initializePublicAccounts} from '../platform/publicAccounts/schema';
import {publicTestConfig,publicTestPort,publicTestSecrets,withPublicRegistry} from './support/publicAccounts';

test('Telegram grant cannot cross challenges after unknown App Attest key, even without provider nonce; PKCE binding survives deletion/restart and spans devices/purposes', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const config=publicTestConfig(),jose=await loadJose(),key=await jose.generateKeyPair('RS256',{extractable:true});
        const jwk=await jose.exportJWK(key.publicKey);jwk.kid='synthetic-pkce-key';
        const jwt=await new jose.SignJWT({sub:'synthetic-pkce-subject'}).setProtectedHeader({alg:'RS256',kid:jwk.kid})
            .setIssuer('https://oauth.telegram.org').setAudience(config.telegram.clientId).setIssuedAt().setExpirationTime('5m').sign(key.privateKey);
        const sessions=new PublicSessions(db,publicTestSecrets),deviceId=randomUUID();let exchanges=0;
        const verifier=new OfficialIdentityVerifier(config,async(_url,options)=>{
            exchanges++;const sent=new URLSearchParams(String(options!.body));
            assert.equal(sent.get('code'),'synthetic-new-provider-code');assert.equal(sent.get('code_verifier'),'c'.repeat(64));
            return new Response(JSON.stringify({id_token:jwt}));
        },()=>new Date(),{telegram:jose.createLocalJWKSet({keys:[jwk]})});
        const make=()=>new PublicIdentities(db,store,publicTestSecrets,sessions,config,verifier,
            new OfficialAppProof(db,config,async()=>new Response(JSON.stringify({success:true,hostname:config.captcha.hostname,challenge_ts:new Date().toISOString()}))),
            new PublicLimits(db,'synthetic-pkce-window-key-0000000000000000'));
        const challengeInput=(verifier:string,device=deviceId,purpose='login')=>({version:1,provider:'telegram',purpose,deviceId:device,
            codeChallenge:createHash('sha256').update(verifier).digest('base64url'),codeChallengeMethod:'S256'});
        const identities=make(),oldVerifier='a'.repeat(64),first=await identities.challenge(challengeInput(oldVerifier));
        const body={version:1,challengeId:first.challengeId,state:first.state,deviceId,deviceName:'Synthetic phone',authorizationCode:'synthetic-old-provider-code',codeVerifier:oldVerifier,
            proof:{type:'app_attest',keyId:randomBytes(32).toString('base64'),assertion:Buffer.from('synthetic unknown assertion').toString('base64')}};
        await assert.rejects(()=>identities.authenticate('telegram',body,'synthetic-old-pkce-key','192.0.2.1'),(e:any)=>e.code==='app_attest_key_unknown');
        assert.equal(exchanges,0);assert.equal((await db.query('SELECT count(*) FROM kira_public_sessions'))[0].count,'0');
        await assert.rejects(()=>identities.challenge(challengeInput(oldVerifier)),(e:any)=>e.code==='pkce_reused');
        await assert.rejects(()=>identities.challenge(challengeInput(oldVerifier,randomUUID())),(e:any)=>e.code==='pkce_reused');
        await db.query('DELETE FROM kira_public_challenges WHERE id=$1',[first.challengeId]);await initializePublicAccounts(db);
        await assert.rejects(()=>make().challenge(challengeInput(oldVerifier)),(e:any)=>e.code==='pkce_reused','challenge removal/restart never detaches the old provider grant');
        const second=await identities.challenge(challengeInput('b'.repeat(64)));
        const captcha=(token:string)=>({type:'hcaptcha',token,reason:'unsupported'});
        await assert.rejects(()=>identities.authenticate('telegram',{...body,challengeId:second.challengeId,state:second.state,proof:captcha('synthetic-old-grant-human')},'synthetic-old-grant-new-state','192.0.2.1'),(e:any)=>e.code==='invalid_provider_proof');
        assert.equal(exchanges,0,'old verifier cannot exchange under a fresh PKCE');
        const fresh=await identities.challenge(challengeInput('c'.repeat(64)));
        const good={...body,challengeId:fresh.challengeId,state:fresh.state,authorizationCode:'synthetic-new-provider-code',codeVerifier:'c'.repeat(64),proof:captcha('synthetic-new-grant-human')};
        const login=await identities.authenticate('telegram',good,'synthetic-legitimate-pkce','192.0.2.1');assert.equal(login.kind,'login');
        assert.deepEqual(await identities.authenticate('telegram',good,'synthetic-legitimate-pkce','192.0.2.1'),login);assert.equal(exchanges,1);
        if(login.kind!=='login')throw Error('Expected login');const auth=await sessions.authenticate(login.pair.accessToken);assert.ok(auth);
        await assert.rejects(()=>make().challenge(challengeInput(oldVerifier,deviceId,'reauthenticate'),auth),(e:any)=>e.code==='pkce_reused');
    });
});
