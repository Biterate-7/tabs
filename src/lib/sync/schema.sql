-- Hubble workspace synchronization schema.
--
-- This is the SERVER's ownership and change-tracking model for workspace
-- data. Nothing in the running application reads or writes these tables yet:
-- Hubble remains local-first, localStorage is still the source of truth,
-- and no mutation path touches the network. This establishes the
-- representation and the contract so a later phase can implement sync
-- against something already designed rather than inventing it under
-- pressure.
--
-- Additive and idempotent, exactly like src/lib/auth/store/schema.sql: every
-- statement is IF NOT EXISTS, it never drops, never rewrites, and never
-- resets. It is applied by `npm run migrate:sync`
-- (scripts/migrate-sync.mjs) and coexists with the auth tables, which it
-- only ever references.
--
-- Tables keep the `tabdump_` prefix so this can live in a shared database.
--
--
-- ## Why not one JSONB blob per workspace
--
-- Sync needs to answer "what changed in this workspace since cursor X"
-- without shipping the whole workspace. That requires per-object identity
-- and per-object change ordering, which a `workspace.data JSONB` column
-- cannot provide.
--
-- There is no JSONB in this schema at all. Every field modelled here is
-- either a scalar the client already holds as one, or a genuine
-- relationship that belongs in its own table — so nothing was opaque enough
-- to justify it.
--
--
-- ## Identity: client-generated UUIDs, preserved verbatim
--
-- The client mints entity ids offline (src/lib/id.ts) and the server stores
-- exactly what it is given. No column uses DEFAULT gen_random_uuid(), and
-- nothing remaps an id on upload — an entity created offline keeps its
-- identity forever.
--
-- The ONE wrinkle, recorded here because it is a real constraint on the
-- future upload path rather than a detail: entities saved before Phase 1
-- (63992f8) kept their old `<prefix>-<epoch_ms>-<counter>` ids, which are
-- NOT valid UUIDs. Those rows cannot be inserted into these UUID columns.
-- That is deliberate. Widening the columns to TEXT would not actually help:
-- the validation layer (src/lib/sync/validation.ts) rejects a non-UUID id at
-- the trust boundary regardless of column type, so TEXT would buy nothing
-- and would permanently give up database-level id validation. Deciding what
-- happens to a legacy-id workspace — remap behind a mapping table, or ask
-- the user — belongs with the initial-sync policy, which is deliberately
-- deferred. See src/lib/sync/types.ts.
--
--
-- ## Timestamps: epoch milliseconds, BIGINT
--
-- Phase 2 (90a837d) established epoch-ms for every persistent entity, and
-- the auth schema already chose BIGINT over TIMESTAMPTZ so there is no
-- conversion layer to get wrong. Both hold here: created_at/updated_at map
-- 1:1 onto the client's createdAt/updatedAt with no transformation.
--
-- Nullability mirrors the client types exactly. Workspace, Section, Group
-- and Collection have required timestamps, so their columns are NOT NULL.
-- Tab.createdAt/updatedAt and TabDependency.updatedAt are optional in the
-- client model (a record predating Phase 2 legitimately has none, and
-- nothing backfills them), so those columns are nullable. A CHECK whose
-- expression is NULL passes in Postgres, so `updated_at >= created_at`
-- constrains the rows that have both and lets the rest through.
--
--
-- ## Two Postgres details the composite foreign keys depend on
--
-- Both are easy to "tidy up" into a bug, so they are stated here.
--
-- 1. MATCH SIMPLE (the default) is what makes an OPTIONAL relationship work.
--    A composite foreign key with any NULL column is considered satisfied,
--    so a root section (parent_id NULL) and an unsectioned tab (section_id
--    NULL) pass without a matching parent row. Changing these to MATCH FULL
--    would reject exactly those two entirely normal cases.
--
-- 2. The optional relationships are DEFERRABLE INITIALLY DEFERRED and use
--    the default NO ACTION rather than ON DELETE SET NULL. ON DELETE SET
--    NULL on a MULTI-COLUMN foreign key sets every referencing column to
--    NULL — including workspace_id, which is NOT NULL — so the delete would
--    always fail. Deferring the check to commit is what lets a workspace's
--    CASCADE remove sections, groups and tabs in whatever order Postgres
--    chooses without a transient reference tripping the constraint, and it
--    lets a transaction tombstone a section and re-point its tabs in either
--    order. Normal deletion in this schema is tombstoning, which never
--    removes a row and so never fires these at all.

