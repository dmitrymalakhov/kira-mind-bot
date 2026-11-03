import assert from 'node:assert/strict';
import test from 'node:test';
import { randomUUID } from 'node:crypto';
import { PublicIdentities } from '../platform/publicAccounts/identities';
import { PublicSessions } from '../platform/publicAccounts/sessions';
import { PublicLimits } from '../platform/publicAccounts/limits';
import { publicTestConfig, publicTestPort, publicTestSecrets, withPublicRegistry } from './support/publicAccounts';

test('one identity creates one lightweight UUID account concurrently; retries cannot replay changed/stale challenges', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const config = publicTestConfig(), sessions = new PublicSessions(db, publicTestSecrets);
        const identities = new PublicIdentities(db, store, publicTestSecrets, sessions, config,
            { verify: async (provider, input) => ({ provider, subject: input.identityToken! }), revokeApple: async () => {} },
            { verify: async () => {} }, new PublicLimits(db, 'synthetic-public-rate-limit-secret-32'));
        const login = async (subject: string, key: string) => {
            const deviceId = randomUUID();
            const c = await identities.challenge({ version: 1, provider: 'google', purpose: 'login', deviceId });
            const body = { version: 1, challengeId: c.challengeId, state: c.state, deviceId, deviceName: 'Synthetic phone',
                identityToken: subject, proof: { type: 'hcaptcha', token: 'synthetic-double-only', reason: 'unsupported' } };
            return { body, result: await identities.authenticate('google', body, key, '192.0.2.1') };
        };
        const [one, two] = await Promise.all([login('synthetic-subject-one', 'signup-one'), login('synthetic-subject-one', 'signup-two')]);
        assert.equal(one.result.kind, 'login'); assert.equal(two.result.kind, 'login');
        if (one.result.kind !== 'login' || two.result.kind !== 'login') throw Error('Expected login');
        assert.equal(one.result.accountId, two.result.accountId);
        assert.match(one.result.accountId, /^[0-9a-f-]{36}$/);
        const account = (await db.query('SELECT * FROM kira_accounts WHERE id=$1', [one.result.accountId]))[0];
        assert.equal(account.runtime_mode, 'api_only'); assert.equal(account.account_state, 'registered');
        assert.equal(account.owner_id, null); assert.equal(account.secrets, null);
        assert.ok(Number(account.runtime_principal) < 0); assert.equal(account.autonomous_ai_enabled, false);
        assert.equal((await db.query('SELECT count(*) FROM kira_accounts'))[0].count, '1');
        assert.deepEqual(await identities.authenticate('google', one.body, 'signup-one', '192.0.2.1'), one.result);
        await assert.rejects(() => identities.authenticate('google', { ...one.body, deviceName: 'Changed' }, 'signup-one', '192.0.2.1'), (e: any) => e.code === 'idempotency_conflict');
        await assert.rejects(() => identities.authenticate('google', one.body, 'another-key', '192.0.2.1'), (e: any) => e.code === 'challenge_invalid');
        const other = await login('synthetic-subject-two', 'signup-other');
        assert.equal(other.result.kind, 'login');
        if (other.result.kind === 'login') assert.notEqual(other.result.accountId, one.result.accountId, 'profile/email never merges identities');
        const invalid = { ...one.body, challengeId: randomUUID(), accountId: one.result.accountId };
        await assert.rejects(() => identities.authenticate('google', invalid, 'invalid-key', '192.0.2.1'), (e: any) => e.code === 'invalid_body');
    });
});

test('link requires fresh proof of current identity, conflict preserves owner, and last method cannot be removed', { skip: !publicTestPort }, async () => {
    await withPublicRegistry(async (db, store) => {
        const config = publicTestConfig(), sessions = new PublicSessions(db, publicTestSecrets);
        const identities = new PublicIdentities(db, store, publicTestSecrets, sessions, config,
            { verify: async (provider, input) => ({ provider, subject: input.identityToken! }), revokeApple: async () => {} },
            { verify: async () => {} }, new PublicLimits(db, 'synthetic-public-rate-limit-secret-32'));
        const deviceId = randomUUID();
        async function proof(provider: 'google' | 'apple', purpose: 'login' | 'reauthenticate' | 'link', subject: string, auth?: any, grant?: string) {
            const c = await identities.challenge({ version: 1, provider, purpose, deviceId, ...(grant ? { reauthenticationToken: grant } : {}) }, auth);
            return identities.authenticate(provider, { version: 1, challengeId: c.challengeId, state: c.state, deviceId, deviceName: 'Synthetic phone',
                identityToken: subject, ...(provider === 'apple' ? { authorizationCode: 'synthetic-code' } : {}), proof: { type: 'hcaptcha', token: 'synthetic-double-only', reason: 'unsupported' } }, randomUUID(), '192.0.2.1', auth);
        }
        const login = await proof('google', 'login', 'synthetic-owner-subject');
        if (login.kind !== 'login') throw Error('Expected login');
        const auth = (await sessions.authenticate(login.pair.accessToken))!;
        const [last] = await identities.list(auth.account.id);
        await assert.rejects(() => identities.unlink(auth, last.id, 'synthetic-invalid-grant'), (e: any) => e.code === 'last_identity');
        await assert.rejects(() => identities.challenge({ version: 1, provider: 'apple', purpose: 'link', deviceId, reauthenticationToken: 'synthetic-invalid-grant-32-chars-long' }, auth), (e: any) => e.code === 'reauthentication_required');
        await assert.rejects(() => proof('google', 'reauthenticate', 'wrong-current-subject', auth), (e: any) => e.code === 'invalid_credentials');
        const fresh = await proof('google', 'reauthenticate', 'synthetic-owner-subject', auth);
        if (fresh.kind !== 'reauthenticate') throw Error('Expected reauth');
        const linked = await proof('apple', 'link', 'synthetic-apple-subject', auth, fresh.result.reauthenticationToken);
        assert.equal(linked.kind, 'link'); assert.equal((await identities.list(auth.account.id)).length, 2);
        await assert.rejects(() => identities.challenge({ version: 1, provider: 'apple', purpose: 'link', deviceId, reauthenticationToken: fresh.result.reauthenticationToken }, auth), (e: any) => e.code === 'reauthentication_required');
        const other = await proof('google', 'login', 'synthetic-other-subject');
        if (other.kind !== 'login') throw Error('Expected login');
        const otherAuth = (await sessions.authenticate(other.pair.accessToken))!;
        const grant = await proof('google', 'reauthenticate', 'synthetic-other-subject', otherAuth);
        if (grant.kind !== 'reauthenticate') throw Error('Expected grant');
        await assert.rejects(() => proof('apple', 'link', 'synthetic-apple-subject', otherAuth, grant.result.reauthenticationToken), (e: any) => e.code === 'identity_conflict');
        assert.equal((await identities.list(auth.account.id)).length, 2);
        assert.equal((await identities.list(otherAuth.account.id)).length, 1);
    });
});
