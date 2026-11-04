import type { DataSource } from 'typeorm';

/** Operator-owned registry migration. Never runs against a tenant or recreates existing data. */
export async function initializePublicAccounts(db: DataSource): Promise<void> {
    await db.transaction(async tx => {
        await tx.query('SELECT pg_advisory_xact_lock(706283008)');
        await tx.query(`ALTER TABLE kira_accounts
            ADD COLUMN IF NOT EXISTS account_state text NOT NULL DEFAULT 'active',
            ADD COLUMN IF NOT EXISTS runtime_mode text NOT NULL DEFAULT 'telegram',
            ADD COLUMN IF NOT EXISTS runtime_principal bigint,
            ADD COLUMN IF NOT EXISTS public_origin boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS autonomous_ai_enabled boolean NOT NULL DEFAULT true`);
        await tx.query(`CREATE SEQUENCE IF NOT EXISTS kira_runtime_principals
            INCREMENT BY -1 MINVALUE -9007199254740991 MAXVALUE -1 START -1 NO CYCLE`);
        await tx.query(`CREATE UNIQUE INDEX IF NOT EXISTS kira_runtime_principal_unique
            ON kira_accounts(runtime_principal) WHERE runtime_principal IS NOT NULL`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_identities (
            id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE,
            provider text NOT NULL CHECK(provider IN ('apple','google','telegram','password')),
            subject text NOT NULL, credential_encrypted text, revoked_at timestamptz,
            linked_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz,
            UNIQUE(provider,subject)
        )`);
        await tx.query('ALTER TABLE kira_public_identities ADD COLUMN IF NOT EXISTS revocation_reason text');
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_security_events(event_hash text PRIMARY KEY,provider text NOT NULL,received_at timestamptz NOT NULL DEFAULT now())`);
        // Existing passwords remain an explicit access method; there is no public password signup.
        await tx.query(`INSERT INTO kira_public_identities(id,account_id,provider,subject)
            SELECT id,id,'password',id::text FROM kira_accounts
            WHERE password_hash <> '' AND password_hash <> 'disabled'
            ON CONFLICT(provider,subject) DO NOTHING`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_sessions (
            id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE,
            identity_id uuid NOT NULL REFERENCES kira_public_identities(id),
            device_id uuid NOT NULL, device_name text NOT NULL,
            access_hash text UNIQUE NOT NULL, access_expires_at timestamptz NOT NULL,
            refresh_expires_at timestamptz NOT NULL, generation int NOT NULL DEFAULT 0,
            revoked_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), last_used_at timestamptz NOT NULL DEFAULT now()
        )`);
        await tx.query(`CREATE INDEX IF NOT EXISTS kira_public_sessions_account ON kira_public_sessions(account_id)`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_refresh (
            token_hash text PRIMARY KEY, session_id uuid NOT NULL REFERENCES kira_public_sessions(id) ON DELETE CASCADE,
            generation int NOT NULL, replaced_at timestamptz, request_key_hash text, replay_encrypted text
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_challenges (
            id uuid PRIMARY KEY, provider text NOT NULL, purpose text NOT NULL, device_id uuid NOT NULL,
            account_id uuid REFERENCES kira_accounts(id) ON DELETE CASCADE, session_id uuid REFERENCES kira_public_sessions(id),
            challenge text NOT NULL, nonce text NOT NULL, state_hash text NOT NULL, code_challenge text,
            grant_hash text, expires_at timestamptz NOT NULL, consumed_at timestamptz,
            request_key_hash text, fingerprint text, result_encrypted text, result_generation int,
            created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_reauthentication (
            token_hash text PRIMARY KEY, account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE,
            session_id uuid NOT NULL REFERENCES kira_public_sessions(id) ON DELETE CASCADE,
            expires_at timestamptz NOT NULL, consumed_at timestamptz
        )`);
        await tx.query(`ALTER TABLE kira_public_challenges ADD COLUMN IF NOT EXISTS captcha_required boolean NOT NULL DEFAULT false,
            ADD COLUMN IF NOT EXISTS accepted_app_request_hash text`);
        // A Telegram PKCE grant belongs to exactly one original challenge even after
        // that challenge is consumed, expired or removed. No account/device/PII here.
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_pkce_bindings (
            challenge_hash text PRIMARY KEY,challenge_id uuid UNIQUE NOT NULL,created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await tx.query(`INSERT INTO kira_public_pkce_bindings(challenge_hash,challenge_id,created_at)
            SELECT DISTINCT ON (code_challenge) code_challenge,id,created_at FROM kira_public_challenges
            WHERE provider='telegram' AND code_challenge IS NOT NULL ORDER BY code_challenge,created_at,id ON CONFLICT DO NOTHING`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_app_keys (
            key_hash text PRIMARY KEY, device_id uuid NOT NULL, public_key text NOT NULL,
            environment text NOT NULL, sign_count bigint NOT NULL, created_at timestamptz NOT NULL DEFAULT now()
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_proof_tokens (
            token_hash text PRIMARY KEY, expires_at timestamptz NOT NULL
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_limits (
            scope_hash text PRIMARY KEY, count int NOT NULL, expires_at timestamptz NOT NULL
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_consents (
            account_id uuid PRIMARY KEY REFERENCES kira_accounts(id) ON DELETE CASCADE,
            catalog_version text NOT NULL, recipient_ids jsonb NOT NULL,
            accepted boolean NOT NULL, revision bigint NOT NULL DEFAULT 1, updated_at timestamptz NOT NULL DEFAULT now()
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_quota (
            account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE, day date NOT NULL,
            ai_used int NOT NULL DEFAULT 0 CHECK(ai_used >= 0), ai_reserved int NOT NULL DEFAULT 0 CHECK(ai_reserved >= 0),
            images_used int NOT NULL DEFAULT 0 CHECK(images_used >= 0), images_reserved int NOT NULL DEFAULT 0 CHECK(images_reserved >= 0),
            PRIMARY KEY(account_id,day)
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_ai_operations (
            account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE, operation_hash text NOT NULL,
            day date NOT NULL, ai_state text NOT NULL, image_state text NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,operation_hash)
        )`);
        await tx.query('ALTER TABLE kira_public_ai_operations ADD COLUMN IF NOT EXISTS lease_expires_at timestamptz');
        await tx.query(`UPDATE kira_public_ai_operations SET lease_expires_at=now()+interval '5 minutes' WHERE ai_state='reserved' AND lease_expires_at IS NULL`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_image_operations (
            account_id uuid NOT NULL, image_hash text NOT NULL, operation_hash text NOT NULL,
            day date NOT NULL,state text NOT NULL,lease_expires_at timestamptz,
            PRIMARY KEY(account_id,image_hash),FOREIGN KEY(account_id,operation_hash)
                REFERENCES kira_public_ai_operations(account_id,operation_hash) ON DELETE CASCADE
        )`);
        await tx.query(`INSERT INTO kira_public_image_operations(account_id,image_hash,operation_hash,day,state,lease_expires_at)
            SELECT account_id,operation_hash,operation_hash,day,image_state,CASE WHEN image_state='reserved' THEN now()+interval '5 minutes' ELSE NULL END
            FROM kira_public_ai_operations WHERE image_state<>'none' ON CONFLICT DO NOTHING`);
        await tx.query("UPDATE kira_public_ai_operations SET image_state='none' WHERE image_state<>'none'");
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_inbox (
            id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE,
            source_key text NOT NULL, kind text NOT NULL, content jsonb NOT NULL,
            created_at timestamptz NOT NULL DEFAULT now(), read_at timestamptz, UNIQUE(account_id,source_key)
        )`);
        await tx.query('ALTER TABLE kira_public_inbox ADD COLUMN IF NOT EXISTS message_seq bigserial');
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_push_devices (
            account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE, device_id uuid NOT NULL,
            session_id uuid NOT NULL REFERENCES kira_public_sessions(id) ON DELETE CASCADE,
            token_hash text UNIQUE NOT NULL, token_encrypted text NOT NULL, environment text NOT NULL,
            updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(account_id,device_id)
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_push_outbox (
            id uuid PRIMARY KEY, event_id uuid NOT NULL REFERENCES kira_public_inbox(id) ON DELETE CASCADE,
            session_id uuid NOT NULL REFERENCES kira_public_sessions(id), device_id uuid NOT NULL,
            state text NOT NULL DEFAULT 'pending', attempts int NOT NULL DEFAULT 0,
            next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz,
            UNIQUE(event_id,session_id,device_id)
        )`);
        await tx.query('ALTER TABLE kira_public_push_outbox ADD COLUMN IF NOT EXISTS lease_token uuid');
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_receipts (
            account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE, key_hash text NOT NULL,
            fingerprint text NOT NULL, status text NOT NULL, result jsonb, PRIMARY KEY(account_id,key_hash)
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_deletions (
            id uuid PRIMARY KEY, account_id uuid UNIQUE NOT NULL, state text NOT NULL DEFAULT 'pending',
            inventory_encrypted text NOT NULL, completed_steps jsonb NOT NULL DEFAULT '[]',
            requested_at timestamptz NOT NULL DEFAULT now(), deadline_at timestamptz NOT NULL DEFAULT now()+interval '24 hours',
            next_attempt_at timestamptz NOT NULL DEFAULT now(), lease_until timestamptz, attempts int NOT NULL DEFAULT 0
        )`);
        // The ledger deliberately has no FK/cascade to the data being erased or restored.
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_deletion_ledger (
            account_id uuid PRIMARY KEY, deletion_id uuid NOT NULL, blocked_at timestamptz NOT NULL DEFAULT now(), completed_at timestamptz
        )`);
        await tx.query('ALTER TABLE kira_public_deletions ADD COLUMN IF NOT EXISTS lease_token uuid');
        await tx.query('ALTER TABLE kira_public_deletions ADD COLUMN IF NOT EXISTS inventory_expires_at timestamptz');
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_complaints (
            id uuid PRIMARY KEY, account_id uuid NOT NULL REFERENCES kira_accounts(id) ON DELETE CASCADE,
            reply_id text NOT NULL, category text NOT NULL, details_encrypted text,
            status text NOT NULL DEFAULT 'received', created_at timestamptz NOT NULL DEFAULT now()
        )`);
        // Browser state contains device/CSRF binding and encrypted short-lived OAuth
        // code/PKCE only. Authentication remains in kira_public_sessions.
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_web_browsers (
            cookie_hash text PRIMARY KEY, device_id uuid NOT NULL, account_id uuid REFERENCES kira_accounts(id) ON DELETE CASCADE,
            session_id uuid REFERENCES kira_public_sessions(id) ON DELETE SET NULL,
            created_at timestamptz NOT NULL DEFAULT now(), expires_at timestamptz NOT NULL
        )`);
        await tx.query('ALTER TABLE kira_public_web_browsers ADD COLUMN IF NOT EXISTS session_id uuid REFERENCES kira_public_sessions(id) ON DELETE SET NULL');
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_web_flows (
            challenge_id uuid PRIMARY KEY REFERENCES kira_public_challenges(id) ON DELETE CASCADE,
            browser_hash text NOT NULL REFERENCES kira_public_web_browsers(cookie_hash) ON DELETE CASCADE,
            provider text NOT NULL CHECK(provider IN ('google','telegram','password')),
            purpose text NOT NULL CHECK(purpose IN ('login','reauthenticate','link')),
            private_encrypted text NOT NULL, callback_received boolean NOT NULL DEFAULT false,
            expires_at timestamptz NOT NULL
        )`);
        await tx.query(`CREATE TABLE IF NOT EXISTS kira_public_operator_grants (
            account_id uuid PRIMARY KEY REFERENCES kira_accounts(id) ON DELETE CASCADE,
            granted_by_session uuid REFERENCES kira_public_sessions(id) ON DELETE SET NULL,
            granted_at timestamptz NOT NULL DEFAULT now(), revoked_at timestamptz
        )`);
    });
}
