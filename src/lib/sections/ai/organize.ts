import { CATEGORIES } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import { deriveSectionName, tabTokens, tokenOverlap, tokenize } from "@/lib/organize/keywords";
import type { SemanticClusterHint } from "@/lib/organize/types";
import type { Tab } from "@/lib/tabs/types";
import { childrenOf, createSection, rootSections } from "../relations";
import { findSimilarSibling } from "../normalize";
import { MAX_SECTION_DEPTH } from "../types";
import type { Section, SectionSource } from "../types";
import { buildOrganizePrompt } from "./prompt";
import type { OrganizePathAssignment, OrganizePromptTab } from "./prompt";
import { requestOrganizeCompletion } from "./client";

/** One request per chunk; large dumps chunk sequentially (not in parallel) so later chunks see sections earlier chunks in the same dump just created — see spec §27 on batching. */
const MAX_CHUNK_TABS = 40;
/** A "medium" confidence assignment is only applied if at least this many tabs in the batch agree on the exact same leaf path (or share an embedding-cluster hint pointing the same way) — otherwise it's downgraded to low. */
const MEDIUM_CONFIDENCE_MIN_AGREEING = 2;
/** In the deterministic fallback, a shared-cluster group needs at least this many tabs (within the same legacy category) to earn its own subsection — mirrors src/lib/organize/analyze.ts's MIN_GROUP_SIZE. */
const FALLBACK_MIN_CLUSTER_SIZE = 3;
/** A brand-new subsection/project/category needs at least this much combined evidence (see newSectionEvidenceScore) before it's actually created — otherwise the assignment is downgraded to whatever ancestor already exists. Prevents one confidently-worded tab from spawning a section of its own (spec's "category explosion" concern). */
export const NEW_SECTION_SCORE_THRESHOLD = 4;
/** Keeps a stored organizationReason short and UI-safe — a sentence, not a paragraph of model reasoning. */
const REASON_MAX_CHARS = 160;

export type OrganizeResult = { tabs: Tab[]; sections: Section[] };

/**
 * `NEW_SECTION_SCORE_THRESHOLD`, `placeAtPath`, `fullPathAlreadyExists`,
 * `deepestExistingPrefix`, `pathKey`, `categoryNameOf`, and `sanitizeReason`
 * are exported for src/lib/sections/ai/pipeline.ts, which reuses this
 * file's per-tab placement/evidence primitives at the CLUSTER level (a
 * cluster's member tabs are placed together, with the cluster's size taking
 * the place of this file's within-batch tab-agreement count) rather than
 * duplicating them.
 */
export function pathKey(path: string[]): string {
  return path.map((s) => s.trim().toLowerCase()).join(" > ");
}

export function categoryNameOf(tab: Tab): string {
  return CATEGORIES[(tab.category as CategoryId | undefined) ?? "other"].name;
}

/**
 * Walks `path` from root, reusing an existing section at each level when
 * findSimilarSibling judges it the same thing (spec §11/§20's normalization),
 * else creating a new one (`source`). Stops early (without erroring) if the
 * path would exceed MAX_SECTION_DEPTH. Returns `tab` unchanged if the very
 * first segment is blank.
 */
export function placeAtPath(tab: Tab, sections: Section[], path: string[], source: SectionSource): { tab: Tab; sections: Section[] } {
  let working = sections;
  let parentId: string | null = null;
  let leafId: string | null = null;

  for (const rawName of path.slice(0, MAX_SECTION_DEPTH + 1)) {
    const name = rawName.trim();
    if (!name) break;
    const siblings: Section[] = parentId === null ? rootSections(working) : childrenOf(working, parentId);
    const matchName = findSimilarSibling(siblings.map((s) => s.name), name);
    const existing: Section | undefined = matchName ? siblings.find((s) => s.name === matchName) : undefined;

    if (existing) {
      leafId = existing.id;
      parentId = existing.id;
      continue;
    }
    const created = createSection(working, parentId, name, source);
    if (!created) break; // depth cap reached — stop at the deepest section we did place
    working = created.sections;
    leafId = created.section.id;
    parentId = created.section.id;
  }

  if (!leafId) return { tab, sections: working };
  return { tab: { ...tab, sectionId: leafId }, sections: working };
}

/** Longest prefix of `path` that resolves to sections that already exist (via findSimilarSibling) — never creates anything. Used to downgrade a low-evidence assignment to its nearest safe existing ancestor instead of inventing a brand-new section from a single weak signal. */
export function deepestExistingPrefix(sections: Section[], path: string[]): string[] {
  let parentId: string | null = null;
  const matched: string[] = [];
  for (const rawName of path.slice(0, MAX_SECTION_DEPTH + 1)) {
    const name = rawName.trim();
    if (!name) break;
    const siblings: Section[] = parentId === null ? rootSections(sections) : childrenOf(sections, parentId);
    const matchName = findSimilarSibling(siblings.map((s) => s.name), name);
    const existing: Section | undefined = matchName ? siblings.find((s) => s.name === matchName) : undefined;
    if (!existing) break;
    matched.push(existing.name);
    parentId = existing.id;
  }
  return matched;
}

