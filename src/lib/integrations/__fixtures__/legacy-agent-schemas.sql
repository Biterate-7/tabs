-- The agent product's Postgres schemas as they shipped before its removal
-- (eb97f5f: src/lib/agents/credentials/schema.sql, src/lib/agents/remote/schema.sql,
-- src/lib/agents/activity/history-schema.sql). Production databases still hold
-- these tables -- nothing drops them -- so migration tests apply them to model a
-- production-shaped database. Frozen: never edit, never apply outside tests.

-- ---- src/lib/agents/credentials/schema.sql
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

-- ---- src/lib/agents/remote/schema.sql
-- Hubble remote agent runtime — the smallest schema remote execution needs.
--
-- Additive and idempotent, exactly like src/lib/auth/store/schema.sql: every
-- statement is IF NOT EXISTS, so running this against an existing database
-- creates what is missing and touches nothing else. Apply it with
-- `npm run migrate:remote` (scripts/migrate-remote.mjs).
--
-- Two tables, and the restraint is the point. Hubble is local-first and
-- stays that way: tabs, collections, workspaces, graph layout and local
-- projects are not here and never will be. What is here is the only state a
-- serverless control plane genuinely cannot hold — which sandbox backs which
-- project, and which sandbox backs which live session.
--
-- There is deliberately NO credential column of any kind. Not an Anthropic
-- key, not a Vercel token, not a git password. The provider credential is
-- read from the process environment at the moment a sandbox starts and is
-- never written down; a copy in a row would be a copy in every backup and
-- every `SELECT *` in a support session.

CREATE TABLE IF NOT EXISTS tabdump_remote_projects (
  -- Opaque and server-minted. This is the ONLY identifier the browser ever
  -- sees for a remote project.
  id            TEXT PRIMARY KEY,
  -- The runtime host's actor id, e.g. 'account:<uuid>'. TEXT rather than a
  -- FK to tabdump_users because a purely local Hubble has no accounts at
  -- all and still needs this table to typecheck against the same code.
  owner_id      TEXT NOT NULL,
  name          TEXT NOT NULL,
  -- 'remote_upload' | 'remote_git'. A local project is never stored here;
  -- those live in the browser, as they always have.
  source        TEXT NOT NULL,
  -- The platform's handle on the microVM. Minted from a CSPRNG and NOT
  -- derived from any other column, so a leaked project id reveals nothing
  -- about how to address the sandbox. UNIQUE so two projects can never end
  -- up pointing at the same VM.
  sandbox_name  TEXT NOT NULL UNIQUE,
  -- What the user authorized agents in this project to do. Stored rather than
  -- assumed: "it runs in a disposable microVM" says who else is safe, not
  -- whether this user consented to an agent running commands on their files.
  -- Re-read on every dispatch; never widened by context.
  scopes        TEXT[] NOT NULL DEFAULT '{}',
  status        TEXT NOT NULL,
  -- When the platform said it would reclaim the sandbox. A cache of its
  -- answer, not the authority: the runtime re-reads before dispatching.
  expires_at    BIGINT,
  -- Epoch milliseconds, matching every other timestamp in this codebase.
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL
);

-- Every read is owner-scoped, and the owner is part of the predicate rather
-- than a check after the fact. This index is what makes that free.
CREATE INDEX IF NOT EXISTS tabdump_remote_projects_owner_idx
  ON tabdump_remote_projects (owner_id, created_at DESC);

-- The reclamation sweep scans by deadline across every owner.
CREATE INDEX IF NOT EXISTS tabdump_remote_projects_expires_idx
  ON tabdump_remote_projects (expires_at)
  WHERE expires_at IS NOT NULL;

CREATE TABLE IF NOT EXISTS tabdump_remote_sessions (
  -- The control session id, minted by the control service exactly as a local
  -- session's is. Remote sessions are not a second session model.
  id                  TEXT PRIMARY KEY,
  owner_id            TEXT NOT NULL,
  project_id          TEXT NOT NULL
                        REFERENCES tabdump_remote_projects(id) ON DELETE CASCADE,
  provider            TEXT NOT NULL,
  sandbox_name        TEXT NOT NULL,
  -- The bridge process's command id. What lets a later serverless invocation
  -- reattach to the SAME running agent instead of starting a second one.
  command_id          TEXT,
  -- The provider's own session id, once the agent reveals one. Opaque here.
  provider_session_id TEXT,
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL
);

-- Note what is NOT a column here: an event cursor. The runtime host's journal
-- is in memory and is empty at the start of every serverless request, so a
-- stored byte offset would hand back "events since N" to a journal holding
-- nothing before N — and the client's sequence cursor would address numbers
-- this process never assigned. The sandbox's append-only log is the durable
-- journal instead, and it is replayed from the beginning each request; the
-- journal deduplicates by event id, so replay is free of side effects.
-- See src/lib/agents/remote/types.ts for the full reasoning.

CREATE INDEX IF NOT EXISTS tabdump_remote_sessions_owner_idx
  ON tabdump_remote_sessions (owner_id, created_at DESC);

CREATE INDEX IF NOT EXISTS tabdump_remote_sessions_project_idx
  ON tabdump_remote_sessions (project_id);

