import type { Tab } from "@/lib/tabs/types";

/**
 * A precomputed tab-to-tab semantic grouping signal — the ONLY form
 * embeddings ever take once they leave the browser's IndexedDB for
 * Auto-Organize, mirroring src/lib/search/types.ts's SemanticHint (which is
 * query-relevance, not tab-to-tab). Two tabs sharing the same `clusterKey`
 * are semantically similar according to the client-side embedding
 * clustering in src/lib/ai/cluster.ts; the key itself is an opaque,
 * per-request id, never a vector. See AGENTS.md section 17: raw embeddings
 * must never reach the server.
 */
export type SemanticClusterHint = { tabId: string; clusterKey: string };

export type OrganizeConfidence = "high" | "medium" | "low";

/** One tab being proposed for a workspace (new or existing) or a group within it. */
export type OrganizeTabAssignment = {
  tabId: string;
  reason: string;
  confidence: OrganizeConfidence;
};

export type OrganizeGroupProposal = {
  proposedName: string;
  reason: string;
  /** Tabs that would conceptually belong in this group — descriptive only; see AGENTS.md section 13's scope note in apply.ts, since TabDump has no tab→group assignment action yet. */
  tabIds: string[];
};

export type OrganizeWorkspaceProposal = {
  /** Set when this cluster is being reused into an existing workspace rather than creating a new one — see match.ts. */
  existingWorkspaceId?: string;
  proposedName: string;
  reason: string;
  /**
   * Only tabs actually being MOVED into this workspace — a tab already
   * correctly placed there is left out entirely (see the invariant note on
   * OrganizationPlan below), not re-listed as a no-op assignment.
   */
  tabs: OrganizeTabAssignment[];
  groups?: OrganizeGroupProposal[];
};

/** A low-confidence tab the plan declines to place automatically — see AGENTS.md section 7. */
export type OrganizeUncertainTab = {
  tabId: string;
  reason: string;
  currentWorkspaceId: string;
  currentWorkspaceName: string;
  /** Candidate destinations to offer as quick-decision buttons in the review UI (e.g. [Keep] [Physics] [MUN] [Misc]). */
  suggestions: { workspaceId?: string; name: string }[];
};

export type OrganizeDuplicateGroup = {
  tabIds: string[];
  reason: string;
};

/**
 * The read-only output of analyzing a WorkspaceStore for Auto-Organize —
 * see src/lib/organize/analyze.ts. Never mutates anything itself (AGENTS.md
 * section 3).
 *
 * Completeness invariant: every tab considered is accounted for by being
 * EITHER (a) listed in some `workspaces[].tabs`/`groups[].tabIds` (it is
 * being moved/highlighted) OR (b) listed in `uncertainTabs` (the plan
 * declines to decide) OR (c) mentioned in neither, which means it is
 * already correctly placed and nothing needs to change for it. A tab may
 * never appear in more than one of these positions — see validate.ts, which
 * enforces this before a plan is ever shown to the user or applied.
 */
export type OrganizationPlan = {
  /** Deterministic, human-readable headline — see summarize.ts. */
  summary: string;
  workspaces: OrganizeWorkspaceProposal[];
  uncertainTabs: OrganizeUncertainTab[];
  duplicates: OrganizeDuplicateGroup[];
  totalTabsConsidered: number;
  /** Set when there's nothing meaningful to propose — see AGENTS.md section 18. When set, `workspaces`/`uncertainTabs` are empty and the UI shows this instead of a plan. */
  noopReason?: string;
};

/** Internal working shape used while clustering — never leaves analyze.ts's module boundary. */
export type ScopedTab = {
  tab: Tab;
  workspaceId: string;
  workspaceName: string;
};
