import type { Workspace } from "@/lib/workspace/types";
import type { Tab } from "@/lib/tabs/types";
import type { Collection } from "@/lib/collections/types";
import type { TabDependency } from "@/lib/dependencies/types";
import type { ManualConnection } from "@/lib/graph/types";
import type { AgentProject } from "@/lib/agents/control/projects";
import type { Agent, AgentRun } from "@/lib/agents/types";
import type { AgentContextWorld } from "../world";

/**
 * A deterministic two-workspace world.
 *
 * Every test in this directory resolves against this, which is what makes
 * "workspace B did not leak" a claim about a specific, readable fixture
 * rather than about whatever the test happened to build inline.
 *
 * ## The shape, and why each part is here
 *
 *   Workspace A ("Research")
 *     a1  docs.example.com    — in collection A-C1
 *     a2  docs.example.com    — in collection A-C1, same domain as a1
 *     a3  blog.example.org    — depends on a1
 *     a4  ring.example.net    — part of the cycle below
 *     a5  ring.example.net    — part of the cycle below
 *
 *   Workspace B ("Personal")
 *     b1  bank.example.com
 *     b2  mail.example.com
 *
 * - **a1/a2 share a domain**, so the canonical edge builder produces a real
 *   `domain` edge without the test having to fabricate one.
 * - **a3 → a1 is a dependency**, giving the relationship source something
 *   directional to resolve.
 * - **a1 → b1 is a cross-workspace dependency.** This is the fixture's most
 *   important row: it is the thing that must *not* let a request scoped to
 *   workspace A reach into workspace B.
 * - **a4 ↔ a5 ↔ a1 is a cycle** in the manual connections, so graph
 *   traversal is exercised against one rather than being assumed safe.
 * - **a2's URL carries a password and a token**, so redaction is exercised
 *   by every test that touches tabs, not only by the one that means to.
 */

export const T0 = 1_700_000_000_000;

function tab(over: Partial<Tab> & { id: string; url: string; domain: string }): Tab {
  return {
    normalizedUrl: over.url,
    createdAt: T0,
    ...over,
  };
}

export const TAB_A1 = tab({
  id: "a1",
  url: "https://docs.example.com/guide",
  domain: "docs.example.com",
  title: "Deployment guide",
  notes: "Ask ops before the Friday push",
});

/** Carries a credential in the userinfo AND a token in the query. Both must be gone. */
export const TAB_A2 = tab({
  id: "a2",
  url: "https://alice:hunter2@docs.example.com/api?access_token=sk-live-SECRET&page=2#id_token=eyJhbG",
  domain: "docs.example.com",
  title: "API reference",
});

export const TAB_A3 = tab({
  id: "a3",
  url: "https://blog.example.org/post",
  domain: "blog.example.org",
  title: "Why we moved off cron",
  lastAccessedAt: T0 + 5_000,
});

export const TAB_A4 = tab({
  id: "a4",
  url: "https://ring.example.net/one",
  domain: "ring.example.net",
  title: "Ring one",
});

export const TAB_A5 = tab({
  id: "a5",
  url: "https://ring.example.net/two",
  domain: "ring.example.net",
  title: "Ring two",
});

export const TAB_B1 = tab({
  id: "b1",
  url: "https://bank.example.com/accounts",
  domain: "bank.example.com",
  title: "Account overview",
  notes: "sort code 00-00-00",
});

export const TAB_B2 = tab({
  id: "b2",
  url: "https://mail.example.com/inbox",
  domain: "mail.example.com",
  title: "Inbox",
});

export const WORKSPACE_A: Workspace = {
  id: "ws-a",
  name: "Research",
  tabs: [TAB_A1, TAB_A2, TAB_A3, TAB_A4, TAB_A5],
  createdAt: T0,
  updatedAt: T0 + 1_000,
};

export const WORKSPACE_B: Workspace = {
  id: "ws-b",
  name: "Personal",
  tabs: [TAB_B1, TAB_B2],
  createdAt: T0,
  updatedAt: T0 + 2_000,
};

export const COLLECTION_A1: Collection = {
  id: "col-a1",
  workspaceId: "ws-a",
  name: "Docs to read",
  tabIds: ["a1", "a2"],
  createdAt: T0,
  updatedAt: T0,
};

export const COLLECTION_B1: Collection = {
  id: "col-b1",
  workspaceId: "ws-b",
  name: "Money",
  tabIds: ["b1"],
  createdAt: T0,
  updatedAt: T0,
};