-- ---- src/lib/agents/activity/history-schema.sql
-- Hubble agent history — an agent session's activity, kept after the runtime
-- that hosted it is gone.
--
-- Additive and idempotent, exactly like every other Hubble schema: every
-- statement is IF NOT EXISTS, so running this against an existing database
-- creates what is missing and touches nothing else. Apply it with
-- `npm run migrate:agent-history` (scripts/migrate-agent-history.mjs). No
-- existing table is read, altered or backfilled; an account with no history
-- simply has no rows.
--
-- Two tables. A session row says who, where, which agent, and how it stands;
-- a record row is one of the canonical records the live activity timeline is
-- built from (src/lib/agents/activity/history.ts) — a control event, an
-- approval, an applied workspace change, an undo, a plan's outcome — already
-- reduced to what the timeline and the action inspector read.
--
-- There is deliberately NO credential, token, header, prompt, message body,
-- command line or URL column, and `data` is written only from the reducers
-- in history.ts, which have nowhere to put one.

CREATE TABLE IF NOT EXISTS tabdump_agent_history_sessions (
  -- The runtime actor, e.g. 'account:<uuid>' or 'local'. TEXT rather than a
  -- FK to tabdump_users, for the same reason as tabdump_remote_projects: a
  -- Hubble with no accounts still records under the local actor.
  owner_id             TEXT NOT NULL,
  -- The control session id, minted by the runtime. Not a second session model.
  id                   TEXT NOT NULL,
  -- Hubble's workspace id. Fixed for the session's life: no write moves it.
  workspace_id         TEXT NOT NULL,
  provider             TEXT NOT NULL,
  -- The control session status as last recorded (src/lib/agents/control/session.ts).
  status               TEXT NOT NULL,
  title                TEXT,
  -- Hubble's project id, never a path.
  project_id           TEXT,
  context_unavailable  BOOLEAN NOT NULL DEFAULT FALSE,
  -- More events happened than are kept (HISTORY_LIMITS.eventsPerSession).
  truncated            BOOLEAN NOT NULL DEFAULT FALSE,
  -- Epoch milliseconds, matching every other timestamp in this codebase.
  started_at           BIGINT NOT NULL,
  last_activity_at     BIGINT NOT NULL,
  ended_at             BIGINT,
  PRIMARY KEY (owner_id, id)
);

-- The one listing query: an owner's sessions in one workspace, newest
-- activity first, walked by keyset. Owner and workspace lead the index
-- because they lead every predicate.
CREATE INDEX IF NOT EXISTS tabdump_agent_history_sessions_workspace_idx
  ON tabdump_agent_history_sessions (owner_id, workspace_id, last_activity_at DESC, id DESC);

CREATE TABLE IF NOT EXISTS tabdump_agent_history_records (
  owner_id    TEXT NOT NULL,
  session_id  TEXT NOT NULL,
  kind        TEXT NOT NULL
                CHECK (kind IN ('event', 'approval', 'change', 'undo', 'plan_outcome')),
  -- Stable per record: the journal's event identity, the approval id, the
  -- change id, the undone change's id, the plan id. Writing the same key
  -- twice writes nothing, which is what makes a replay free.
  record_key  TEXT NOT NULL,
  at          BIGINT NOT NULL,
  data        JSONB NOT NULL,
  PRIMARY KEY (owner_id, session_id, kind, record_key),
  FOREIGN KEY (owner_id, session_id)
    REFERENCES tabdump_agent_history_sessions (owner_id, id) ON DELETE CASCADE
);

-- Hubble 1.4 — explicit agent handoffs.
--
-- One row per handoff the person made from one agent session to another:
-- the explicit relationship `source session -> handoff -> target session`,
-- stored by id and never inferred from times, names or neighbouring rows.
-- Additive like everything above: a database migrated for 1.3 gains this
-- table, and nothing above it changes. Until it exists, history works exactly
-- as before and handoffs are simply not kept.
--
-- Only handoffs that ended are kept (`ready`, `failed`); one being prepared or
-- cancelled is not a fact about either session. `data` holds what was passed,
-- as src/lib/agents/handoff/handoff.ts reduces it — context counts, the
-- source's result lines in the timeline's words, the person's scrubbed
-- instruction. No transcript, no reasoning, no credential: there is nowhere
-- to put one.

CREATE TABLE IF NOT EXISTS tabdump_agent_handoffs (
  owner_id            TEXT NOT NULL,
  id                  TEXT NOT NULL,
  -- Both sessions work here. A handoff never crosses workspaces.
  workspace_id        TEXT NOT NULL,
  source_session_id   TEXT NOT NULL,
  source_provider     TEXT NOT NULL,
  target_provider     TEXT NOT NULL,
  -- Set whenever the target session exists (always on 'ready').
  target_session_id   TEXT,
  status              TEXT NOT NULL CHECK (status IN ('ready', 'failed')),
  failure             TEXT CHECK (failure IN ('session_not_created', 'context_not_delivered')),
  created_at          BIGINT NOT NULL,
  updated_at          BIGINT NOT NULL,
  data                JSONB NOT NULL,
  PRIMARY KEY (owner_id, id),
  FOREIGN KEY (owner_id, source_session_id)
    REFERENCES tabdump_agent_history_sessions (owner_id, id) ON DELETE CASCADE
);

-- A session's handoffs, both ways.
CREATE INDEX IF NOT EXISTS tabdump_agent_handoffs_source_idx
  ON tabdump_agent_handoffs (owner_id, source_session_id);
CREATE INDEX IF NOT EXISTS tabdump_agent_handoffs_target_idx
  ON tabdump_agent_handoffs (owner_id, target_session_id);