-- ---------------------------------------------------------------------------
-- Workspaces
-- ---------------------------------------------------------------------------
--
-- ON DELETE CASCADE to tabdump_users is correct here and is NOT the same
-- decision as the tombstones below: deleting an account is erasure, not
-- synchronization. There is no client left to inform, so keeping tombstones
-- for a user who no longer exists would retain personal data for nobody's
-- benefit.
--
-- `sync_counter` is this workspace's monotonic change sequence. See the
-- "change ordering" note above tabdump_tabs for why the counter lives on the
-- workspace row rather than being a global Postgres SEQUENCE.
CREATE TABLE IF NOT EXISTS tabdump_workspaces (
  id            UUID PRIMARY KEY,
  user_id       UUID NOT NULL REFERENCES tabdump_users(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  -- Data URL for a user-uploaded icon (src/lib/workspace/logo.ts already
  -- validates and resizes it client-side, and caps it at 700_000 chars).
  -- Stored as TEXT because that is exactly what the client holds.
  logo          TEXT,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  -- Tombstone. NULL means live. See the deletion model note below.
  deleted_at    BIGINT,
  -- The workspace's own change version, drawn from sync_counter.
  sync_version  BIGINT NOT NULL,
  -- Next value to hand out. Bumped under a row lock by every mutating
  -- transaction, which is what makes version order equal commit order.
  sync_counter  BIGINT NOT NULL DEFAULT 0,

  CONSTRAINT tabdump_workspaces_created_at_valid  CHECK (created_at >= 0),
  CONSTRAINT tabdump_workspaces_updated_at_valid  CHECK (updated_at >= created_at),
  CONSTRAINT tabdump_workspaces_deleted_at_valid  CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT tabdump_workspaces_name_len          CHECK (char_length(name) <= 200),
  CONSTRAINT tabdump_workspaces_logo_len          CHECK (logo IS NULL OR char_length(logo) <= 700000),
  CONSTRAINT tabdump_workspaces_sync_version_pos  CHECK (sync_version > 0)
);

-- One index, serving both access paths this table has:
--
--   * "list the workspaces this user owns" — a prefix scan on user_id, the
--     first query any future sync endpoint runs and the only path that does
--     not already start from a known workspace id;
--   * "does this user own workspace X" — the ownership predicate on every
--     other request, answered from the index without touching the heap.
--
-- A second index on (user_id) alone would be redundant: this one already
-- serves any query that filters on its leading column.
CREATE INDEX IF NOT EXISTS tabdump_workspaces_owner_idx
  ON tabdump_workspaces (user_id, id);

-- ---------------------------------------------------------------------------
-- Sections
-- ---------------------------------------------------------------------------
--
-- The workspace's hierarchical organization tree. `parent_id` is NULL for a
-- root (depth 0); the client caps depth at 2 (MAX_SECTION_DEPTH), which is a
-- product rule rather than a storage one and is enforced in validation, not
-- here.
--
-- The self-referential foreign key is composite for the same reason every
-- other relationship here is: a section's parent must live in the same
-- workspace, and (workspace_id, parent_id) referencing (workspace_id, id)
-- makes any other arrangement unrepresentable.
--
-- ON DELETE CASCADE from the workspace fires only on a HARD delete of the
-- workspace row, which normal deletion never does (see tombstones). It is
-- the cleanup path for account erasure.
--
-- ON DELETE RESTRICT for the parent link: deleting a section that still has
-- children is a client-side reparenting decision (see deleteSection in
-- src/lib/sections/relations.ts), not something the database should silently
-- perform by destroying a subtree.
CREATE TABLE IF NOT EXISTS tabdump_sections (
  id            UUID NOT NULL,
  workspace_id  UUID NOT NULL REFERENCES tabdump_workspaces(id) ON DELETE CASCADE,
  parent_id     UUID,
  name          TEXT NOT NULL,
  -- "ai" | "user" — who created this section. User intent, so it syncs.
  source        TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  deleted_at    BIGINT,
  sync_version  BIGINT NOT NULL,

  PRIMARY KEY (id),
  CONSTRAINT tabdump_sections_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT tabdump_sections_parent_same_workspace
    FOREIGN KEY (workspace_id, parent_id)
    REFERENCES tabdump_sections (workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tabdump_sections_not_own_parent   CHECK (parent_id IS NULL OR parent_id <> id),
  CONSTRAINT tabdump_sections_source_valid     CHECK (source IN ('ai', 'user')),
  CONSTRAINT tabdump_sections_created_at_valid CHECK (created_at >= 0),
  CONSTRAINT tabdump_sections_updated_at_valid CHECK (updated_at >= created_at),
  CONSTRAINT tabdump_sections_deleted_at_valid CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT tabdump_sections_name_len         CHECK (char_length(name) <= 200),
  CONSTRAINT tabdump_sections_sync_version_pos CHECK (sync_version > 0)
);

CREATE INDEX IF NOT EXISTS tabdump_sections_changes_idx
  ON tabdump_sections (workspace_id, sync_version);

-- ---------------------------------------------------------------------------
-- Groups
-- ---------------------------------------------------------------------------
--
-- User-defined sub-groups within a workspace. Flat (no parent), unlike
-- sections.
CREATE TABLE IF NOT EXISTS tabdump_groups (
  id            UUID NOT NULL,
  workspace_id  UUID NOT NULL REFERENCES tabdump_workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  deleted_at    BIGINT,
  sync_version  BIGINT NOT NULL,

  PRIMARY KEY (id),
  CONSTRAINT tabdump_groups_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT tabdump_groups_created_at_valid CHECK (created_at >= 0),
  CONSTRAINT tabdump_groups_updated_at_valid CHECK (updated_at >= created_at),
  CONSTRAINT tabdump_groups_deleted_at_valid CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT tabdump_groups_name_len         CHECK (char_length(name) <= 200),
  CONSTRAINT tabdump_groups_sync_version_pos CHECK (sync_version > 0)
);

CREATE INDEX IF NOT EXISTS tabdump_groups_changes_idx
  ON tabdump_groups (workspace_id, sync_version);

-- ---------------------------------------------------------------------------
-- Tabs
-- ---------------------------------------------------------------------------
--
-- ## Which of the client's Tab fields live here
--
-- Synced, because they are user-owned durable state:
--   url, title, notes, is_favorite, pinned, category, confidence,
--   section_id, section_locked, organization_status, organization_reason,
--   group_id, last_accessed_at, source, history_visit_count,
--   history_last_visited_at, created_at, updated_at
--
-- NOT synced, with the reason for each:
--   normalized_url  Derived from url by normalizeUrl(). Re-deriving it
--                   server-side is exactly what section 7 of the brief
--                   forbids (it would risk changing the client's stored
--                   representation), and storing it would duplicate a value
--                   the client already recomputes deterministically.
--   domain          Derived from url the same way (hostname minus "www.").
--   is_duplicate    Purely derived: markDuplicates() recomputes it across
--                   the whole list from normalized_url. It is the same field
--                   Phase 2 excluded from stampChangedTabs for being churn
--                   rather than content.
--   favicon         Written by browser-import.ts and never read: every
--                   display path resolves an icon from `domain` through
--                   TabFavicon/faviconUrl. A write-only cache is not state
--                   worth synchronizing.
--
-- `confidence` IS synced despite looking like an AI artifact, because
-- src/lib/workspace/cleanup.ts reads it to decide which tabs need review —
-- losing it across devices would silently change what the cleanup dialog
-- offers.
--
-- ## URL handling
--
-- The url column stores the user's string byte-for-byte; the server never
-- re-normalizes it. The HTTP(S)-only rule is enforced in validation
-- (src/lib/sync/validation.ts) rather than by a CHECK, because deciding
-- scheme safety with a regex in SQL is exactly the kind of half-parser that
-- the client's isSafeOpenUrl exists to avoid. The length cap IS expressed
-- here, since that is a storage concern a constraint states well.
--
-- ## Change ordering
--
-- `sync_version` is assigned from the owning workspace's `sync_counter`,
-- incremented once per mutating transaction under a row lock on the
-- workspace. That choice is what makes a cursor correct:
--
--   * A bare global SEQUENCE is NOT safe as a sync cursor. nextval() is
--     handed out before commit, so a transaction holding version 5 can
--     commit after one holding 6. A client that read up to 6 and later saw 5
--     appear would miss that change permanently.
--   * Taking the number under a row lock on the workspace serializes version
--     assignment per workspace, so version order is commit order — which is
--     the only ordering a cursor can rely on.
--   * Every row touched by one transaction gets the SAME version, so a bulk
--     mutation (organize, move 20 tabs, import) is one indivisible step in
--     the change stream instead of 20 interleavable ones.
--
-- ## Deletion
--
-- `deleted_at` tombstones rather than DELETE. A row that vanishes cannot be
-- reported to a client asking "what changed since X", so deletions would
-- simply never propagate. A tombstone keeps its id, its workspace_id and its
-- place in the version stream, so it flows through the same changed-since
-- query as an update. Tombstoned rows are NOT purged by this phase.
CREATE TABLE IF NOT EXISTS tabdump_tabs (
  id                       UUID NOT NULL,
  workspace_id             UUID NOT NULL REFERENCES tabdump_workspaces(id) ON DELETE CASCADE,
  url                      TEXT NOT NULL,
  title                    TEXT,
  notes                    TEXT,
  category                 TEXT,
  confidence               DOUBLE PRECISION,
  is_favorite              BOOLEAN NOT NULL DEFAULT FALSE,
  pinned                   BOOLEAN NOT NULL DEFAULT FALSE,
  section_id               UUID,
  section_locked           BOOLEAN NOT NULL DEFAULT FALSE,
  organization_status      TEXT,
  organization_reason      TEXT,
  group_id                 UUID,
  last_accessed_at         BIGINT,
  source                   TEXT,
  history_visit_count      INTEGER,
  history_last_visited_at  BIGINT,
  -- Nullable: a tab saved before Phase 2 has neither, and nothing invents
  -- one. See the timestamp note at the top of this file.
  created_at               BIGINT,
  updated_at               BIGINT,
  deleted_at               BIGINT,
  sync_version             BIGINT NOT NULL,

  PRIMARY KEY (id),
  -- The FK target dependencies and collection membership point at.
  CONSTRAINT tabdump_tabs_workspace_key UNIQUE (workspace_id, id),

  -- Cross-workspace integrity, enforced by the database rather than by
  -- application checks: a tab's section and group must belong to the tab's
  -- own workspace. A plain FK on section_id alone would happily accept
  -- another user's section.
  CONSTRAINT tabdump_tabs_section_same_workspace
    FOREIGN KEY (workspace_id, section_id)
    REFERENCES tabdump_sections (workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT tabdump_tabs_group_same_workspace
    FOREIGN KEY (workspace_id, group_id)
    REFERENCES tabdump_groups (workspace_id, id)
    DEFERRABLE INITIALLY DEFERRED,

  CONSTRAINT tabdump_tabs_created_at_valid   CHECK (created_at IS NULL OR created_at >= 0),
  CONSTRAINT tabdump_tabs_updated_at_valid   CHECK (updated_at IS NULL OR created_at IS NULL OR updated_at >= created_at),
  CONSTRAINT tabdump_tabs_deleted_at_valid   CHECK (deleted_at IS NULL OR deleted_at >= 0),
  CONSTRAINT tabdump_tabs_last_accessed_valid CHECK (last_accessed_at IS NULL OR last_accessed_at >= 0),
  CONSTRAINT tabdump_tabs_url_len            CHECK (char_length(url) > 0 AND char_length(url) <= 4000),
  CONSTRAINT tabdump_tabs_title_len          CHECK (title IS NULL OR char_length(title) <= 2000),
  CONSTRAINT tabdump_tabs_notes_len          CHECK (notes IS NULL OR char_length(notes) <= 20000),
  CONSTRAINT tabdump_tabs_category_len       CHECK (category IS NULL OR char_length(category) <= 100),
  CONSTRAINT tabdump_tabs_reason_len         CHECK (organization_reason IS NULL OR char_length(organization_reason) <= 2000),
  CONSTRAINT tabdump_tabs_confidence_range   CHECK (confidence IS NULL OR (confidence >= 0 AND confidence <= 1)),
  CONSTRAINT tabdump_tabs_source_valid       CHECK (source IS NULL OR source IN ('tabs', 'history')),
  CONSTRAINT tabdump_tabs_org_status_valid
    CHECK (organization_status IS NULL OR organization_status IN ('classified', 'uncertain', 'fallback', 'manual')),
  CONSTRAINT tabdump_tabs_history_count_valid CHECK (history_visit_count IS NULL OR history_visit_count >= 0),
  CONSTRAINT tabdump_tabs_sync_version_pos    CHECK (sync_version > 0)
);

-- The changed-since query: "every tab in this workspace with a version above
-- the client's cursor, in version order". This is the whole read path of
-- incremental sync, so it gets the one index that serves it directly.
CREATE INDEX IF NOT EXISTS tabdump_tabs_changes_idx
  ON tabdump_tabs (workspace_id, sync_version);

-- ---------------------------------------------------------------------------
-- Collections
-- ---------------------------------------------------------------------------
--
-- Collections already carry an explicit workspaceId in the client model
-- (unlike tabs/sections/groups, whose membership is implied by living inside
-- a Workspace object), so this table is the closest 1:1 mapping in the
-- schema.
CREATE TABLE IF NOT EXISTS tabdump_collections (
  id            UUID NOT NULL,
  workspace_id  UUID NOT NULL REFERENCES tabdump_workspaces(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  created_at    BIGINT NOT NULL,
  updated_at    BIGINT NOT NULL,
  deleted_at    BIGINT,
  sync_version  BIGINT NOT NULL,

  PRIMARY KEY (id),
  CONSTRAINT tabdump_collections_workspace_key UNIQUE (workspace_id, id),
  CONSTRAINT tabdump_collections_created_at_valid CHECK (created_at >= 0),
  CONSTRAINT tabdump_collections_updated_at_valid CHECK (updated_at >= created_at),
  CONSTRAINT tabdump_collections_deleted_at_valid CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT tabdump_collections_name_len         CHECK (char_length(name) <= 200),
  CONSTRAINT tabdump_collections_sync_version_pos CHECK (sync_version > 0)
);

CREATE INDEX IF NOT EXISTS tabdump_collections_changes_idx
  ON tabdump_collections (workspace_id, sync_version);

-- ---------------------------------------------------------------------------
-- Collection membership
-- ---------------------------------------------------------------------------
--
-- The client models this as `Collection.tabIds: string[]` — an ordered list.
-- Storing that array in a text column would make "which collection holds
-- this tab" unanswerable in SQL and would put entity ids inside an opaque
-- value, so it becomes a real table with an explicit `position`.
--
-- Deliberately NOT an independently synced entity and deliberately WITHOUT a
-- tombstone: membership is part of the collection's payload in the client
-- model, so changing it is a mutation OF THE COLLECTION and is carried by
-- that collection's sync_version. Removing a tab from a collection deletes
-- the row and bumps the collection; a client re-reads the whole membership
-- list with the collection, exactly as it holds it locally.
--
-- UNIQUE (tab_id) is the database expression of the client invariant that a
-- tab belongs to zero or one collection (see stripFromAllCollections in
-- src/lib/collections/relations.ts).
CREATE TABLE IF NOT EXISTS tabdump_collection_tabs (
  workspace_id   UUID NOT NULL,
  collection_id  UUID NOT NULL,
  tab_id         UUID NOT NULL,
  position       INTEGER NOT NULL,

  PRIMARY KEY (collection_id, tab_id),
  CONSTRAINT tabdump_collection_tabs_one_collection_per_tab UNIQUE (tab_id),
  CONSTRAINT tabdump_collection_tabs_collection_same_workspace
    FOREIGN KEY (workspace_id, collection_id)
    REFERENCES tabdump_collections (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT tabdump_collection_tabs_tab_same_workspace
    FOREIGN KEY (workspace_id, tab_id)
    REFERENCES tabdump_tabs (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT tabdump_collection_tabs_position_valid CHECK (position >= 0)
);

-- "Which tabs are in this collection, in order" — the read that rebuilds
-- Collection.tabIds.
CREATE INDEX IF NOT EXISTS tabdump_collection_tabs_collection_idx
  ON tabdump_collection_tabs (collection_id, position);

-- ---------------------------------------------------------------------------
-- Tab dependencies
-- ---------------------------------------------------------------------------
--
-- Directional: parent depends on child.
--
-- Identity is the PAIR, not a minted id. The client's dependencyId() builds
-- `dep-<parent>::<child>` deterministically from the two tab ids, so the id
-- carries no information the pair does not already have — storing it would
-- create a second, redundant identity that could disagree with the columns
-- beside it. The primary key IS (parent_tab_id, child_tab_id), which is also
-- the uniqueness the client's findDependency() assumes.
--
-- Dependencies are workspace-scoped here even though the client keeps them
-- in a single flat store with no workspaceId: both endpoints are tabs, a tab
-- belongs to exactly one workspace, and sync is per-workspace, so the
-- workspace has to be explicit for the change query and for ownership.
--
-- The two composite foreign keys both reference the SAME workspace_id
-- column. That is what makes a cross-workspace dependency unrepresentable:
-- there is no pair of rows that satisfies both while the tabs live in
-- different workspaces.
--
-- created_at is NOT NULL because the client's TabDependency requires it;
-- updated_at is nullable because the client's is optional.
CREATE TABLE IF NOT EXISTS tabdump_dependencies (
  workspace_id   UUID NOT NULL,
  parent_tab_id  UUID NOT NULL,
  child_tab_id   UUID NOT NULL,
  type           TEXT,
  created_at     BIGINT NOT NULL,
  updated_at     BIGINT,
  deleted_at     BIGINT,
  sync_version   BIGINT NOT NULL,

  PRIMARY KEY (parent_tab_id, child_tab_id),
  CONSTRAINT tabdump_dependencies_parent_same_workspace
    FOREIGN KEY (workspace_id, parent_tab_id)
    REFERENCES tabdump_tabs (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT tabdump_dependencies_child_same_workspace
    FOREIGN KEY (workspace_id, child_tab_id)
    REFERENCES tabdump_tabs (workspace_id, id)
    ON DELETE CASCADE,
  CONSTRAINT tabdump_dependencies_not_self CHECK (parent_tab_id <> child_tab_id),
  CONSTRAINT tabdump_dependencies_type_valid
    CHECK (type IS NULL OR type IN ('main-document', 'research', 'data-source', 'reference', 'tool', 'other')),
  CONSTRAINT tabdump_dependencies_created_at_valid CHECK (created_at >= 0),
  CONSTRAINT tabdump_dependencies_updated_at_valid CHECK (updated_at IS NULL OR updated_at >= created_at),
  CONSTRAINT tabdump_dependencies_deleted_at_valid CHECK (deleted_at IS NULL OR deleted_at >= created_at),
  CONSTRAINT tabdump_dependencies_sync_version_pos CHECK (sync_version > 0)
);

CREATE INDEX IF NOT EXISTS tabdump_dependencies_changes_idx
  ON tabdump_dependencies (workspace_id, sync_version);

-- A tab's dependencies are read from the child side too ("what depends on
-- this tab" — usedBy() in src/lib/dependencies/relations.ts). The primary
-- key already indexes the parent side.
CREATE INDEX IF NOT EXISTS tabdump_dependencies_child_idx
  ON tabdump_dependencies (child_tab_id);
