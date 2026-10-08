import { buildTabsFromBrowserImport } from "@/lib/tabs/browser-import";
import { markDuplicates } from "@/lib/tabs/duplicates";
import { detectResourceType } from "./detect";
import { resourceKey } from "./url";
import type { Tab } from "@/lib/tabs/types";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { ResourceInput, ResourceKind, ResourceOrigin, TabResource } from "./types";

/**
 * The one way anything becomes a project source.
 *
 * A Chrome drop, the extension's "Add to project", the Add source dialog, an
 * uploaded PDF and an existing saved tab all arrive here as `ResourceInput`s
 * and leave as tabs carrying a `resource` — so validation, duplicate
 * detection and classification are the same whichever door a source came in
 * through. Pure: the caller commits the store it returns and starts
 * processing; nothing here reads a clock it was not given or touches storage.
 *
 * Per input, exactly one outcome — a batch never fails as a whole, so four
 * good links and one bad one add four sources and say why the fifth wasn't.
 */

export type IngestOutcome =
  | { status: "added"; input: ResourceInput; tabId: string; kind: ResourceKind }
  /** The address was already saved in this project as a plain tab; it is now a source. */
  | { status: "adopted"; input: ResourceInput; tabId: string; kind: ResourceKind }
  /** Already a source in this project — nothing was added. */
  | { status: "duplicate"; input: ResourceInput; tabId: string }
  | { status: "invalid"; input: ResourceInput; reason: "not-a-url" | "unsupported-scheme" };

export type IngestionPlan = {
  workspaceId: string;
  /** New tabs, in input order. */
  added: Tab[];
  /** Existing plain tabs that become sources, by id. */
  adopted: string[];
  outcomes: IngestOutcome[];
};

export const MAX_INGEST_BATCH = 200;

export function newResource(kind: ResourceKind, origin: ResourceOrigin, now: number, mimeType?: string): TabResource {
  return { kind, origin, status: "pending", addedAt: now, updatedAt: now, ...(mimeType ? { meta: { mimeType } } : {}) };
}

export function isSource(tab: Pick<Tab, "resource">): boolean {
  return tab.resource !== undefined;
}

export function projectSources(workspace: Pick<Workspace, "tabs">): Tab[] {
  return workspace.tabs.filter(isSource);
}

/** Non-http(s) addresses a browser can still drag: its own pages, local files, data. */
function invalidReason(url: string): "not-a-url" | "unsupported-scheme" {
  return /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) && !/^https?:/i.test(url.trim()) ? "unsupported-scheme" : "not-a-url";
}

export function planIngestion(input: {
  workspace: Pick<Workspace, "id" | "tabs">;
  inputs: readonly ResourceInput[];
  origin: ResourceOrigin;
  now: number;
}): IngestionPlan {
  const { workspace, origin, now } = input;
  const byKey = new Map<string, Tab>();
  for (const tab of workspace.tabs) {
    const key = resourceKey(tab.url);
    // A source wins over a plain tab with the same address: it is what a duplicate should point at.
    if (key && (!byKey.has(key) || (tab.resource && !byKey.get(key)!.resource))) byKey.set(key, tab);
  }

  const added: Tab[] = [];
  const adopted: string[] = [];
  const outcomes: IngestOutcome[] = [];

  for (const raw of input.inputs.slice(0, MAX_INGEST_BATCH)) {
    const entry: ResourceInput = { ...raw, url: raw.url.trim() };
    const [tab] = buildTabsFromBrowserImport([
      { url: entry.url, ...(entry.title ? { title: entry.title } : {}), ...(entry.favicon ? { favicon: entry.favicon } : {}) },
    ]);
    const key = tab ? resourceKey(tab.url) : undefined;
    if (!tab || !key) {
      outcomes.push({ status: "invalid", input: entry, reason: invalidReason(entry.url) });
      continue;
    }

    const existing = byKey.get(key);
    if (existing?.resource) {
      outcomes.push({ status: "duplicate", input: entry, tabId: existing.id });
      continue;
    }
    const kind = detectResourceType({ url: tab.url, ...(entry.mimeType ? { mimeType: entry.mimeType } : {}) });
    if (existing) {
      adopted.push(existing.id);
      // Later inputs with the same address are duplicates of the adopted source.
      byKey.set(key, { ...existing, resource: newResource(kind, origin, now, entry.mimeType) });
      outcomes.push({ status: "adopted", input: entry, tabId: existing.id, kind });
      continue;
    }

    const source: Tab = { ...tab, resource: newResource(kind, origin, now, entry.mimeType) };
    added.push(source);
    byKey.set(key, source);
    outcomes.push({ status: "added", input: entry, tabId: source.id, kind });
  }

  return { workspaceId: workspace.id, added, adopted, outcomes };
}

