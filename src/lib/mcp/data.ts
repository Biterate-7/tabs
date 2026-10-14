import { applyChanges } from "@/lib/sync/apply";
import { SYNC_CURSOR_START } from "@/lib/sync/types";
import type { LocalSyncState } from "@/lib/sync/apply";
import type { SyncChangesPage, SyncCursor, WorkspaceSyncPayload } from "@/lib/sync/types";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { Workspace } from "@/lib/workspace/types";

/**
 * What the MCP server reads, and from where.
 *
 * ## Account-synced data, and only that
 *
 * Hubble is local-first: a signed-out user's workspaces live in one
 * browser's storage and no server has them. What a server *does* hold is the
 * account copy the sync engine maintains (src/lib/sync), keyed by account.
 * That is the whole of what an MCP client can see, and it is the right
 * boundary — the server can only disclose what the user already chose to
 * give it.
 *
 * ## The same hydration the app performs
 *
 * A workspace is rebuilt exactly as a device adopting it does: seed from the
 * owner-scoped workspace row, then replay `SyncService.pull` pages through
 * the client's own `applyChanges`. No second parser of sync rows exists to
 * drift from the first.
 *
 * ## Ownership
 *
 * Every read takes the user id, and both underlying reads fold it into their
 * queries: `listWorkspaces(userId)` and `pull(workspaceId, userId, …)`, which
 * answers null for a workspace the user does not own. A workspace id alone
 * is never sufficient, and "not yours" is indistinguishable from "absent".
 */

/** The two sync reads this needs — `SyncService` satisfies it. */
export type SyncReader = {
  listWorkspaces(userId: string): Promise<WorkspaceSyncPayload[]>;
  pull(workspaceId: string, userId: string, cursor: SyncCursor): Promise<SyncChangesPage | null>;
};

export type McpWorkspaceSummary = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

export type McpLoadedWorkspace = {
  workspace: Workspace;
  collections: Collection[];
  dependencies: TabDependency[];
  /** True when the workspace was larger than one hydration may read. */
  truncated: boolean;
};

export type HubbleMcpData = {
  listWorkspaces(userId: string): Promise<McpWorkspaceSummary[]>;
  loadWorkspace(userId: string, workspaceId: string): Promise<McpLoadedWorkspace | undefined>;
};

/**
 * Pages one hydration may read — 20 × 500 = 10,000 entities.
 *
 * A bound on the work one tool call can cause. The resolver's own limits cut
 * the *answer* far below this; this cuts the *reading*.
 */
export const MAX_HYDRATION_PAGES = 20;

/** Most workspaces `list_workspaces` returns. */
export const MAX_LISTED_WORKSPACES = 50;

export function createSyncMcpData(deps: { sync: SyncReader }): HubbleMcpData {
  return {
    async listWorkspaces(userId) {
      const rows = await deps.sync.listWorkspaces(userId);
      return rows
        .slice(0, MAX_LISTED_WORKSPACES)
        .map((row) => ({ id: row.id, name: row.name, createdAt: row.createdAt, updatedAt: row.updatedAt }));
    },

    async loadWorkspace(userId, workspaceId) {
      const row = (await deps.sync.listWorkspaces(userId)).find((entry) => entry.id === workspaceId);
      if (!row) return undefined;

      // The seed a device adopting this workspace starts from. No logo: it is
      // a data URL, it is not context, and the resolver never reads it.
      let state: LocalSyncState = {
        workspace: { id: row.id, name: row.name, tabs: [], createdAt: row.createdAt, updatedAt: row.updatedAt },
        collections: [],
        dependencies: [],
      };

      let cursor: SyncCursor = SYNC_CURSOR_START;
      let hasMore = true;
      let pages = 0;

      while (hasMore && pages < MAX_HYDRATION_PAGES) {
        const page = await deps.sync.pull(workspaceId, userId, cursor);
        // Ownership re-checked by the pull itself; a workspace that changed
        // hands between the two reads is simply not found.
        if (!page) return undefined;

        const result = applyChanges(state, page.changes);
        if (result.workspaceDeleted) return undefined;

        state = result.state;
        cursor = page.nextCursor;
        hasMore = page.hasMore;
        pages += 1;
      }

      return {
        workspace: { ...state.workspace, logo: undefined },
        collections: state.collections,
        dependencies: state.dependencies,
        truncated: hasMore,
      };
    },
  };
}