function validateAssignments(data: unknown, validIds: Set<string>): Map<string, OrganizePathAssignment> {
  const map = new Map<string, OrganizePathAssignment>();
  if (!Array.isArray(data)) return map;

  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const e = entry as Record<string, unknown>;
    const tabId = typeof e.tabId === "string" ? e.tabId : undefined;
    if (!tabId || !validIds.has(tabId) || map.has(tabId)) continue;
    if (!Array.isArray(e.path)) continue;
    const path = e.path
      .filter((s): s is string => typeof s === "string" && s.trim().length > 0)
      .map((s) => s.trim())
      .slice(0, MAX_SECTION_DEPTH + 1);
    if (path.length === 0) continue;
    const confidence = e.confidence === "high" || e.confidence === "medium" || e.confidence === "low" ? e.confidence : "low";
    const reason = typeof e.reason === "string" ? e.reason : "";
    map.set(tabId, { tabId, path, confidence, reason });
  }
  return map;
}

function hasHintAgreement(
  tab: Tab,
  assignment: OrganizePathAssignment,
  tabs: Tab[],
  assignments: Map<string, OrganizePathAssignment>,
  hintByTabId: Map<string, string>
): boolean {
  const hint = hintByTabId.get(tab.id);
  if (!hint) return false;
  return tabs.some((other) => {
    if (other.id === tab.id) return false;
    if (hintByTabId.get(other.id) !== hint) return false;
    const otherAssignment = assignments.get(other.id);
    return otherAssignment !== undefined && pathKey(otherAssignment.path) === pathKey(assignment.path);
  });
}

/** Trims/collapses whitespace and hard-caps length so a stored reason is always a short, UI-safe sentence — never raw model reasoning, never long enough to read as chain-of-thought. Returns undefined for a blank/missing reason rather than storing an empty string. */
export function sanitizeReason(reason: string | undefined): string | undefined {
  if (!reason) return undefined;
  const cleaned = reason.replace(/\s+/g, " ").trim();
  if (!cleaned) return undefined;
  return cleaned.length > REASON_MAX_CHARS ? `${cleaned.slice(0, REASON_MAX_CHARS - 1).trimEnd()}…` : cleaned;
}

/**
 * Whether `path` resolves ENTIRELY against sections that already exist (no
 * segment would need creating) — the "reuse, don't create" fast path that
 * spec §8 wants to always win over inventing anything, regardless of
 * confidence.
 */
export function fullPathAlreadyExists(sections: Section[], path: string[]): boolean {
  const capped = path.slice(0, MAX_SECTION_DEPTH + 1).filter((s) => s.trim().length > 0);
  return capped.length > 0 && deepestExistingPrefix(sections, path).length === capped.length;
}

/**
 * Combined evidence score for actually CREATING the new section(s) a path
 * requires (as opposed to reusing an existing path, which never needs this
 * check — see fullPathAlreadyExists). Deliberately simple and legible rather
 * than a tuned model: batch corroboration (multiple tabs proposing the same
 * leaf, or sharing an embedding cluster) dominates, with smaller pushes from
 * the parent already existing, from the tab's own title/domain actually
 * containing the proposed name, and from the model's own confidence. This is
 * the guard against a single confidently-worded tab spawning a section of
 * its own (spec's "category explosion" concern) — a real project/topic
 * should leave more than one fingerprint.
 */
function newSectionEvidenceScore(
  tab: Tab,
  assignment: OrganizePathAssignment,
  tabs: Tab[],
  assignments: Map<string, OrganizePathAssignment>,
  hintByTabId: Map<string, string>,
  sections: Section[]
): number {
  const leafKey = pathKey(assignment.path);
  const tabsAtSameLeaf = tabs.filter((t) => {
    const other = assignments.get(t.id);
    return other !== undefined && pathKey(other.path) === leafKey;
  }).length;

  // Two or more tabs agreeing meets spec's evidence bar on its own.
  let score = tabsAtSameLeaf >= 2 ? 4 : 1;
  if (hasHintAgreement(tab, assignment, tabs, assignments, hintByTabId)) score += 2;

  if (assignment.path.length > 1) {
    const existingPrefixLen = deepestExistingPrefix(sections, assignment.path).length;
    if (existingPrefixLen >= assignment.path.length - 1) score += 1; // the parent this would nest under already exists
  }

  const leafName = assignment.path[assignment.path.length - 1] ?? "";
  const overlap = tokenOverlap(tokenize(leafName), tabTokens(tab));
  if (overlap >= 0.3) score += 1; // the tab's own title/domain actually supports this specific name

  if (assignment.confidence === "high") score += 1;

  return score;
}

