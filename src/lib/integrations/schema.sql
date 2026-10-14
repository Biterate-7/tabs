-- Hubble AI integrations: connections from ChatGPT, Claude, Gemini, Grok and
-- other MCP clients to a Hubble account, the OAuth records behind them,
-- reorganization proposals, saved project context, and the audit log.
-- See src/lib/integrations and docs/ai-integrations.md.
--
-- Additive and idempotent, like every schema in this project: IF NOT EXISTS
-- throughout, so applying it twice is a no-op and applying it to a populated
-- database touches nothing else. Apply with scripts/migrate-integrations.mjs, which requires --expect-host.
--
-- Depends on tabdump_users (src/lib/auth/store/schema.sql).
--
-- Secrets are stored only as SHA-256 hashes, and the CHECK constraints make
-- that structural: no column can hold a token, a client secret or an
-- authorization code by mistake.

-- A connection: one AI client's grant to one account. Scopes and workspaces
-- live here, not on a token, so narrowing or revoking one applies to every
-- credential issued under it on the next request.
CREATE TABLE IF NOT EXISTS hubble_integration_connections (
  id               TEXT PRIMARY KEY,
  user_id          UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  client           TEXT NOT NULL CHECK (client IN ('chatgpt', 'claude', 'gemini', 'grok', 'other')),
  label            TEXT NOT NULL CHECK (char_length(label) BETWEEN 1 AND 60),
  method           TEXT NOT NULL CHECK (method IN ('oauth', 'token')),
  oauth_client_id  TEXT,
  -- Read is always present; write is the only addition there is.
  scopes           TEXT[] NOT NULL CHECK (
                     'hubble.read' = ANY (scopes)
                     AND scopes <@ ARRAY['hubble.read', 'hubble.write']::TEXT[]
                   ),
  -- Never empty: a connection sees the workspaces the person chose, never "all".
  workspace_ids    TEXT[] NOT NULL CHECK (cardinality(workspace_ids) BETWEEN 1 AND 50),
  created_at       BIGINT NOT NULL,
  updated_at       BIGINT NOT NULL,
  last_used_at     BIGINT,
  revoked_at       BIGINT
);

CREATE INDEX IF NOT EXISTS hubble_integration_connections_user_idx
  ON hubble_integration_connections (user_id, created_at DESC);

CREATE TABLE IF NOT EXISTS hubble_integration_credentials (
  id             TEXT PRIMARY KEY,
  connection_id  TEXT NOT NULL REFERENCES hubble_integration_connections(id) ON DELETE CASCADE,
  kind           TEXT NOT NULL CHECK (kind IN ('access', 'refresh', 'personal', 'test')),
  token_hash     TEXT NOT NULL UNIQUE CHECK (token_hash ~ '^[0-9a-f]{64}$'),
  hint           TEXT NOT NULL CHECK (char_length(hint) = 4),
  -- The audience an access token was issued for: the MCP endpoint URL.
  resource       TEXT,
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL CHECK (expires_at > created_at),
  used_at        BIGINT,
  revoked_at     BIGINT,
  last_used_at   BIGINT
);

CREATE INDEX IF NOT EXISTS hubble_integration_credentials_connection_idx
  ON hubble_integration_credentials (connection_id);

-- OAuth clients registered through Dynamic Client Registration (RFC 7591).
CREATE TABLE IF NOT EXISTS hubble_oauth_clients (
  client_id                   TEXT PRIMARY KEY CHECK (client_id ~ '^hbcl_[A-Za-z0-9_-]{22}$'),
  client_name                 TEXT NOT NULL CHECK (char_length(client_name) BETWEEN 1 AND 60),
  redirect_uris               TEXT[] NOT NULL CHECK (cardinality(redirect_uris) BETWEEN 1 AND 5),
  token_endpoint_auth_method  TEXT NOT NULL CHECK (token_endpoint_auth_method IN ('none', 'client_secret_post', 'client_secret_basic')),
  secret_hash                 TEXT CHECK (secret_hash IS NULL OR secret_hash ~ '^[0-9a-f]{64}$'),
  created_at                  BIGINT NOT NULL
);

-- Authorization codes: single use, minutes long, hash only.
CREATE TABLE IF NOT EXISTS hubble_oauth_codes (
  code_hash       TEXT PRIMARY KEY CHECK (code_hash ~ '^[0-9a-f]{64}$'),
  client_id       TEXT NOT NULL REFERENCES hubble_oauth_clients(client_id) ON DELETE CASCADE,
  user_id         UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  redirect_uri    TEXT NOT NULL,
  code_challenge  TEXT NOT NULL CHECK (code_challenge ~ '^[A-Za-z0-9_-]{43}$'),
  resource        TEXT NOT NULL,
  scopes          TEXT[] NOT NULL,
  workspace_ids   TEXT[] NOT NULL,
  client          TEXT NOT NULL,
  label           TEXT NOT NULL,
  created_at      BIGINT NOT NULL,
  expires_at      BIGINT NOT NULL,
  used_at         BIGINT,
  connection_id   TEXT
);

