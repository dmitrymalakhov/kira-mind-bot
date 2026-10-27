-- For installations with KIRA_DATABASE_SYNC=false. Run as the database owner.
-- Grant the runtime DB role SELECT, INSERT, UPDATE, DELETE on this table after creation
-- when that role has no default privileges for newly created tables.
BEGIN;
CREATE TABLE IF NOT EXISTS dialogue_jobs (
    id uuid PRIMARY KEY,
    profile text NOT NULL,
    channel text NOT NULL,
    "turnId" text NOT NULL,
    "userId" bigint NOT NULL,
    "chatId" bigint NOT NULL,
    "messageId" bigint,
    input jsonb NOT NULL,
    status text NOT NULL,
    phase text NOT NULL,
    attempts integer NOT NULL DEFAULT 0,
    lease uuid,
    "lockedAt" timestamptz,
    announced boolean NOT NULL DEFAULT false,
    notice text,
    "resultText" text,
    error text,
    "createdAt" timestamptz NOT NULL DEFAULT now(),
    "expiresAt" timestamptz NOT NULL,
    "updatedAt" timestamptz NOT NULL DEFAULT now()
);
CREATE UNIQUE INDEX IF NOT EXISTS "IDX_dialogue_jobs_channel_turn" ON dialogue_jobs (profile, channel, "turnId");
CREATE INDEX IF NOT EXISTS "IDX_dialogue_jobs_pending" ON dialogue_jobs (profile, status, "createdAt");
COMMIT;