/** a3 depends on a1. Wholly inside workspace A. */
export const DEP_WITHIN_A: TabDependency = {
  id: "dep-1",
  parentTabId: "a3",
  childTabId: "a1",
  type: "reference",
  createdAt: T0,
};

/**
 * a1 depends on b1 — across the workspace boundary.
 *
 * Hubble genuinely permits this (see `countRelationshipsByWorkspace`,
 * which counts such a dependency toward both workspaces), which is exactly
 * why the bridge has to decide what to do with one. It drops it.
 */
export const DEP_ACROSS_WORKSPACES: TabDependency = {
  id: "dep-2",
  parentTabId: "a1",
  childTabId: "b1",
  createdAt: T0,
};

/** a1 ↔ a4 ↔ a5 ↔ a1. A cycle, so traversal has to terminate on its own. */
export const CYCLE_CONNECTIONS: ManualConnection[] = [
  { a: "a1", b: "a4", createdAt: T0 },
  { a: "a4", b: "a5", createdAt: T0 },
  { a: "a5", b: "a1", createdAt: T0 },
];

export const PROJECT_A: AgentProject = {
  id: "proj-a",
  name: "API service",
  source: "local",
  path: "C:/work/api",
  providers: ["claude-code"],
  additionalDirectories: [],
  permissions: { scopes: [], grantedAt: T0 },
  createdAt: T0,
  updatedAt: T0,
};

export const PROJECT_B: AgentProject = {
  id: "proj-b",
  name: "Taxes",
  source: "local",
  path: "C:/work/taxes",
  providers: [],
  additionalDirectories: [],
  permissions: { scopes: [], grantedAt: T0 },
  createdAt: T0,
  updatedAt: T0,
};

export const AGENT_ONE: Agent = {
  id: "agent-1",
  provider: "claude-code",
  name: "Claude Code",
  createdAt: T0,
  updatedAt: T0,
};

export const RUN_IN_A: AgentRun = {
  id: "run-a",
  agentId: "agent-1",
  workspaceId: "ws-a",
  status: "completed",
  title: "Rework the deploy script",
  currentActivity: "Finished",
  createdAt: T0 + 10_000,
  updatedAt: T0 + 20_000,
  endedAt: T0 + 20_000,
};

export const RUN_IN_B: AgentRun = {
  id: "run-b",
  agentId: "agent-1",
  workspaceId: "ws-b",
  status: "working",
  title: "Sort the receipts",
  createdAt: T0 + 30_000,
  updatedAt: T0 + 30_000,
};

/**
 * The whole fixture.
 *
 * `ownerId` defaults to `"user-1"`. Pass a different one to build the
 * "same ids, other account" world the cross-account tests compare against.
 */
export function fixtureWorld(ownerId: string | null = "user-1"): AgentContextWorld {
  return {
    ownerId,
    workspaces: [WORKSPACE_A, WORKSPACE_B],
    collections: [COLLECTION_A1, COLLECTION_B1],
    dependencies: [DEP_WITHIN_A, DEP_ACROSS_WORKSPACES],
    manualConnections: CYCLE_CONNECTIONS,
    projects: [PROJECT_A, PROJECT_B],
    agents: [AGENT_ONE],
    runs: [RUN_IN_A, RUN_IN_B],
  };
}

/** A world with one workspace of `count` same-domain tabs, for the limit tests. */
export function largeWorld(count: number, ownerId: string | null = "user-1"): AgentContextWorld {
  const tabs: Tab[] = Array.from({ length: count }, (_, index) =>
    tab({
      id: `t${index}`,
      url: `https://bulk.example.com/${index}`,
      domain: "bulk.example.com",
      title: `Bulk tab ${index}`,
    })
  );

  return {
    ownerId,
    workspaces: [{ id: "ws-big", name: "Big", tabs, createdAt: T0, updatedAt: T0 }],
    collections: [],
    dependencies: [],
    manualConnections: [],
    projects: [],
    agents: [],
    runs: [],
  };
}

/** Scope helper: workspace A only, no projects. */
export function scopeA(ownerId: string | null = "user-1") {
  return { ownerId, workspaceIds: ["ws-a"], projectIds: [] };
}

/** Scope helper: workspace A plus project A. */
export function scopeAWithProject(ownerId: string | null = "user-1") {
  return { ownerId, workspaceIds: ["ws-a"], projectIds: ["proj-a"] };
}
