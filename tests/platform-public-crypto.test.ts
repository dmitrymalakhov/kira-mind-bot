import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign } from 'node:crypto';
import * as cbor from 'cbor';
import { loadJose } from '../platform/publicAccounts/cryptoModules';
import { OfficialIdentityVerifier } from '../platform/publicAccounts/providers';
import { OfficialAppProof, proofPayload } from '../platform/publicAccounts/proof';
import { publicAuthConfig, loadPublicAccountConfig } from '../platform/publicAccounts/config';
import { canonicalJson } from '../platform/publicAccounts/validation';
import { digest } from '../platform/crypto';
import { publicTestConfig, publicTestPort, withPublicRegistry } from './support/publicAccounts';

test('official JWT verification rejects forged/expired/wrong issuer/audience/nonce/algorithm and Apple exchanges/revokes its code', async () => {
    const jose = await loadJose();
    const rsa = await jose.generateKeyPair('RS256', { extractable: true });
    const ec = await jose.generateKeyPair('ES256', { extractable: true });
    const jwk = await jose.exportJWK(rsa.publicKey); jwk.kid = 'synthetic-kid'; jwk.alg = 'RS256';
    const keys = jose.createLocalJWKSet({ keys: [jwk] });
    const config = publicTestConfig(); config.apple.privateKey = await jose.exportPKCS8(ec.privateKey);
    const now = new Date('2035-04-01T00:00:00Z'), stamp = now.getTime() / 1000;
    const c = { nonce: 'synthetic-nonce', code_challenge: null, created_at: now };
    const token = (extra: Record<string, unknown> = {}) => new jose.SignJWT({ sub: 'synthetic-subject', email:'synthetic-ignored@example.invalid',name:'Synthetic ignored name',picture:'https://synthetic.example.invalid/ignored-picture',iss: 'https://accounts.google.com',
        aud: config.google.clientId, nonce: c.nonce, iat: stamp, exp: stamp + 300, ...extra }).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-kid' }).sign(rsa.privateKey);
    const calls: { url: string; body: URLSearchParams }[] = [];
    let exchanged = '';
    const verifier = new OfficialIdentityVerifier(config, async (url, options) => {
        const body = new URLSearchParams(String(options?.body)); calls.push({ url: String(url), body });
        await jose.jwtVerify(body.get('client_secret')!, ec.publicKey, { issuer: config.apple.teamId, audience: 'https://appleid.apple.com', subject: config.apple.clientId, currentDate: now });
        return new Response(String(url).endsWith('/revoke') ? '' : JSON.stringify({ id_token: exchanged, refresh_token: 'synthetic-apple-revocation-token' }), { status: 200 });
    }, () => now, { google: keys, apple: keys, telegram: keys });
    assert.equal((await verifier.verifyJwt('google', await token(), c)).sub, 'synthetic-subject');
    assert.deepEqual(await verifier.verify('google',{version:1,challengeId:randomUUID(),state:'synthetic',deviceId:randomUUID(),deviceName:'Synthetic',identityToken:await token(),proof:{type:'hcaptcha',token:'synthetic',reason:'unsupported'}},c),
        {provider:'google',subject:'synthetic-subject'},'profile claims never leave the verified provider boundary');
    for (const bad of [{ aud: 'wrong-audience' }, { iss: 'https://evil.example.invalid' }, { nonce: 'wrong-nonce' }, { exp: stamp - 10 }, { iat: stamp - 400 }, { azp: 'wrong-client' }]) {
        await assert.rejects(() => token(bad).then(jwt => verifier.verifyJwt('google', jwt, c)), (e: any) => e.code === 'invalid_provider_proof');
    }
    const forged = (await token()).split('.'); forged[2] = randomBytes(256).toString('base64url');
    await assert.rejects(() => verifier.verifyJwt('google', forged.join('.'), c), (e: any) => e.code === 'invalid_provider_proof');
    const hs = await new jose.SignJWT({sub:'synthetic',iss:'https://accounts.google.com',aud:config.google.clientId,nonce:c.nonce,iat:stamp,exp:stamp+300})
        .setProtectedHeader({alg:'HS256'}).sign(randomBytes(32));
    await assert.rejects(() => verifier.verifyJwt('google', hs, c), (e: any) => e.code === 'invalid_provider_proof');
    const apple = await token({ iss: 'https://appleid.apple.com', aud: config.apple.clientId }); exchanged = apple;
    const result = await verifier.verify('apple', { version:1,challengeId:randomUUID(),state:'synthetic',deviceId:randomUUID(),deviceName:'Synthetic',identityToken:apple,
        authorizationCode:'synthetic-apple-code',proof:{type:'hcaptcha',token:'synthetic',reason:'unsupported'} }, c);
    assert.equal(result.revocationToken, 'synthetic-apple-revocation-token');
    assert.equal(calls[0].url, 'https://appleid.apple.com/auth/token');
    assert.equal(calls[0].body.get('code'), 'synthetic-apple-code');
    await verifier.revokeApple(result.revocationToken!, config.apple.clientId);
    assert.equal(calls[1].url, 'https://appleid.apple.com/auth/revoke');
    assert.equal(calls[1].body.get('token_type_hint'), 'refresh_token');
});

