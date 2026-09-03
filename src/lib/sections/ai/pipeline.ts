import { computeSemanticClusterHints } from "@/lib/ai/cluster";
import { buildRawClusters } from "@/lib/organize/cluster";
import { canonicalSiteIdentity, getDomainSectionName, isGenericSiteIdentity } from "@/lib/organize/domain-identity";
import { deriveSectionName, tabTokens, tokenOverlap, tokenize } from "@/lib/organize/keywords";
import type { ScopedTab, SemanticClusterHint } from "@/lib/organize/types";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "../types";
import { buildClusterManifest } from "./manifest";
import type { ClusterManifestEntry } from "./manifest";
import {
  categoryNameOf,
  deepestExistingPrefix,
  fullPathAlreadyExists,
  NEW_SECTION_SCORE_THRESHOLD,
  organizeTabsIntoSections,
  placeAtPath,
  sanitizeReason,
} from "./organize";
import type { OrganizeResult } from "./organize";
import { buildClusterOrganizePrompt } from "./prompt";
import type { OrganizeClusterAssignment, OrganizeClusterInput } from "./prompt";
import { requestOrganizeCompletion } from "./client";
import { buildOrganizeReport, emptyReport } from "./report";
import type { OrganizeReport } from "./report";

/** Keeps a cluster-manifest prompt comfortably under MAX_PROMPT_CHARS (src/app/api/ai/organize/route.ts) even for a very large, highly-fragmented dump — a large drop from organize.ts's MAX_CHUNK_TABS=40 since each entry here already summarizes a whole cluster, not one tab. */
const MAX_CHUNK_CLUSTERS = 60;
/** A confident cluster needs at least this many tabs — mirrors organize.ts's MEDIUM_CONFIDENCE_MIN_AGREEING: two tabs already agreeing (here, via shared semantic/domain/keyword signal) is corroboration enough to send to the AI as a unit. Below this, a cluster is a singleton and goes through Stage F instead. */
const MIN_CONFIDENT_CLUSTER_SIZE = 2;
/** How much token overlap a leftover singleton needs with an already-placed cluster's own tabs to be folded into that cluster's path without a further AI call — mirrors src/lib/organize/analyze.ts's FIT_THRESHOLD for the identical "fold a leftover into an existing group" problem, tuned slightly higher since a Section placement is more consequential than a workspace-move suggestion. */
const FOLD_OVERLAP_THRESHOLD = 0.15;

export type PipelineResult = OrganizeResult & { report: OrganizeReport };

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function validateClusterAssignments(data: unknown, validIds: Set<string>): Map<string, OrganizeClusterAssignment> {
  const map = new Map<string, OrganizeClusterAssignment>();
  if (!Array.isArray(data)) return map;

  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const clusterId = typeof e.clusterId === "string" ? e.clusterId : undefined;
    if (!clusterId || !validIds.has(clusterId) || map.has(clusterId)) continue;
    if (!Array.isArray(e.path)) continue;
    const path = e.path
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, 3);
    if (path.length === 0) continue;
    const confidence = e.confidence === "high" || e.confidence === "medium" || e.confidence === "low" ? e.confidence : "low";
    const reason = typeof e.reason === "string" ? e.reason : "";
    map.set(clusterId, { clusterId, path, confidence, reason });
  }
  return map;
}

