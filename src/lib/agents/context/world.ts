import type { Workspace } from "@/lib/workspace/types";
import type { Tab } from "@/lib/tabs/types";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { ManualConnection } from "@/lib/graph/types";
import type { AgentProject } from "@/lib/agents/control/projects";
import type { Agent, AgentRun } from "@/lib/agents/types";

/**
 * Everything the resolver is allowed to see, already loaded and already
 * partitioned by account.
 *
 * ## Why the resolver takes a world instead of reading storage
 *
 * Three separate reasons, and each on its own would be enough:
 *
 * 1. **A provider must never be able to query TabDump.** If the resolver
 *    reached into `localStorage` itself, then anything holding a resolver —
 *    including, eventually, an adapter — would transitively hold a way to
 *    read the whole store. Taking the data as an argument means the caller
 *    decides what exists, and `security.test.ts` asserts that nothing under
 *    `context/` imports a persistence module.
 *
 * 2. **Account partitioning happens at load, not at read.** TabDump scopes
 *    local data by storage key prefix (`lib/storage/namespace.ts`), so by
 *    the time a `Workspace` is in memory, nothing about it says whose it is.
 *    `ownerId` here is the caller stating which account this data came from,
 *    and the resolver refuses a request whose scope names a different one.
 *    That is what makes cross-account resolution a checked failure rather
 *    than an assumption.
 *
 * 3. **A snapshot must be reproducible.** Resolving twice from the same
 *    world gives the same answer, which is what makes the resolver testable
 *    against fixtures at all.
 *
 * ## Read-only by type, and deliberately not defensive-copied
 *
 * Every array is `readonly` and every index is a `ReadonlyMap`. The world is
 * not cloned: a workspace can hold thousands of tabs and copying them to
 * resolve five would be a real cost for a guarantee the type system already
 * gives. The resolver never writes, and its tests assert the world is
 * unchanged afterwards.
 */
export type AgentContextWorld = {
  /** The account this data was loaded under. `null` when signed out. */
  ownerId: string | null;
  workspaces: readonly Workspace[];
  collections: readonly Collection[];
  dependencies: readonly TabDependency[];
  manualConnections: readonly ManualConnection[];
  /** Authorized local projects. Metadata only ever leaves here — see `ProjectContextItem`. */
  projects: readonly AgentProject[];
  agents: readonly Agent[];
  runs: readonly AgentRun[];
};

/**
 * The lookups resolution needs, built once.
 *
 * Without these, resolving one tab id is a scan of every workspace's tab
 * array, and resolving a hundred is a hundred scans — which is the
 * accidental O(account-size × request-size) the performance requirement
 * warns about. Building the indexes is one pass over the same data.
 */
export type AgentContextIndex = {
  world: AgentContextWorld;
  workspaceById: ReadonlyMap<string, Workspace>;
  tabById: ReadonlyMap<string, Tab>;
  /** Which workspace currently holds a tab. The membership check every scope test runs. */
  workspaceIdOfTab: ReadonlyMap<string, string>;
  collectionById: ReadonlyMap<string, Collection>;
  /** Collections a tab belongs to. */
  collectionIdsOfTab: ReadonlyMap<string, readonly string[]>;
  /** Dependencies touching a tab, in either direction. */
  dependenciesOfTab: ReadonlyMap<string, readonly TabDependency[]>;
  projectById: ReadonlyMap<string, AgentProject>;
  agentById: ReadonlyMap<string, Agent>;
  /** Runs per workspace, newest first. */
  runsByWorkspace: ReadonlyMap<string, readonly AgentRun[]>;
};

/** An empty world. The starting point for fixtures, and the honest state before anything is loaded. */
export function emptyContextWorld(ownerId: string | null = null): AgentContextWorld {
  return {
    ownerId,
    workspaces: [],
    collections: [],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  };
}

function pushInto<K, V>(map: Map<K, V[]>, key: K, value: V): void {
  const existing = map.get(key);
  if (existing) existing.push(value);
  else map.set(key, [value]);
}

/**
 * Builds the indexes above in one pass per collection.
 *
 * Note what happens to a dangling id — a collection naming a tab that no
 * longer exists, a run naming a deleted workspace. Nothing. It stays in the
 * index and is caught at resolution time as `not-found`, which is the
 * honest report. Filtering here instead would make a deleted entity
 * indistinguishable from one that was never asked for.
 */
export function indexContextWorld(world: AgentContextWorld): AgentContextIndex {
  const workspaceById = new Map<string, Workspace>();
  const tabById = new Map<string, Tab>();
  const workspaceIdOfTab = new Map<string, string>();

  for (const workspace of world.workspaces) {
    workspaceById.set(workspace.id, workspace);
    for (const tab of workspace.tabs) {
      tabById.set(tab.id, tab);
      workspaceIdOfTab.set(tab.id, workspace.id);
    }
  }

  const collectionById = new Map<string, Collection>();
  const collectionIdsOfTab = new Map<string, string[]>();
  for (const collection of world.collections) {
    collectionById.set(collection.id, collection);
    for (const tabId of collection.tabIds) pushInto(collectionIdsOfTab, tabId, collection.id);
  }

  const dependenciesOfTab = new Map<string, TabDependency[]>();
  for (const dependency of world.dependencies) {
    pushInto(dependenciesOfTab, dependency.parentTabId, dependency);
    // A self-dependency is malformed data rather than two edges; recording
    // it twice would make the same row resolve into two relationship items.
    if (dependency.childTabId !== dependency.parentTabId) {
      pushInto(dependenciesOfTab, dependency.childTabId, dependency);
    }
  }

  const projectById = new Map<string, AgentProject>();
  for (const project of world.projects) projectById.set(project.id, project);

  const agentById = new Map<string, Agent>();
  for (const agent of world.agents) agentById.set(agent.id, agent);

  const runsByWorkspace = new Map<string, AgentRun[]>();
  for (const run of world.runs) pushInto(runsByWorkspace, run.workspaceId, run);
  for (const runs of runsByWorkspace.values()) {
    runs.sort((a, b) => b.createdAt - a.createdAt || a.id.localeCompare(b.id));
  }

  return {
    world,
    workspaceById,
    tabById,
    workspaceIdOfTab,
    collectionById,
    collectionIdsOfTab,
    dependenciesOfTab,
    projectById,
    agentById,
    runsByWorkspace,
  };
}