/** Applies a model response's (validated) assignments, per spec §9's confidence policy. Never creates a section from a "low" confidence assignment — those only ever reuse an existing ancestor, or leave the tab in "Other". */
function applyAssignments(
  tabs: Tab[],
  sections: Section[],
  assignments: Map<string, OrganizePathAssignment>,
  hintByTabId: Map<string, string>
): OrganizeResult {
  let working = sections;
  const outTabs: Tab[] = [];

  const countByPath = new Map<string, number>();
  for (const tab of tabs) {
    const a = assignments.get(tab.id);
    if (!a) continue;
    const key = pathKey(a.path);
    countByPath.set(key, (countByPath.get(key) ?? 0) + 1);
  }

  /** Shared "no confident placement" landing spot: reuse whatever ancestor of `path` already exists, or leave the tab as-is (falls into Other) if nothing does. Never creates anything. */
  function placeAtSafestExisting(tab: Tab, path: string[], reason: string | undefined): Tab {
    const existingPrefix = deepestExistingPrefix(working, path);
    if (existingPrefix.length === 0) return { ...tab, organizationStatus: "uncertain" };
    const { tab: placed, sections: next } = placeAtPath(tab, working, existingPrefix, "ai");
    working = next;
    return { ...placed, organizationStatus: "uncertain", ...(reason ? { organizationReason: reason } : {}) };
  }

  for (const tab of tabs) {
    const a = assignments.get(tab.id);

    if (!a) {
      // The model skipped this tab entirely — treat as low confidence against its legacy category.
      const { tab: placed, sections: next } = placeAtPath(tab, working, [categoryNameOf(tab)], "ai");
      working = next;
      outTabs.push({ ...placed, organizationStatus: "uncertain" });
      continue;
    }

    const reason = sanitizeReason(a.reason);

    // Reusing a path that already exists in full always wins, regardless of
    // confidence (spec §8) — no evidence gate needed since nothing is created.
    if (fullPathAlreadyExists(working, a.path)) {
      const { tab: placed, sections: next } = placeAtPath(tab, working, a.path, "ai");
      working = next;
      const status = a.confidence === "low" ? "uncertain" : placed.sectionId ? "classified" : "uncertain";
      outTabs.push({ ...placed, organizationStatus: status, ...(reason ? { organizationReason: reason } : {}) });
      continue;
    }

    if (a.confidence === "low") {
      outTabs.push(placeAtSafestExisting(tab, a.path, reason));
      continue;
    }

    // "high", or "medium" corroborated by the batch (2+ tabs on the same
    // leaf, or a shared embedding cluster) — either way, this would require
    // CREATING at least one new section, so it's gated on evidence rather
    // than confidence alone (spec's "one confident tab shouldn't spawn a
    // section" concern).
    const corroborated =
      a.confidence === "high" ||
      (countByPath.get(pathKey(a.path)) ?? 0) >= MEDIUM_CONFIDENCE_MIN_AGREEING ||
      hasHintAgreement(tab, a, tabs, assignments, hintByTabId);

    if (!corroborated) {
      outTabs.push(placeAtSafestExisting(tab, a.path, reason));
      continue;
    }

    // The evidence-score gate only applies to creating a SUBSECTION or
    // PROJECT (a multi-segment path) — that's where fragmentation actually
    // happens ("Physics" spawning "Physics Homework"/"Physics Lecture"/...).
    // A brand-new top-level CATEGORY is comparatively low-risk (there are
    // only so many plausible ones, and classify.ts's rule-based `category`
    // already independently agrees for most tabs), so it's created directly
    // once corroborated, same as before this hardening pass.
    if (a.path.length > 1) {
      const score = newSectionEvidenceScore(tab, a, tabs, assignments, hintByTabId, working);
      if (score < NEW_SECTION_SCORE_THRESHOLD) {
        outTabs.push(placeAtSafestExisting(tab, a.path, reason));
        continue;
      }
    }

    const { tab: placed, sections: next } = placeAtPath(tab, working, a.path, "ai");
    working = next;
    // placeAtPath can come back empty-handed (e.g. the model proposed a
    // reserved root like "Other" — see createSection) — never claim
    // "classified" for a tab that didn't actually get a sectionId.
    outTabs.push({ ...placed, organizationStatus: placed.sectionId ? "classified" : "uncertain", ...(reason ? { organizationReason: reason } : {}) });
  }

  return { tabs: outTabs, sections: working };
}

