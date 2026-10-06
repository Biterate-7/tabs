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