function mostCommonCategoryName(tabs: Tab[]): string {
  const counts = new Map<string, number>();
  for (const t of tabs) counts.set(categoryNameOf(t), (counts.get(categoryNameOf(t)) ?? 0) + 1);
  return [...counts.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "Other";
}

/** Never proposes "Other" as a root — mirrors organize.ts's fallbackOrganize: a genuine cluster found among "other"-categorized tabs is promoted straight to its own named root instead of nesting under a parent that would just fail to create. Naming goes through deriveSectionName, so a strong domain cluster (14 Instagram tabs) always gets its real brand name rather than whatever title token happens to be most frequent. */
function deterministicPath(members: Tab[]): string[] {
  const dominantCategory = mostCommonCategoryName(members);
  const derivedName = deriveSectionName(members);
  return dominantCategory === "Other" ? [derivedName] : [dominantCategory, derivedName];
}

/**
 * Evidence score for actually CREATING the new section(s) a cluster's
 * proposed path requires — the cluster-level counterpart to organize.ts's
 * newSectionEvidenceScore, using the cluster's own size (already
 * corroborated by the union-find clustering step, potentially across
 * several signals) as the dominant factor instead of within-batch
 * agreement, plus smaller pushes from an already-existing parent, from the
 * cluster's own sample titles actually containing the proposed name, and
 * from the model's confidence.
 */
function clusterEvidenceScore(entry: ClusterManifestEntry, assignment: OrganizeClusterAssignment, sections: Section[]): number {
  let score = entry.size >= MIN_CONFIDENT_CLUSTER_SIZE ? 4 : 1;
  if (entry.dominantJoinReason === "semantic") score += 2;
  // A cluster with strong, majority domain coherence (AGENTS.md's LEVEL 1/2
  // evidence hierarchy: "3+ tabs sharing the same meaningful website/product
  // identity" or "4+ sharing a clear topic") is at least as strong evidence
  // for creating a section as semantic agreement — a real website cluster
  // doesn't need semantic similarity between individual pages to be valid.
  else if (entry.dominantJoinReason === "domain") score += (entry.domainShare ?? 0) >= 0.6 ? 2 : 1;

  if (assignment.path.length > 1) {
    const existingPrefixLen = deepestExistingPrefix(sections, assignment.path).length;
    if (existingPrefixLen >= assignment.path.length - 1) score += 1;
  }

  const leafName = assignment.path[assignment.path.length - 1] ?? "";
  const sampleTokens = entry.sampleTitles.flatMap((t) => tokenize(t));
  if (tokenOverlap(tokenize(leafName), sampleTokens) >= 0.2) score += 1;

  if (assignment.confidence === "high") score += 1;

  return score;
}

type ClusterApplyResult = { tabs: Tab[]; sections: Section[]; path: string[] };

/**
 * Applies one cluster's assignment (or, absent one, the same deterministic
 * naming organize.ts's fallbackOrganize uses) to every member tab at once —
 * the pipeline's Stage E. Reuses placeAtPath/fullPathAlreadyExists/
 * deepestExistingPrefix from organize.ts unchanged, so a cluster's path
 * reuses an existing sibling exactly the same way a single tab's would
 * (spec §14/§20's "Physics" vs "Physics Research" collapsing into one).
 */
function applyClusterEntry(
  entry: ClusterManifestEntry,
  assignment: OrganizeClusterAssignment | undefined,
  tabsById: Map<string, Tab>,
  sections: Section[]
): ClusterApplyResult {
  const members = entry.tabIds.map((id) => tabsById.get(id)).filter((t): t is Tab => Boolean(t));
  let working = sections;

  function placeAllAt(path: string[], status: Tab["organizationStatus"], reason: string | undefined): Tab[] {
    const out: Tab[] = [];
    for (const tab of members) {
      const { tab: placed, sections: next } = placeAtPath(tab, working, path, "ai");
      working = next;
      out.push({ ...placed, organizationStatus: placed.sectionId ? status : "uncertain", ...(reason ? { organizationReason: reason } : {}) });
    }
    return out;
  }

  if (!assignment) {
    const path = deterministicPath(members);
    const reason = `Shares a topic with ${members.length - 1} other tab${members.length === 2 ? "" : "s"} in this dump.`;
    return { tabs: placeAllAt(path, "fallback", members.length > 1 ? reason : undefined), sections: working, path };
  }

  const reason = sanitizeReason(assignment.reason);

  if (fullPathAlreadyExists(working, assignment.path)) {
    return { tabs: placeAllAt(assignment.path, "classified", reason), sections: working, path: assignment.path };
  }

  if (assignment.confidence !== "low") {
    const score = assignment.path.length > 1 ? clusterEvidenceScore(entry, assignment, working) : NEW_SECTION_SCORE_THRESHOLD;
    if (score >= NEW_SECTION_SCORE_THRESHOLD) {
      return { tabs: placeAllAt(assignment.path, "classified", reason), sections: working, path: assignment.path };
    }
  }

  // Low confidence, or a multi-segment path that didn't clear the evidence
  // bar — reuse the deepest existing ancestor rather than inventing
  // anything (mirrors organize.ts's placeAtSafestExisting). If nothing
  // exists yet, fall through to the same deterministic naming the
  // no-assignment branch uses rather than ever leaving the cluster unplaced.
  const existingPrefix = deepestExistingPrefix(working, assignment.path);
  if (existingPrefix.length > 0) {
    return { tabs: placeAllAt(existingPrefix, "uncertain", reason), sections: working, path: existingPrefix };
  }
  const path = deterministicPath(members);
  return { tabs: placeAllAt(path, "fallback", reason), sections: working, path };
}

/**
 * The categorization pipeline (see spec: replaces classifying tabs one
 * chunk-of-40 at a time with clustering the WHOLE dump first, then having
 * the AI name the resulting clusters):
 *
 * A. Cluster every unlocked tab collectively via src/lib/organize/cluster.ts's
 *    buildRawClusters (semantic + domain + keyword signals, union-find over
 *    the entire batch at once — not a chunk of it).
 * C. Compress confident clusters (size >= 2) into a compact manifest.
 * D. Ask the AI to name/place each cluster (a few dozen entries, not
 *    hundreds of tabs — fits in 1-2 requests instead of ~15).
 * E. Apply each cluster's path to all of its member tabs.
 * F. Singletons left over after A: fold into an already-placed cluster via
 *    keyword overlap (F.1); batch any still-unplaced tabs through the
 *    existing per-tab organizer against the now much richer tree (F.2);
 *    anything that STILL has no section gets one last deterministic,
 *    content-derived name — never the synthetic "Other" bucket (F.3).
 *
 * Every placement funnels through organize.ts's placeAtPath, which already
 * reuses a matching existing sibling before ever creating one — so
 * duplicate near-identical sections (spec §14) are prevented globally
 * across every stage, not just within one of them, without a separate
 * merge pass.
 */
export async function organizeTabsCollectively(
  workspaceId: string,
  workspaceName: string,
  tabsToOrganize: Tab[],
  sections: Section[]
): Promise<PipelineResult> {
  const unlocked = tabsToOrganize.filter((t) => !t.sectionLocked);
  if (unlocked.length === 0) {
    return { tabs: tabsToOrganize, sections, report: emptyReport(tabsToOrganize.length) };
  }

  let hints: SemanticClusterHint[] = [];
  try {
    hints = await computeSemanticClusterHints([workspaceId]);
  } catch {
    hints = []; // Best-effort — clustering still works from domain/keyword signals alone.
  }

  const scopedTabs: ScopedTab[] = unlocked.map((tab) => ({ tab, workspaceId, workspaceName }));
  const rawClusters = buildRawClusters(scopedTabs, hints);
  const tabsById = new Map(unlocked.map((t) => [t.id, t]));

  const confidentClusters = rawClusters.filter((c) => c.tabIds.length >= MIN_CONFIDENT_CLUSTER_SIZE);
  const manifest = buildClusterManifest(confidentClusters, tabsById);

  let workingSections = sections;
  const placedById = new Map<string, Tab>();
  const placedClusterPaths: { path: string[]; tokens: string[] }[] = [];

  for (const chunk of chunkArray(manifest, MAX_CHUNK_CLUSTERS)) {
    if (chunk.length === 0) continue;
    const promptInput: OrganizeClusterInput[] = chunk.map((c) => ({
      clusterId: c.clusterId,
      size: c.size,
      sampleTitles: c.sampleTitles,
      dominantDomains: c.dominantDomains,
      categoryDistribution: c.categoryDistribution,
    }));

    const response = await requestOrganizeCompletion(buildClusterOrganizePrompt(workingSections, promptInput));
    const assignments = response.ok
      ? validateClusterAssignments(response.data, new Set(chunk.map((c) => c.clusterId)))
      : new Map<string, OrganizeClusterAssignment>();

    for (const entry of chunk) {
      const applied = applyClusterEntry(entry, assignments.get(entry.clusterId), tabsById, workingSections);
      workingSections = applied.sections;
      for (const t of applied.tabs) placedById.set(t.id, t);
      placedClusterPaths.push({ path: applied.path, tokens: entry.tabIds.flatMap((id) => tabTokens(tabsById.get(id)!)) });
    }
  }

  // Stage F.1 — fold singleton/unplaced tabs into an already-placed cluster
  // via keyword overlap (same trick src/lib/organize/analyze.ts uses to fold
  // leftovers into an existing proposal) before ever spending another AI call.
  const leftAfterClusters = unlocked.filter((t) => !placedById.has(t.id));
  const stillUnresolved: Tab[] = [];
  for (const tab of leftAfterClusters) {
    const tokens = tabTokens(tab);
    let bestIndex = -1;
    let bestScore = 0;
    placedClusterPaths.forEach((info, i) => {
      const score = tokenOverlap(tokens, info.tokens);
      if (score >= FOLD_OVERLAP_THRESHOLD && score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    });

    if (bestIndex >= 0) {
      const target = placedClusterPaths[bestIndex];
      const { tab: placed, sections: next } = placeAtPath(tab, workingSections, target.path, "ai");
      workingSections = next;
      placedById.set(tab.id, {
        ...placed,
        organizationStatus: placed.sectionId ? "classified" : "uncertain",
        organizationReason: `Shares keywords with tabs filed under "${target.path[target.path.length - 1]}".`,
      });
    } else {
      stillUnresolved.push(tab);
    }
  }

  // Stage F.2 — batch whatever's still unresolved (should be a small
  // minority by now) through the existing per-tab organizer, but against
  // the tree Stages D/E/F.1 already populated — nearly every plausible
  // category/subcategory already exists, so this call's job is "which
  // existing branch fits" rather than inventing structure from nothing.
  // Skipped when there's no existing tree AND clustering placed nothing at
  // all (a lone tab with no history and no clustered peers) — an AI call
  // with an empty tree to match against is guaranteed low-value (the model's
  // own instructions already treat an empty tree as "propose one new
  // category"), so it's cheaper and just as correct to go straight to the
  // deterministic Stage F.3 rather than spend an API call proving that.
  const hasNothingToMatchAgainst = workingSections.length === 0 && stillUnresolved.length === unlocked.length;
  if (stillUnresolved.length > 0 && !hasNothingToMatchAgainst) {
    const result = await organizeTabsIntoSections(stillUnresolved, workingSections, hints);
    workingSections = result.sections;
    for (const t of result.tabs) placedById.set(t.id, t);
  }

  // Stage F.3 — the true last resort: anything STILL without a sectionId
  // (e.g. its legacy category was "other" and Stage F.2 also couldn't place
  // it). Spec §8's "repeated singletons" recovery: a tab that looked like a
  // singleton on its own can turn out to share a site with several other
  // leftovers once everything else has been placed (that shared site may not
  // have cleared MIN_CONFIDENT_CLUSTER_SIZE earlier if some of its tabs got
  // folded elsewhere first) — regroup by canonical site identity one more
  // time before falling back to a generic bucket, so e.g. 5 leftover
  // Instagram tabs still become a real "Instagram" section rather than
  // diluting into "Reference" alongside everything else.
  const trulyUnplaced = unlocked.filter((t) => {
    const placed = placedById.get(t.id);
    return !placed || !placed.sectionId;
  });
  if (trulyUnplaced.length > 0) {
    const byIdentity = new Map<string, Tab[]>();
    for (const tab of trulyUnplaced) {
      const identity = canonicalSiteIdentity(tab.domain);
      if (isGenericSiteIdentity(identity)) continue;
      const bucket = byIdentity.get(identity);
      if (bucket) bucket.push(tab);
      else byIdentity.set(identity, [tab]);
    }

    const regroupedIds = new Set<string>();
    for (const [identity, members] of byIdentity) {
      if (members.length < MIN_CONFIDENT_CLUSTER_SIZE) continue;
      const path = [getDomainSectionName(identity)];
      const reason = `Shares a site with ${members.length - 1} other tab${members.length === 2 ? "" : "s"} left over from earlier organizing.`;
      for (const tab of members) {
        const { tab: placed, sections: next } = placeAtPath(tab, workingSections, path, "ai");
        workingSections = next;
        placedById.set(tab.id, { ...placed, organizationStatus: placed.sectionId ? "fallback" : "uncertain", organizationReason: reason });
        regroupedIds.add(tab.id);
      }
    }

    const stillLeftover = trulyUnplaced.filter((t) => !regroupedIds.has(t.id));
    if (stillLeftover.length > 0) {
      const derivedName = deriveSectionName(stillLeftover);
      const path = derivedName === "Miscellaneous" ? ["Reference", "General Resources"] : ["Reference", derivedName];
      for (const tab of stillLeftover) {
        const { tab: placed, sections: next } = placeAtPath(tab, workingSections, path, "ai");
        workingSections = next;
        placedById.set(tab.id, {
          ...placed,
          organizationStatus: placed.sectionId ? "fallback" : "uncertain",
          organizationReason: "Grouped with other tabs that didn't clearly match an existing topic.",
        });
      }
    }
  }

  const outTabs = tabsToOrganize.map((t) => (t.sectionLocked ? t : placedById.get(t.id) ?? t));
  const report = buildOrganizeReport(tabsToOrganize, outTabs, sections, workingSections);
  return { tabs: outTabs, sections: workingSections, report };
}