/**
 * Deterministic, never-fails fallback for when the model call is unavailable
 * or its response is unusable: every tab gets a root section from its
 * existing legacy `category` (always succeeds, since categorizeTabs already
 * ran during dump), and tabs that share an embedding-cluster hint within the
 * same category — provided the shared group clears FALLBACK_MIN_CLUSTER_SIZE
 * — additionally get a named subsection, reusing the exact same
 * `deriveClusterName` src/lib/organize/analyze.ts's proposeGroups already
 * relies on for the identical "name a sub-cluster" problem.
 */
function fallbackOrganize(tabs: Tab[], sections: Section[], hintByTabId: Map<string, string>): OrganizeResult {
  const groups = new Map<string, Tab[]>();
  for (const tab of tabs) {
    const hint = hintByTabId.get(tab.id);
    if (!hint) continue;
    const key = `${(tab.category as CategoryId | undefined) ?? "other"}::${hint}`;
    const list = groups.get(key);
    if (list) list.push(tab);
    else groups.set(key, [tab]);
  }

  const subNameByTabId = new Map<string, string>();
  for (const groupTabs of groups.values()) {
    if (groupTabs.length < FALLBACK_MIN_CLUSTER_SIZE) continue;
    const subName = deriveSectionName(groupTabs);
    for (const tab of groupTabs) subNameByTabId.set(tab.id, subName);
  }

  let working = sections;
  const outTabs: Tab[] = [];
  for (const tab of tabs) {
    const rootName = categoryNameOf(tab);
    const subName = subNameByTabId.get(tab.id);
    // "Other" is never a real, creatable root (see createSection) — a
    // genuine cluster found among "other"-categorized tabs is promoted
    // straight to its own root instead of being nested under a parent that
    // would just fail to create, so a real signal still surfaces rather
    // than silently leaving those tabs unset.
    const path = subName ? (rootName === "Other" ? [subName] : [rootName, subName]) : [rootName];
    const { tab: placed, sections: next } = placeAtPath(tab, working, path, "ai");
    working = next;
    if (!placed.sectionId) {
      outTabs.push({ ...placed, organizationStatus: "uncertain" });
      continue;
    }
    const reason = subName
      ? `Shares a topic with other tabs in this dump, grouped under "${subName}".`
      : `Filed under ${rootName} based on its existing category.`;
    outTabs.push({ ...placed, organizationStatus: "fallback", organizationReason: reason });
  }
  return { tabs: outTabs, sections: working };
}

async function organizeChunk(tabs: Tab[], sections: Section[], hintByTabId: Map<string, string>): Promise<OrganizeResult> {
  const promptTabs: OrganizePromptTab[] = tabs.map((t) => ({
    tabId: t.id,
    title: t.title ?? "",
    url: t.url,
    domain: t.domain,
    category: categoryNameOf(t),
    clusterHint: hintByTabId.get(t.id),
  }));

  const response = await requestOrganizeCompletion(buildOrganizePrompt(sections, promptTabs));
  if (response.ok) {
    const assignments = validateAssignments(response.data, new Set(tabs.map((t) => t.id)));
    if (assignments.size > 0) return applyAssignments(tabs, sections, assignments, hintByTabId);
  }

  return fallbackOrganize(tabs, sections, hintByTabId);
}

function chunkArray<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

/**
 * Organizes `tabsToOrganize` into `sections`, returning both the (possibly
 * unchanged) tabs and the (possibly extended) section list. Tabs with
 * `sectionLocked: true` are never sent to the model and pass through
 * untouched (spec §13/34 — manual placement overrides the AI). Never throws:
 * any failure anywhere in the model round trip falls back to
 * fallbackOrganize, which is itself pure/synchronous and always succeeds.
 */
export async function organizeTabsIntoSections(
  tabsToOrganize: Tab[],
  sections: Section[],
  semanticHints: SemanticClusterHint[] = []
): Promise<OrganizeResult> {
  const unlocked = tabsToOrganize.filter((t) => !t.sectionLocked);
  if (unlocked.length === 0) return { tabs: tabsToOrganize, sections };

  const hintByTabId = new Map(semanticHints.map((h) => [h.tabId, h.clusterKey]));
  const resultById = new Map<string, Tab>();
  for (const t of tabsToOrganize) if (t.sectionLocked) resultById.set(t.id, t);

  let workingSections = sections;
  for (const chunk of chunkArray(unlocked, MAX_CHUNK_TABS)) {
    const result = await organizeChunk(chunk, workingSections, hintByTabId);
    workingSections = result.sections;
    for (const t of result.tabs) resultById.set(t.id, t);
  }

  return { tabs: tabsToOrganize.map((t) => resultById.get(t.id) ?? t), sections: workingSections };
}
