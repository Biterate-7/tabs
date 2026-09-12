import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Structural assertions over schema.sql.
 *
 * ## What these can and cannot prove
 *
 * There is no Postgres in this environment (no server, no psql, no Docker),
 * and src/lib/auth/store/postgres.test.ts already records that constraint
 * for the auth adapter. So these do NOT prove the schema applies, that a
 * foreign key rejects a bad row, or that a CHECK fires. Applying the schema
 * against a real database remains a required manual step.
 *
 * What they DO prove is that the security-critical structure is present and
 * has not been quietly weakened — which is worth pinning precisely because a
 * reviewer cannot run the database either. The defects these catch are real
 * ones: a composite foreign key silently downgraded to a single-column
 * reference (which would let a relationship cross a workspace boundary), a
 * CASCADE appearing where tombstones are supposed to be, timestamps drifting
 * to TIMESTAMPTZ, or an id column widened to TEXT.
 *
 * They are deliberately written against normalized text rather than by
 * parsing SQL: a parser here would be a second implementation to get wrong.
 */

const SCHEMA = readFileSync(path.join(process.cwd(), "src", "lib", "sync", "schema.sql"), "utf8");

/** Comments stripped and whitespace collapsed, so assertions don't depend on formatting — or match prose in a comment. */
const SQL = SCHEMA.replace(/--[^\n]*/g, " ").replace(/\s+/g, " ").trim();

/** The body of one CREATE TABLE statement, for assertions that must not accidentally match a different table. */
function tableBody(name: string): string {
  const start = SQL.indexOf(`CREATE TABLE IF NOT EXISTS ${name} (`);
  expect(start, `${name} is not declared`).toBeGreaterThanOrEqual(0);
  let depth = 0;
  for (let i = SQL.indexOf("(", start); i < SQL.length; i++) {
    if (SQL[i] === "(") depth++;
    else if (SQL[i] === ")") {
      depth--;
      if (depth === 0) return SQL.slice(SQL.indexOf("(", start) + 1, i);
    }
  }
  throw new Error(`unbalanced parentheses in ${name}`);
}

const ENTITY_TABLES = [
  "tabdump_workspaces",
  "tabdump_sections",
  "tabdump_groups",
  "tabdump_tabs",
  "tabdump_collections",
  "tabdump_dependencies",
] as const;

/** Tables whose rows are owned by a workspace rather than being the workspace. */
const CHILD_TABLES = [
  "tabdump_sections",
  "tabdump_groups",
  "tabdump_tabs",
  "tabdump_collections",
  "tabdump_dependencies",
] as const;

describe("migration safety", () => {
  it("creates every table and index idempotently", () => {
    const creates = SQL.match(/CREATE (TABLE|INDEX|UNIQUE INDEX)/g) ?? [];
    const guarded = SQL.match(/CREATE (TABLE|INDEX|UNIQUE INDEX) IF NOT EXISTS/g) ?? [];
    expect(creates.length).toBeGreaterThan(0);
    expect(guarded).toHaveLength(creates.length);
  });

  it("never drops, truncates, alters or deletes", () => {
    // Re-running this against a populated production database has to be a
    // no-op. Anything destructive here would make that false.
    for (const verb of ["DROP ", "TRUNCATE ", "ALTER TABLE", "DELETE FROM", "UPDATE "]) {
      expect(SQL.toUpperCase()).not.toContain(verb);
    }
  });

  it("touches no auth table except by reference", () => {
    expect(SQL).not.toContain("CREATE TABLE IF NOT EXISTS tabdump_users");
    expect(SQL).not.toContain("CREATE TABLE IF NOT EXISTS tabdump_sessions");
    expect(SQL).not.toContain("tabdump_sessions");
    // The one permitted mention: workspaces reference the existing users table.
    expect(SQL).toContain("REFERENCES tabdump_users(id)");
  });
});

describe("identity", () => {
  it("uses UUID columns for every entity id and never TEXT", () => {
    expect(tableBody("tabdump_workspaces")).toMatch(/id UUID PRIMARY KEY/);
    for (const table of ["tabdump_sections", "tabdump_groups", "tabdump_tabs", "tabdump_collections"]) {
      expect(tableBody(table), table).toMatch(/id UUID NOT NULL/);
    }
    const deps = tableBody("tabdump_dependencies");
    expect(deps).toMatch(/parent_tab_id UUID NOT NULL/);
    expect(deps).toMatch(/child_tab_id UUID NOT NULL/);
  });

  it("never generates an id server-side", () => {
    // Client-generated UUIDs must survive upload unchanged, which is what
    // makes offline creation work. A DEFAULT here would mint a second
    // identity for an entity that already has one.
    expect(SQL).not.toMatch(/gen_random_uuid|uuid_generate_v4/i);
    expect(SQL).not.toMatch(/\bSERIAL\b|\bBIGSERIAL\b|GENERATED\s+\w+\s+AS IDENTITY/i);
    // The only DEFAULT in the schema is the workspace's change counter,
    // which is server-owned bookkeeping rather than entity identity.
    const defaults = SQL.match(/DEFAULT\s+\S+/gi) ?? [];
    expect(defaults.every((d) => /DEFAULT\s+(0|FALSE)/i.test(d))).toBe(true);
  });

  it("makes the dependency pair the primary key rather than minting an id", () => {
    const deps = tableBody("tabdump_dependencies");
    expect(deps).toContain("PRIMARY KEY (parent_tab_id, child_tab_id)");
    // The client derives `dep-<parent>::<child>`; a stored id column would be
    // a redundant second identity that could disagree with these columns.
    expect(deps).not.toMatch(/\bid UUID\b/);
  });
});

