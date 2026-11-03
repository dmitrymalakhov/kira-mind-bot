import assert from 'node:assert/strict';
import test from 'node:test';
import { PublicAccountPolicy } from '../platform/publicAccounts/policy';
import { publicTestConfig, publicTestPort, withPublicRegistry } from './support/publicAccounts';

test('no outbound without exact current consent; revoke, unknown endpoint and new fallback recipient fail closed', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const a = await store.create('synthetic_policy', 'disabled');
        let config = publicTestConfig();
        const policy = new PublicAccountPolicy(db, () => config);
        const admission = { operationId: 'synthetic-operation', provider: 'openai', endpoint: 'https://synthetic.example.invalid/v1/chat/completions', image: false, background: false };
        await assert.rejects(() => policy.authorizeOutbound(a.id, admission), (e: any) => e.code === 'consent_required');
        assert.equal((await policy.quota(a.id)).ai.used, 0);
        await policy.setConsent(a.id, { version: 1, consentVersion: config.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
        await policy.authorizeOutbound(a.id, admission);
        await policy.authorizeOutbound(a.id, admission);
        assert.equal((await policy.quota(a.id)).ai.used, 1, 'internal retry is one user operation');
        await assert.rejects(() => policy.authorizeOutbound(a.id, { ...admission, endpoint: 'https://unknown.example.invalid/v1' }), (e: any) => e.code === 'consent_required');
        await policy.setConsent(a.id, { version: 1, consentVersion: 'previous-catalog', accepted: false, recipientIds: [] });
        await assert.rejects(() => policy.authorizeOutbound(a.id, admission), (e: any) => e.code === 'consent_required');
        await policy.setConsent(a.id, { version: 1, consentVersion: config.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
        config = { ...config, catalog: { ...config.catalog, version: 'synthetic-catalog-v2', recipients: [...config.catalog.recipients,
            { id: 'synthetic-fallback', name: 'Synthetic fallback', data: ['user content'], purposes: ['fallback'], policyUrl: 'https://synthetic.example.invalid/privacy' }] } };
        await assert.rejects(() => policy.authorizeOutbound(a.id, admission), (e: any) => e.code === 'consent_required');
        assert.equal((await policy.quota(a.id)).ai.used, 1);
        await assert.rejects(() => policy.setConsent(a.id, { version: 1, consentVersion: config.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] }), (e: any) => e.code === 'consent_required');
    });
});



test('separate image effects in one AI operation have distinct durable budgets, retries do not rebill and UTC day belongs to the image admission', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const account=await store.create('synthetic_image_effects','disabled'),config={...publicTestConfig(),imageLimit:1};
        let now=new Date('2035-04-01T23:59:59Z');
        const policy=new PublicAccountPolicy(db,()=>config,()=>now);
        await policy.setConsent(account.id,{version:1,consentVersion:config.catalog.version,accepted:true,recipientIds:['synthetic-ai']});
        const admission={operationId:'one-user-turn',provider:'openai',endpoint:'https://synthetic.example.invalid/v1/images/generations',image:true,background:false,imageOperationId:'first-image'};
        await policy.authorizeOutbound(account.id,admission);await policy.authorizeOutbound(account.id,admission);
        await assert.rejects(()=>policy.authorizeOutbound(account.id,{...admission,imageOperationId:'second-image'}),(e:any)=>e.code==='quota_exhausted');
        assert.equal((await policy.quota(account.id)).images.used,1);assert.equal((await policy.quota(account.id)).ai.used,1);
        now=new Date('2035-04-02T00:00:01Z');
        await policy.authorizeOutbound(account.id,admission);assert.equal((await policy.quota(account.id)).images.used,0,'old image retry keeps original day');
        await policy.authorizeOutbound(account.id,{...admission,imageOperationId:'second-image'});
        assert.equal((await policy.quota(account.id)).images.used,1);assert.equal((await policy.quota(account.id)).ai.used,0,'same AI turn is not rebilled at midnight');
    });
});