test('official Telegram token exchange is fixed-endpoint Basic auth + S256, and mismatching PKCE never exchanges', async () => {
    const jose = await loadJose(), config = publicTestConfig();
    const pair = await jose.generateKeyPair('RS256', { extractable:true });
    const jwk = await jose.exportJWK(pair.publicKey); jwk.kid = 'synthetic';
    const verifierText = 'a'.repeat(64), nonce = 'synthetic-nonce', now = new Date();
    const jwt = await new jose.SignJWT({sub:'synthetic-telegram-sub',nonce}).setProtectedHeader({alg:'RS256',kid:'synthetic'})
        .setIssuer('https://oauth.telegram.org').setAudience(config.telegram.clientId).setIssuedAt().setExpirationTime('5m').sign(pair.privateKey);
    let sends = 0;
    const verifier = new OfficialIdentityVerifier(config, async (url, options) => {
        sends++; assert.equal(url, 'https://oauth.telegram.org/token');
        assert.equal((options!.headers as Record<string,string>).authorization, 'Basic ' + Buffer.from(`${config.telegram.clientId}:${config.telegram.clientSecret}`).toString('base64'));
        const body = new URLSearchParams(String(options!.body));
        assert.equal(body.get('redirect_uri'), config.telegram.redirectUri); assert.equal(body.get('code_verifier'), verifierText);
        return new Response(JSON.stringify({id_token:jwt}));
    }, () => now, {telegram:jose.createLocalJWKSet({keys:[jwk]})});
    const c = {nonce,created_at:now,code_challenge:createHash('sha256').update(verifierText).digest('base64url')};
    const body = {version:1 as const,challengeId:randomUUID(),state:'synthetic',deviceId:randomUUID(),deviceName:'Synthetic',authorizationCode:'synthetic-code',codeVerifier:verifierText,
        proof:{type:'hcaptcha' as const,token:'synthetic',reason:'unsupported' as const}};
    await assert.rejects(() => verifier.verify('telegram',{...body,codeVerifier:'b'.repeat(64)},c), (e:any) => e.code === 'invalid_provider_proof');
    assert.equal(sends,0);
    assert.equal((await verifier.verify('telegram',body,c)).subject,'synthetic-telegram-sub'); assert.equal(sends,1);
});