describe("timestamps", () => {
  it("stores every timestamp as BIGINT epoch-ms", () => {
    for (const table of ENTITY_TABLES) {
      const body = tableBody(table);
      expect(body, table).toMatch(/created_at\s+BIGINT/);
      expect(body, table).toMatch(/updated_at\s+BIGINT/);
      expect(body, table).toMatch(/deleted_at\s+BIGINT/);
    }
    // Phase 2 chose epoch-ms and the auth schema chose BIGINT to avoid a
    // conversion layer. Both still hold.
    expect(SQL).not.toMatch(/TIMESTAMPTZ|TIMESTAMP WITH TIME ZONE|\bDATE\b/i);
  });

  it("constrains created_at to be non-negative and updated_at not to precede it", () => {
    for (const table of ENTITY_TABLES) {
      const body = tableBody(table);
      expect(body, table).toContain("created_at >= 0");
      expect(body, table).toContain("updated_at >= created_at");
    }
  });

  it("leaves a tab's timestamps nullable, because one saved before Phase 2 has none", () => {
    const tabs = tableBody("tabdump_tabs");
    expect(tabs).toMatch(/created_at\s+BIGINT,/);
    expect(tabs).not.toMatch(/created_at\s+BIGINT NOT NULL/);
    expect(tabs).not.toMatch(/updated_at\s+BIGINT NOT NULL/);
    // Whereas a workspace's are required, exactly as the client type is.
    const workspaces = tableBody("tabdump_workspaces");
    expect(workspaces).toMatch(/created_at\s+BIGINT NOT NULL/);
    expect(workspaces).toMatch(/updated_at\s+BIGINT NOT NULL/);
  });
});

describe("ownership and cross-workspace integrity", () => {
  it("ties every child table to a workspace", () => {
    for (const table of CHILD_TABLES) {
      expect(tableBody(table), table).toMatch(/workspace_id\s+UUID NOT NULL/);
    }
  });

  it("gives every composite-FK target its (workspace_id, id) unique key", () => {
    for (const table of ["tabdump_sections", "tabdump_groups", "tabdump_tabs", "tabdump_collections"]) {
      expect(tableBody(table), table).toMatch(/UNIQUE \(workspace_id, id\)/);
    }
  });

  it("references relationships by (workspace_id, id) so one cannot cross a workspace", () => {
    // This is the assertion that matters most. A plain `REFERENCES
    // tabdump_sections (id)` would compile, pass every application test, and
    // let a client attach its tab to another user's section.
    const tabs = tableBody("tabdump_tabs");
    expect(tabs).toContain("FOREIGN KEY (workspace_id, section_id) REFERENCES tabdump_sections (workspace_id, id)");
    expect(tabs).toContain("FOREIGN KEY (workspace_id, group_id) REFERENCES tabdump_groups (workspace_id, id)");

    const sections = tableBody("tabdump_sections");
    expect(sections).toContain("FOREIGN KEY (workspace_id, parent_id) REFERENCES tabdump_sections (workspace_id, id)");

    const deps = tableBody("tabdump_dependencies");
    expect(deps).toContain("FOREIGN KEY (workspace_id, parent_tab_id) REFERENCES tabdump_tabs (workspace_id, id)");
    expect(deps).toContain("FOREIGN KEY (workspace_id, child_tab_id) REFERENCES tabdump_tabs (workspace_id, id)");

    const membership = tableBody("tabdump_collection_tabs");
    expect(membership).toContain(
      "FOREIGN KEY (workspace_id, collection_id) REFERENCES tabdump_collections (workspace_id, id)"
    );
    expect(membership).toContain("FOREIGN KEY (workspace_id, tab_id) REFERENCES tabdump_tabs (workspace_id, id)");
  });

  it("makes a cross-workspace dependency unrepresentable by sharing one workspace_id column", () => {
    // Both endpoints resolve through the SAME workspace_id, so there is no
    // pair of rows satisfying both foreign keys while the tabs live in
    // different workspaces.
    const deps = tableBody("tabdump_dependencies");
    const references = deps.match(/REFERENCES tabdump_tabs \(workspace_id, id\)/g) ?? [];
    expect(references).toHaveLength(2);
    expect(deps).toContain("CHECK (parent_tab_id <> child_tab_id)");
  });

  it("enforces one collection per tab", () => {
    expect(tableBody("tabdump_collection_tabs")).toMatch(/UNIQUE \(tab_id\)/);
  });
});

