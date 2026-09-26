-- Hubble provider connections — user-owned provider credentials (BYOC).
--
-- Additive and idempotent, exactly like src/lib/auth/store/schema.sql and
-- src/lib/agents/remote/schema.sql: every statement is IF NOT EXISTS, so
-- running this against an existing database creates what is missing and
-- touches nothing else. Apply it with `npm run migrate:credentials`
-- (scripts/migrate-credentials.mjs).
--
-- Two tables, and the split between them is the security design rather than
-- normalization for its own sake. The connection table is read constantly —
-- to render settings, to decide whether a session may start, to list what a
-- user has. The secret table is read by exactly one function in the whole
-- application, at the moment a runtime starts. Keeping them apart is what
-- stops a routine `SELECT *` from pulling a credential into a log line.

CREATE TABLE IF NOT EXISTS tabdump_provider_connections (
  -- Opaque and server-minted. The ONLY identifier the browser ever sees.
  id                 TEXT PRIMARY KEY,
  -- The runtime actor id, e.g. 'account:<uuid>'. TEXT rather than a FK to
  -- tabdump_users for the same reason the remote tables use TEXT: a purely
  -- local Hubble has no accounts and still needs this to typecheck against
  -- the same code.
  owner_id           TEXT NOT NULL,
  -- 'claude-code' | 'openai-codex' | 'gemini' | 'grok' | 'custom'. Stored as
  -- text; a value this build does not recognise is dropped on read rather
  -- than coerced, so a downgrade cannot make an unknown provider runnable.
  provider           TEXT NOT NULL,
  -- 'api_key' | 'workload_identity' | 'official_oauth'. NOT assumed uniform
  -- across providers — see src/lib/agents/credentials/types.ts.
  auth_method        TEXT NOT NULL,
  -- The user's own label. Free text, length-capped and control-character
  -- stripped before it arrives. Never the credential, never a prefix of one.
  display_name       TEXT NOT NULL,
  -- 'connected' | 'invalid' | 'unverified' | 'revoked'. Only 'connected'
  -- may start a session.
  status             TEXT NOT NULL,
  -- Epoch milliseconds, matching every other timestamp in this codebase.
  created_at         BIGINT NOT NULL,
  updated_at         BIGINT NOT NULL,
  -- When the provider last confirmed the credential. NULL if it never has.
  last_validated_at  BIGINT,
  -- Why the last validation failed, from a closed set. Never a provider's
  -- own error text: that string is the easiest route by which a key echoed
  -- back by an API reaches a screen.
  last_failure_code  TEXT
);

-- Every read is owner-scoped, and the owner is part of the predicate rather
-- than a check after the fact. This index is what makes that free.
CREATE INDEX IF NOT EXISTS tabdump_provider_connections_owner_idx
  ON tabdump_provider_connections (owner_id, created_at DESC);

-- One connection per provider per user. Enforced by the database rather than
-- only by the service, so a concurrent double-connect cannot leave a user
-- with two Claude connections and an unanswerable "which one runs?".
CREATE UNIQUE INDEX IF NOT EXISTS tabdump_provider_connections_owner_provider_idx
  ON tabdump_provider_connections (owner_id, provider);

CREATE TABLE IF NOT EXISTS tabdump_provider_secrets (
  -- Shares the connection's id and cascades from it. The cascade is §22's
  -- "deleting a connection must not leave an orphaned secret", enforced by
  -- the database: even a delete that bypasses the service entirely — a
  -- manual cleanup, an account deletion — takes the secret with it.
  connection_id  TEXT PRIMARY KEY
                   REFERENCES tabdump_provider_connections(id) ON DELETE CASCADE,
  -- Denormalized deliberately. Every read of this table is scoped by owner in
  -- its own WHERE clause rather than by joining to the connection, so a
  -- cross-account read is impossible even if the join were ever written wrong.
  owner_id       TEXT NOT NULL,
  -- AES-256-GCM. Three opaque base64 components plus a scheme version; the
  -- connection id is bound in as additional authenticated data, so a
  -- ciphertext moved between rows fails to open rather than decrypting to
  -- somebody else's credential. The key lives in TABDUMP_CREDENTIAL_KEY and
  -- is never in this database.
  --
  -- What is NOT here: a plaintext column, a reversible encoding, a hash of
  -- the key, a prefix, or a length. Nothing in this table is readable by
  -- anyone holding only a dump of it.
  scheme         SMALLINT NOT NULL,
  iv             TEXT NOT NULL,
  ciphertext     TEXT NOT NULL,
  auth_tag       TEXT NOT NULL,
  updated_at     BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS tabdump_provider_secrets_owner_idx
  ON tabdump_provider_secrets (owner_id);
