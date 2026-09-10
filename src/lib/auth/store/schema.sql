-- TabDump account system — the smallest schema the auth system needs.
--
-- Additive and idempotent by design: every statement is IF NOT EXISTS, so
-- running this against an existing database creates what is missing and
-- touches nothing else. It never drops, never rewrites, and never resets.
-- Apply it with `npm run migrate:auth` (scripts/migrate-auth.mjs).
--
-- Tables are prefixed `tabdump_` so this can live in a database shared with
-- something else without colliding.

CREATE TABLE IF NOT EXISTS tabdump_users (
  id           UUID PRIMARY KEY,
  -- Google's `sub` claim. UNIQUE is the real guard against a duplicate
  -- account for the same Google identity: two concurrent first-time logins
  -- both reach the INSERT, and the constraint is what makes exactly one of
  -- them win (the other takes the ON CONFLICT path). Checking "does this
  -- user exist?" in application code first is not a substitute.
  google_sub   TEXT NOT NULL UNIQUE,
  -- Deliberately NOT unique and never used for lookup: a Google account's
  -- email can change, and a released address can later belong to someone
  -- else. Identity is `google_sub`; this is for display and support only.
  email        TEXT NOT NULL,
  name         TEXT NOT NULL,
  avatar_url   TEXT,
  -- Epoch milliseconds, matching how every other timestamp in this codebase
  -- is represented (Workspace.createdAt, Tab.addedAt, ...). BIGINT rather
  -- than TIMESTAMPTZ so there is no conversion layer to get wrong.
  created_at   BIGINT NOT NULL,
  updated_at   BIGINT NOT NULL
);

CREATE TABLE IF NOT EXISTS tabdump_sessions (
  id           UUID PRIMARY KEY,
  user_id      UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  -- SHA-256 of the raw token the browser holds. The raw token is never
  -- stored. UNIQUE both enforces that and gives the lookup below its index:
  -- every authenticated request is a single point read on this column.
  token_hash   TEXT NOT NULL UNIQUE,
  created_at   BIGINT NOT NULL,
  expires_at   BIGINT NOT NULL,
  last_used_at BIGINT NOT NULL
);

-- Sign-out-everywhere / account deletion delete by user.
CREATE INDEX IF NOT EXISTS tabdump_sessions_user_id_idx ON tabdump_sessions (user_id);
-- Expired-row housekeeping scans by expiry.
CREATE INDEX IF NOT EXISTS tabdump_sessions_expires_at_idx ON tabdump_sessions (expires_at);