/** The store with a plan applied: new sources appended, adopted tabs marked. The same store when the plan changes nothing. */
export function applyIngestion(store: WorkspaceStore, plan: IngestionPlan, origin: ResourceOrigin, now: number): WorkspaceStore {
  if (plan.added.length === 0 && plan.adopted.length === 0) return store;
  const adoptedKinds = new Map(
    plan.outcomes.filter((outcome) => outcome.status === "adopted").map((outcome) => [outcome.tabId, outcome] as const)
  );
  let changed = false;
  const workspaces = store.workspaces.map((workspace) => {
    if (workspace.id !== plan.workspaceId) return workspace;
    changed = true;
    const tabs = workspace.tabs.map((tab) => {
      const outcome = adoptedKinds.get(tab.id);
      if (!outcome || tab.resource || outcome.status !== "adopted") return tab;
      return { ...tab, resource: newResource(outcome.kind, origin, now, outcome.input.mimeType), updatedAt: now };
    });
    return { ...workspace, tabs: markDuplicates([...tabs, ...plan.added]), updatedAt: now };
  });
  return changed ? { ...store, workspaces } : store;
}

/** Plan and apply in one step — what every ingestion surface calls. */
export function ingestResources(
  store: WorkspaceStore,
  workspaceId: string,
  inputs: readonly ResourceInput[],
  origin: ResourceOrigin,
  now: number
): { store: WorkspaceStore; plan: IngestionPlan } | null {
  const workspace = store.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return null;
  const plan = planIngestion({ workspace, inputs, origin, now });
  return { store: applyIngestion(store, plan, origin, now), plan };
}

/** Existing saved tabs of a project, made sources of it — the path from a tab dump to project context. */
export function adoptTabsAsSources(store: WorkspaceStore, workspaceId: string, tabIds: readonly string[], now: number) {
  const workspace = store.workspaces.find((entry) => entry.id === workspaceId);
  if (!workspace) return null;
  const wanted = new Set(tabIds);
  const inputs = workspace.tabs
    .filter((tab) => wanted.has(tab.id))
    .map((tab) => ({ url: tab.url, ...(tab.title ? { title: tab.title } : {}) }));
  return ingestResources(store, workspaceId, inputs, "import", now);
}

/** Counts for the project home and the composer. */
/**
 * A source that is saved and fine, whose content the site keeps to people
 * signed in or browsing themselves (a bot wall, a login). There is nothing
 * to fix — no file to upload, no transcript to add — so it is never counted
 * as needing attention.
 */
export function isContentUnavailable(resource: Pick<TabResource, "status" | "error"> | undefined): boolean {
  return resource?.status === "partial" && resource.error?.code === "blocked";
}

/** Failed, or saved without content for a reason the person can do something about. */
export function needsAttention(resource: Pick<TabResource, "status" | "error"> | undefined): boolean {
  return resource?.status === "failed" || (resource?.status === "partial" && !isContentUnavailable(resource));
}

export function sourceCounts(workspace: Pick<Workspace, "tabs">) {
  const counts = { total: 0, ready: 0, partial: 0, failed: 0, working: 0, attention: 0, byKind: {} as Partial<Record<ResourceKind, number>> };
  for (const tab of workspace.tabs) {
    const resource = tab.resource;
    if (!resource) continue;
    counts.total += 1;
    counts.byKind[resource.kind] = (counts.byKind[resource.kind] ?? 0) + 1;
    if (resource.status === "ready") counts.ready += 1;
    else if (resource.status === "partial") counts.partial += 1;
    else if (resource.status === "failed") counts.failed += 1;
    else counts.working += 1;
    if (needsAttention(resource)) counts.attention += 1;
  }
  return counts;
}

/** Summary of a batch in words: "4 added · 1 already in History IA · 1 couldn't be added". */
export function describeIngestion(plan: Pick<IngestionPlan, "outcomes">) {
  const added = plan.outcomes.filter((outcome) => outcome.status === "added" || outcome.status === "adopted").length;
  const duplicates = plan.outcomes.filter((outcome) => outcome.status === "duplicate").length;
  const invalid = plan.outcomes.filter((outcome) => outcome.status === "invalid").length;
  return { added, duplicates, invalid };
}
