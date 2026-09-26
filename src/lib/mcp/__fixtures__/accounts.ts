import { SYNC_CURSOR_START } from "@/lib/sync/types";
import { createMemoryRemoteStore } from "@/lib/agents/remote/store";
import { createSyncMcpData } from "../data";
import type { SyncChange, SyncChangesPage, WorkspaceSyncPayload } from "@/lib/sync/types";
import type { SyncReader, HubbleMcpData } from "../data";
import type { RemoteStore } from "@/lib/agents/remote/store";

/**
 * Two accounts' synced Hubble data, as sync change pages.
 *
 * Built as the server stores it — `SyncChange` upserts — so the MCP loader is
 * exercised through the real `applyChanges` hydration, not handed domain
 * objects it never has to build.
 *
 * The secrets below are deliberately planted. Every one of them must be
 * absent from anything the MCP server returns.
 */

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";

export const ALICE_RESEARCH = "aaaaaaaa-0000-4000-8000-000000000001";
export const ALICE_OTHER = "aaaaaaaa-0000-4000-8000-000000000002";
export const BOB_PRIVATE = "bbbbbbbb-0000-4000-8000-000000000001";

export const TAB_DOCS = "aaaaaaaa-1111-4000-8000-000000000001";
export const TAB_SECRET_URL = "aaaaaaaa-1111-4000-8000-000000000002";
export const TAB_WITH_NOTE = "aaaaaaaa-1111-4000-8000-000000000003";
export const BOB_TAB = "bbbbbbbb-1111-4000-8000-000000000001";

export const COLLECTION_READING = "aaaaaaaa-2222-4000-8000-000000000001";

/** Planted in a URL: userinfo, a secret query value, and an implicit-OAuth fragment. */
export const PLANTED_URL_SECRETS = ["hunter2", "sk-live-PLANTED-9f8e7d", "PLANTED_FRAGMENT_TOKEN"] as const;
export const PLANTED_NOTE = "PLANTED private note: door code 4711";
export const BOB_WORKSPACE_NAME = "Bob's Private Planning";
export const BOB_TAB_TITLE = "Bob confidential roadmap";

const T = 1_700_000_000_000;

function ws(id: string, name: string): WorkspaceSyncPayload {
  return { id, name, createdAt: T, updatedAt: T };
}