test('real App Attest assertion crypto checks payload/app/device/counter and invalid evidence never falls back to CAPTCHA', {skip:!publicTestPort}, async () => {
    await withPublicRegistry(async db => {
        const config = publicTestConfig(), device = randomUUID(), keyId = randomBytes(32).toString('base64');
        const keys = generateKeyPairSync('ec',{namedCurve:'prime256v1'});
        await db.query(`INSERT INTO kira_public_app_keys(key_hash,device_id,public_key,environment,sign_count) VALUES($1,$2,$3,'production',0)`,
            [digest(keyId),device,keys.publicKey.export({type:'spki',format:'pem'})]);
        let captchaSends = 0;
        const verifier = new OfficialAppProof(db,config,async () => {captchaSends++;throw Error('No downgrade');});
        const payload = 'synthetic-bound-request';
        const assertion = (count:number) => {
            const auth = Buffer.alloc(37); createHash('sha256').update(`${config.app.teamId}.${config.app.bundleId}`).digest().copy(auth); auth.writeUInt32BE(count,33);
            const nonce = createHash('sha256').update(Buffer.concat([auth,createHash('sha256').update(payload).digest()])).digest();
            return cbor.encode({authenticatorData:auth,signature:sign('sha256',nonce,keys.privateKey)}).toString('base64');
        };
        const proof = {type:'app_attest' as const,keyId,assertion:assertion(1)};
        await assert.rejects(() => verifier.verify({...proof,keyId:randomBytes(32).toString('base64')},device,'synthetic-challenge',payload,'192.0.2.1'),(e:any) => e.code === 'app_attest_key_unknown');
        await verifier.verify(proof,device,'synthetic-challenge',payload,'192.0.2.1');
        await assert.rejects(() => verifier.verify(proof,device,'synthetic-challenge',payload,'192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
        await assert.rejects(() => verifier.verify({...proof,assertion:assertion(2)},device,'synthetic-challenge','tampered-payload','192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
        await assert.rejects(() => verifier.verify({...proof,assertion:assertion(2)},randomUUID(),'synthetic-challenge',payload,'192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
        await assert.rejects(() => verifier.verify({...proof,keyId:randomBytes(32).toString('base64'),attestation:Buffer.from('invalid-cert').toString('base64')},device,'synthetic-challenge',payload,'192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
        assert.equal(captchaSends,0);
        await verifier.verify({...proof,assertion:assertion(2)},device,'synthetic-challenge',payload,'192.0.2.1');
        const development = new OfficialAppProof(db,{...config,app:{...config.app,environment:'development'}},async()=>{captchaSends++;throw Error('No downgrade');});
        await assert.rejects(() => development.verify({...proof,assertion:assertion(3)},device,'synthetic-challenge',payload,'192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
        assert.equal((await db.query('SELECT sign_count FROM kira_public_app_keys WHERE key_hash=$1',[digest(keyId)]))[0].sign_count,'2','environment mismatch never resets an existing counter');
        assert.equal(captchaSends,0);
    });
});

test('selected provider readiness is independent, Apple can be disabled and push is optional; all core/proof/release gates remain enforced', () => {
    const config = publicTestConfig();
    config.enabledProviders=['google','telegram'];config.apple={clientId:'',teamId:'',keyId:'',privateKey:''};config.readyCapabilities!.push=false;
    const view=publicAuthConfig(config);
    assert.equal(view.publicRegistration,true);assert.equal(view.capabilities.push,false);
    assert.deepEqual(view.providers.map(p=>[p.provider,p.available,p.reason]),[['apple',false,'disabled'],['google',true,undefined],['telegram',true,undefined]]);
    config.telegram.clientSecret='';
    assert.equal(publicAuthConfig(config).providers.find(p=>p.provider==='google')!.available,true);
    assert.equal(publicAuthConfig(config).providers.find(p=>p.provider==='telegram')!.reason,'not_configured');
    for(const mutate of [
        (c:typeof config)=>{c.releaseReady=false;},
        (c:typeof config)=>{c.enabled=false;},
        (c:typeof config)=>{c.readyCapabilities!.deletion=false;},
        (c:typeof config)=>{c.captcha.secret='';},
        (c:typeof config)=>{c.catalog.recipients=[];},
    ]) {const copy=structuredClone(config);mutate(copy);assert.equal(publicAuthConfig(copy).publicRegistration,false);}
    assert.deepEqual(loadPublicAccountConfig({KIRA_PUBLIC_IDENTITY_PROVIDERS:'google,telegram'}).enabledProviders,['google','telegram']);
    assert.deepEqual(loadPublicAccountConfig({}).enabledProviders,['apple','google','telegram']);
    assert.throws(()=>loadPublicAccountConfig({KIRA_PUBLIC_IDENTITY_PROVIDERS:'google,unknown'}));
    assert.throws(()=>loadPublicAccountConfig({KIRA_PUBLIC_IDENTITY_PROVIDERS:'google,google'}));
    assert.equal(view.proof.appAttestAppId,`${config.app.teamId}.${config.app.bundleId}`);
});

test('CAPTCHA verifies expected sitekey/hostname with durable anti-replay and never acts as an auth/rate bypass', {skip:!publicTestPort}, async () => {
    await withPublicRegistry(async db => {
        const config = publicTestConfig(), now = new Date(); let hostname = config.captcha.hostname;
        const verifier = new OfficialAppProof(db,config,async (url,options) => {
            assert.equal(url,'https://api.hcaptcha.com/siteverify');
            const body = new URLSearchParams(String(options!.body)); assert.equal(body.get('sitekey'),config.captcha.siteKey);assert.equal(body.get('remoteip'),'192.0.2.1');
            return new Response(JSON.stringify({success:true,hostname,challenge_ts:now.toISOString()}));
        },()=>now);
        const proof = {type:'hcaptcha' as const,token:'synthetic-captcha-token',reason:'unsupported' as const};
        await verifier.verify(proof,randomUUID(),'synthetic-challenge','synthetic-payload','192.0.2.1');
        await assert.rejects(() => verifier.verify(proof,randomUUID(),'synthetic-challenge','synthetic-payload','192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
        hostname = 'wrong.example.invalid';
        await assert.rejects(() => verifier.verify({...proof,token:'another-synthetic-token'},randomUUID(),'synthetic-challenge','synthetic-payload','192.0.2.1'),(e:any) => e.code === 'app_proof_invalid');
    });
});

test('public config contains no provider secrets, defaults closed; proof and receipt canonicalization bind meaningful input', () => {
    const config = publicTestConfig(), view = publicAuthConfig(config);
    const publicJson = JSON.stringify(view);
    for (const secret of [config.apple.privateKey,config.telegram.clientSecret,config.captcha.secret]) assert.equal(publicJson.includes(secret),false);
    assert.equal(publicAuthConfig(loadPublicAccountConfig({})).publicRegistration,false);
    assert.equal(canonicalJson({b:2,a:{d:4,c:3}}),canonicalJson({a:{c:3,d:4},b:2}));
    const input = {version:1 as const,challengeId:randomUUID(),state:'synthetic-state',deviceId:randomUUID(),deviceName:'Synthetic',identityToken:'synthetic-token'};
    assert.notEqual(proofPayload('google',input,'synthetic-challenge'),proofPayload('google',{...input,identityToken:'changed-token'},'synthetic-challenge'));
    assert.equal(proofPayload('google',input,'synthetic-challenge').split('\n').length,10);
});

test('published deterministic App Attest fixture hashes the received UTF8 challenge and exact ten-line payload',()=>{
    const fixture=JSON.parse(readFileSync(path.join(__dirname,'../docs/public-accounts-v1.examples.json'),'utf8')).hashFixture;
    assert.equal(digest(fixture.challenge),fixture.attestationClientDataHashHex);
    assert.notEqual(createHash('sha256').update(Buffer.from(fixture.challenge,'base64url')).digest('hex'),fixture.attestationClientDataHashHex);
    const payload=proofPayload(fixture.provider,fixture.input,fixture.challenge);
    assert.equal(payload,fixture.proofPayloadUtf8);assert.equal(payload.endsWith('\n'),false);
    assert.equal(digest(payload),fixture.assertionClientDataHashHex);
});