test('crashed preflight leases expire without refunds for committed sends; text cleanup cannot release another image effect', {skip:!publicTestPort},async()=>{
    await withPublicRegistry(async(db,store)=>{
        const account=await store.create('synthetic_quota_lease','disabled'),config=publicTestConfig();let now=new Date('2035-04-01T12:00:00Z');
        const policy=new PublicAccountPolicy(db,()=>config,()=>now);
        await policy.setConsent(account.id,{version:1,consentVersion:config.catalog.version,accepted:true,recipientIds:['synthetic-ai']});
        const admission={operationId:'leased-user-turn',provider:'openai',endpoint:'https://synthetic.example.invalid/v1/images/generations',image:true,background:false,imageOperationId:'leased-image',reserveOnly:true};
        await policy.authorizeOutbound(account.id,admission);
        await policy.authorizeOutbound(account.id,{...admission,image:false,reserveOnly:false});
        await policy.release(account.id,admission.operationId,false);
        assert.equal((await policy.quota(account.id)).images.reserved,1,'a completed text call preserves a parallel image reservation');
        now=new Date(now.getTime()+300_001);
        assert.equal((await policy.quota(account.id)).images.reserved,0);assert.equal((await policy.quota(account.id)).ai.used,1);
        await assert.rejects(()=>policy.authorizeOutbound(account.id,{...admission,reserveOnly:false}),(e:any)=>e.code==='operation_closed');
        await policy.reserve(account.id,'crashed-before-send');now=new Date(now.getTime()+300_001);
        assert.equal((await policy.quota(account.id)).ai.reserved,0);assert.equal((await policy.quota(account.id)).ai.used,1);
        await assert.rejects(()=>policy.authorizeOutbound(account.id,{...admission,operationId:'crashed-before-send',image:false,reserveOnly:false}),(e:any)=>e.code==='operation_closed');
    });
});

test('quota is atomic across accounts, processes and concurrent image/AI admissions; local release never refunds committed send', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const a = await store.create('synthetic_quota', 'disabled'), b = await store.create('synthetic_other_quota', 'disabled');
        const config = { ...publicTestConfig(), aiLimit: 2, imageLimit: 1 };
        const make = () => new PublicAccountPolicy(db, () => config);
        const policy = make();
        for (const id of [a.id, b.id]) await policy.setConsent(id, { version: 1, consentVersion: config.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
        const admission = { operationId: 'first', provider: 'openai', endpoint: 'https://synthetic.example.invalid/v1/responses', image: false, background: false };
        await policy.reserve(a.id, 'local-preflight');
        assert.equal((await policy.quota(a.id)).ai.reserved, 1);
        await make().release(a.id, 'local-preflight');
        assert.equal((await policy.quota(a.id)).ai.remaining, 2);
        const results = await Promise.allSettled(Array.from({ length: 10 }, (_, i) => make().authorizeOutbound(a.id, { ...admission, operationId: `concurrent-${i}`, image: true })));
        assert.equal(results.filter(r => r.status === 'fulfilled').length, 1);
        assert.deepEqual((await policy.quota(a.id)).images, { limit: 1, used: 1, reserved: 0, remaining: 0 });
        assert.equal((await policy.quota(a.id)).ai.used, 1, 'failed image admission cannot partially spend AI');
        await policy.authorizeOutbound(a.id, admission);
        await policy.release(a.id, admission.operationId);
        assert.deepEqual((await policy.quota(a.id)).ai, { limit: 2, used: 2, reserved: 0, remaining: 0 });
        await assert.rejects(() => make().authorizeOutbound(a.id, { ...admission, operationId: 'exhausted' }), (e: any) => e.code === 'quota_exhausted');
        await policy.authorizeOutbound(b.id, { ...admission, image: true });
        assert.equal((await policy.quota(b.id)).ai.remaining, 1);
    });
});

test('UTC rollover does not rebill a retried operation and account restriction/default autonomous off blocks background', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const a = await store.create('synthetic_rollover', 'disabled');
        const config = publicTestConfig();
        let now = new Date('2035-04-01T23:59:59Z');
        const policy = new PublicAccountPolicy(db, () => config, () => now);
        await policy.setConsent(a.id, { version: 1, consentVersion: config.catalog.version, accepted: true, recipientIds: ['synthetic-ai'] });
        const admission = { operationId: 'across-midnight', provider: 'openai', endpoint: 'https://synthetic.example.invalid/v1/embeddings', image: false, background: false };
        await policy.authorizeOutbound(a.id, admission);
        now = new Date('2035-04-02T00:00:01Z');
        await policy.authorizeOutbound(a.id, admission);
        assert.equal((await policy.quota(a.id)).ai.used, 0);
        assert.equal((await policy.quota(a.id)).resetAt, '2035-04-03T00:00:00.000Z');
        await db.query('UPDATE kira_accounts SET autonomous_ai_enabled=false WHERE id=$1', [a.id]);
        await assert.rejects(() => policy.authorizeOutbound(a.id, { ...admission, background: true }), (e: any) => e.code === 'autonomous_ai_disabled');
        await policy.restrict(a.id);
        await assert.rejects(() => policy.authorizeOutbound(a.id, admission), (e: any) => e.code === 'account_restricted');
        assert.equal((await policy.consent(a.id)).aiAllowed, true, 'consent alone is not account admission');
    });
});