/** `Omit` applied to each member of a union, rather than to the union as a whole. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;

function upsert(
  workspaceId: string,
  cursor: number,
  change: DistributiveOmit<Extract<SyncChange, { operation: "upsert" }>, "operation" | "workspaceId" | "cursor">
): SyncChange {
  return { operation: "upsert", workspaceId, cursor: String(cursor), ...change } as SyncChange;
}

function aliceResearchChanges(): SyncChange[] {
  const id = ALICE_RESEARCH;
  return [
    upsert(id, 1, { entityType: "workspace", entityId: id, entity: ws(id, "Research") }),
    upsert(id, 2, {
      entityType: "tab",
      entityId: TAB_DOCS,
      entity: { id: TAB_DOCS, url: "https://docs.example.com/guide", title: "Example Docs — Guide", createdAt: T, updatedAt: T },
    }),
    upsert(id, 3, {
      entityType: "tab",
      entityId: TAB_SECRET_URL,
      entity: {
        id: TAB_SECRET_URL,
        url: `https://alice:${PLANTED_URL_SECRETS[0]}@api.example.com/callback?api_key=${PLANTED_URL_SECRETS[1]}&page=2#access_token=${PLANTED_URL_SECRETS[2]}`,
        title: "API callback",
        createdAt: T,
        updatedAt: T,
      },
    }),
    upsert(id, 4, {
      entityType: "tab",
      entityId: TAB_WITH_NOTE,
      entity: { id: TAB_WITH_NOTE, url: "https://notes.example.org/page", title: "Noted page", notes: PLANTED_NOTE, createdAt: T, updatedAt: T },
    }),
    upsert(id, 5, {
      entityType: "collection",
      entityId: COLLECTION_READING,
      entity: { id: COLLECTION_READING, name: "Test Context", tabIds: [TAB_DOCS, TAB_SECRET_URL], createdAt: T, updatedAt: T },
    }),
    upsert(id, 6, {
      entityType: "dependency",
      parentTabId: TAB_DOCS,
      childTabId: TAB_SECRET_URL,
      entity: { parentTabId: TAB_DOCS, childTabId: TAB_SECRET_URL, type: "reference", createdAt: T },
    }),
  ];
}

function bobChanges(): SyncChange[] {
  const id = BOB_PRIVATE;
  return [
    upsert(id, 1, { entityType: "workspace", entityId: id, entity: ws(id, BOB_WORKSPACE_NAME) }),
    upsert(id, 2, {
      entityType: "tab",
      entityId: BOB_TAB,
      entity: { id: BOB_TAB, url: "https://bob.example.net/roadmap", title: BOB_TAB_TITLE, createdAt: T, updatedAt: T },
    }),
  ];
}

type Account = { workspaces: WorkspaceSyncPayload[]; changes: Map<string, SyncChange[]> };

const ACCOUNTS: Record<string, () => Account> = {
  [ALICE]: () => ({
    workspaces: [ws(ALICE_RESEARCH, "Research"), ws(ALICE_OTHER, "Other")],
    changes: new Map([
      [ALICE_RESEARCH, aliceResearchChanges()],
      [ALICE_OTHER, [upsert(ALICE_OTHER, 1, { entityType: "workspace", entityId: ALICE_OTHER, entity: ws(ALICE_OTHER, "Other") })]],
    ]),
  }),
  [BOB]: () => ({
    workspaces: [ws(BOB_PRIVATE, BOB_WORKSPACE_NAME)],
    changes: new Map([[BOB_PRIVATE, bobChanges()]]),
  }),
};

/**
 * A `SyncReader` with `SyncService`'s ownership semantics: `pull` answers
 * null for a workspace the user does not own, and pages `pageSize` at a time.
 */
export function createFixtureSyncReader(pageSize = 500): SyncReader & { pulls: { workspaceId: string; userId: string }[] } {
  const pulls: { workspaceId: string; userId: string }[] = [];
  return {
    pulls,
    async listWorkspaces(userId) {
      return ACCOUNTS[userId]?.().workspaces ?? [];
    },
    async pull(workspaceId, userId, cursor): Promise<SyncChangesPage | null> {
      pulls.push({ workspaceId, userId });
      const changes = ACCOUNTS[userId]?.().changes.get(workspaceId);
      if (!changes) return null;
      const start = cursor === SYNC_CURSOR_START ? 0 : Number(cursor);
      const page = changes.slice(start, start + pageSize);
      const next = start + page.length;
      return { workspaceId, changes: page, nextCursor: String(next), hasMore: next < changes.length };
    },
  };
}

export async function createFixtureRemoteStore(): Promise<RemoteStore> {
  const store = createMemoryRemoteStore();
  for (const [owner, name, projectId, sessionId] of [
    [ALICE, "Alice test project", "rp-alice", "rs-alice"],
    [BOB, "Bob hidden project", "rp-bob", "rs-bob"],
  ] as const) {
    await store.createProject({
      id: projectId,
      ownerId: `account:${owner}`,
      name,
      source: "remote_upload",
      sandboxName: `tabdump-sandbox-${projectId}-PLANTED`,
      scopes: ["read_project"],
      status: "ready",
      createdAt: T,
      updatedAt: T,
    });
    await store.createSession({
      id: sessionId,
      ownerId: `account:${owner}`,
      projectId,
      provider: "claude-code",
      sandboxName: `tabdump-sandbox-${projectId}-PLANTED`,
      commandId: "cmd-PLANTED",
      providerSessionId: "provider-session-PLANTED",
      createdAt: T,
      updatedAt: T,
    });
  }
  return store;
}

export async function createFixtureData(): Promise<HubbleMcpData> {
  return createSyncMcpData({ sync: createFixtureSyncReader(), remote: await createFixtureRemoteStore() });
}