describe("deletion model", () => {
  it("gives every syncable entity a tombstone column", () => {
    for (const table of ENTITY_TABLES) {
      expect(tableBody(table), table).toMatch(/deleted_at\s+BIGINT/);
    }
  });

  it("cascades from the user, because account erasure has no client to inform", () => {
    expect(tableBody("tabdump_workspaces")).toContain("REFERENCES tabdump_users(id) ON DELETE CASCADE");
  });

  it("never destroys a section subtree or a tab as a side effect of its parent going", () => {
    // Reparenting is a client decision (deleteSection in
    // src/lib/sections/relations.ts). A CASCADE on either of these would
    // delete user data — a whole section subtree, or every tab that happened
    // to sit in a section — as a side effect of removing one row.
    const sections = tableBody("tabdump_sections");
    const tabs = tableBody("tabdump_tabs");
    expect(sections).not.toMatch(/REFERENCES tabdump_sections \(workspace_id, id\) ON DELETE CASCADE/);
    expect(tabs).not.toMatch(/REFERENCES tabdump_sections \(workspace_id, id\) ON DELETE CASCADE/);
    expect(tabs).not.toMatch(/REFERENCES tabdump_groups \(workspace_id, id\) ON DELETE CASCADE/);
  });

  it("never puts ON DELETE SET NULL on a composite foreign key", () => {
    // This one is a genuine footgun rather than a style preference. SET NULL
    // on a multi-column foreign key nulls EVERY referencing column, and
    // workspace_id is NOT NULL on all of them — so the delete could never
    // succeed. The optional relationships use deferred NO ACTION instead.
    expect(SQL).not.toContain("ON DELETE SET NULL");
    for (const constraint of [
      "FOREIGN KEY (workspace_id, parent_id) REFERENCES tabdump_sections (workspace_id, id) DEFERRABLE INITIALLY DEFERRED",
      "FOREIGN KEY (workspace_id, section_id) REFERENCES tabdump_sections (workspace_id, id) DEFERRABLE INITIALLY DEFERRED",
      "FOREIGN KEY (workspace_id, group_id) REFERENCES tabdump_groups (workspace_id, id) DEFERRABLE INITIALLY DEFERRED",
    ]) {
      expect(SQL).toContain(constraint);
    }
  });

  it("keeps MATCH SIMPLE so an optional relationship may be absent", () => {
    // MATCH FULL would reject a root section (parent_id NULL) and an
    // unsectioned tab (section_id NULL) — both entirely normal.
    expect(SQL).not.toMatch(/MATCH FULL/i);
  });
});

describe("change ordering", () => {
  it("versions every syncable entity", () => {
    for (const table of ENTITY_TABLES) {
      expect(tableBody(table), table).toMatch(/sync_version\s+BIGINT NOT NULL/);
    }
  });

  it("keeps the counter on the workspace rather than in a global sequence", () => {
    // A bare SEQUENCE is not a safe cursor: nextval() is handed out before
    // commit, so a transaction holding version 5 can commit after one holding
    // 6 and a client that read past 6 would never see 5.
    expect(tableBody("tabdump_workspaces")).toMatch(/sync_counter\s+BIGINT NOT NULL/);
    expect(SQL).not.toMatch(/CREATE SEQUENCE/i);
  });

  it("indexes the changed-since query on every workspace-owned table", () => {
    // tabdump_workspaces is excluded on purpose: it has no workspace_id
    // column because it IS the workspace, and "has this workspace changed
    // since X" is a single-row lookup already served by its primary key.
    for (const table of CHILD_TABLES) {
      expect(SQL, table).toContain(`ON ${table} (workspace_id, sync_version)`);
    }
    expect(tableBody("tabdump_workspaces")).toMatch(/id UUID PRIMARY KEY/);
  });
});

describe("representation", () => {
  it("uses no JSONB anywhere", () => {
    // Per-object identity and per-object versions are the whole point; a
    // blob column would make "what changed" unanswerable.
    expect(SQL).not.toMatch(/\bJSONB?\b/i);
  });

  it("bounds every free-text column a client controls", () => {
    expect(tableBody("tabdump_tabs")).toContain("char_length(url) <= 4000");
    expect(tableBody("tabdump_tabs")).toContain("char_length(title) <= 2000");
    expect(tableBody("tabdump_tabs")).toContain("char_length(notes) <= 20000");
    for (const table of ["tabdump_workspaces", "tabdump_sections", "tabdump_groups", "tabdump_collections"]) {
      expect(tableBody(table), table).toContain("char_length(name) <= 200");
    }
  });

  it("restricts enumerated columns to the values the client can produce", () => {
    expect(tableBody("tabdump_sections")).toContain("source IN ('ai', 'user')");
    expect(tableBody("tabdump_tabs")).toContain("source IN ('tabs', 'history')");
    expect(tableBody("tabdump_tabs")).toContain(
      "organization_status IN ('classified', 'uncertain', 'fallback', 'manual')"
    );
    expect(tableBody("tabdump_dependencies")).toContain("'main-document'");
  });
});
