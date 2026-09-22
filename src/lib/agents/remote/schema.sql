-- TabDump remote agent runtime — the smallest schema remote execution needs.
--
-- Additive and idempotent, exactly like src/lib/auth/store/schema.sql: every
-- statement is IF NOT EXISTS, so running this against an existing database
-- creates what is missing and touches nothing else. Apply it with
-- `npm run migrate:remote` (scripts/migrate-remote.mjs).
--
-- Two tables, and the restraint is the point. TabDump is local-first and
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
  -- FK to tabdump_users because a purely local TabDump has no accounts at
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