-- Reorganizations waiting for, or past, the person's decision in Hubble.
CREATE TABLE IF NOT EXISTS hubble_integration_proposals (
  id             TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  connection_id  TEXT NOT NULL,
  client         TEXT NOT NULL,
  workspace_id   TEXT NOT NULL,
  base_version   BIGINT NOT NULL,
  operations     JSONB NOT NULL,
  steps          JSONB NOT NULL,
  tab_count      INTEGER NOT NULL,
  effect         TEXT NOT NULL,
  summary        TEXT,
  status         TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'declined', 'applying', 'applied', 'failed', 'expired')),
  created_at     BIGINT NOT NULL,
  expires_at     BIGINT NOT NULL,
  decided_at     BIGINT,
  applied_at     BIGINT,
  result         JSONB,
  failure        TEXT
);

CREATE INDEX IF NOT EXISTS hubble_integration_proposals_user_idx
  ON hubble_integration_proposals (user_id, created_at DESC);

-- The audit log. Ids, counts and fixed wording; never resource text, a
-- query, a prompt or a token.
CREATE TABLE IF NOT EXISTS hubble_integration_activity (
  id              TEXT PRIMARY KEY,
  user_id         UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  connection_id   TEXT,
  client          TEXT,
  actor           TEXT NOT NULL CHECK (actor IN ('ai_client', 'user', 'connection_test')),
  kind            TEXT NOT NULL CHECK (kind IN ('read', 'write', 'proposal', 'approval', 'decline', 'apply', 'connection')),
  operation       TEXT NOT NULL CHECK (char_length(operation) <= 60),
  workspace_id    TEXT,
  targets         TEXT[] NOT NULL DEFAULT '{}' CHECK (cardinality(targets) <= 20),
  outcome         TEXT NOT NULL CHECK (outcome IN ('ok', 'denied', 'failed', 'pending', 'partial')),
  error_category  TEXT,
  detail          TEXT CHECK (detail IS NULL OR char_length(detail) <= 160),
  at              BIGINT NOT NULL
);

CREATE INDEX IF NOT EXISTS hubble_integration_activity_user_idx
  ON hubble_integration_activity (user_id, at DESC);


-- A retried mutation answered from its first result.
CREATE TABLE IF NOT EXISTS hubble_integration_idempotency (
  connection_id  TEXT NOT NULL REFERENCES hubble_integration_connections(id) ON DELETE CASCADE,
  key            TEXT NOT NULL CHECK (key ~ '^[A-Za-z0-9_.:-]{8,100}$'),
  operation      TEXT NOT NULL,
  result         JSONB NOT NULL,
  created_at     BIGINT NOT NULL,
  PRIMARY KEY (connection_id, key)
);

-- Saved project context, schema version 1: one row per workspace.
CREATE TABLE IF NOT EXISTS hubble_project_context (
  user_id         UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  workspace_id    TEXT NOT NULL,
  schema_version  INTEGER NOT NULL CHECK (schema_version = 1),
  revision        INTEGER NOT NULL CHECK (revision >= 0),
  document        JSONB NOT NULL,
  updated_at      BIGINT NOT NULL,
  PRIMARY KEY (user_id, workspace_id)
);

CREATE TABLE IF NOT EXISTS hubble_workspace_notes (
  id             TEXT PRIMARY KEY,
  user_id        UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  workspace_id   TEXT NOT NULL,
  collection_id  TEXT,
  title          TEXT NOT NULL CHECK (char_length(title) BETWEEN 1 AND 120),
  body           TEXT NOT NULL CHECK (char_length(body) BETWEEN 1 AND 8000),
  content_hash   TEXT NOT NULL CHECK (content_hash ~ '^[0-9a-f]{64}$'),
  source         JSONB NOT NULL,
  created_at     BIGINT NOT NULL,
  UNIQUE (user_id, workspace_id, content_hash)
);

CREATE INDEX IF NOT EXISTS hubble_workspace_notes_workspace_idx
  ON hubble_workspace_notes (user_id, workspace_id, created_at DESC);

-- Retention (src/lib/integrations/activity.ts, retentionCutoffs): pruning
-- runs across every account, so each prune is a range delete on one of these.
CREATE INDEX IF NOT EXISTS hubble_integration_activity_at_idx
  ON hubble_integration_activity (at);
CREATE INDEX IF NOT EXISTS hubble_integration_credentials_expires_idx
  ON hubble_integration_credentials (expires_at);
CREATE INDEX IF NOT EXISTS hubble_oauth_codes_expires_idx
  ON hubble_oauth_codes (expires_at);
CREATE INDEX IF NOT EXISTS hubble_integration_idempotency_created_idx
  ON hubble_integration_idempotency (created_at);
