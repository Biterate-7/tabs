import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import type { Collection } from "@/lib/collections/types";
import { sectionPath } from "@/lib/sections/relations";
import { LARGE_SHARE_THRESHOLD, COMPACT_MAX_COUNT } from "@/lib/sections/tree";
import { CATEGORIES, type CategoryId } from "@/lib/categories";
import {
  CLUSTER_LAYOUT_MODE,
  computeClusterRegions,
  computeSubcategoryRegion,
  type ClusterRegion,
} from "./cluster-regions";

export type ClusterKind = "category" | "subcategory" | "collection";
export type ClusterPresence = "large" | "standard" | "compact";

export type ClusterNode = {
  id: string;
  kind: ClusterKind;
  depth: 0 | 1 | 2;
  parentId: string | null;
  label: string;
  /** Tabs bucketed directly at this node (not inside a child). */
  memberTabIds: string[];
  /** memberTabIds plus every descendant's, memoized bottom-up. */
  totalTabIds: string[];
  weight: number;
  presence: ClusterPresence;
  children: ClusterNode[];
};

export type ClusterTree = {
  /** Category-level nodes only. */
  roots: ClusterNode[];
  /** Every node at every depth, flat. */
  byId: Map<string, ClusterNode>;
  /** [categoryId] or [categoryId, subcategoryId] for every tab that resolved to a cluster. */
  clusterPathOfTab: Map<string, string[]>;
};

const LEGACY_PREFIX = "legacy:";

function legacyCategoryKey(tab: Tab): string {
  return tab.category?.trim() || "other";
}

function legacyCategoryLabel(key: string): string {
  const def = CATEGORIES[key as CategoryId];
  return def?.name ?? (key.charAt(0).toUpperCase() + key.slice(1));
}

/**
 * The category-level key a tab belongs to: the id of its root Section when
 * `tab.sectionId` resolves to a live section, otherwise a
 * `"legacy:<CategoryId>"` key built from the flat legacy category field —
 * the same fallback buildGraphEdges has always used for tabs that predate
 * Sections. Exported so the "category" edge reason and this module's
 * cluster boundaries can never disagree about what "same category" means.
 */
export function resolveCategoryKey(tab: Tab, sections: Section[]): string {
  if (tab.sectionId) {
    const path = sectionPath(sections, tab.sectionId);
    if (path.length > 0) return path[0].id;
  }
  return `${LEGACY_PREFIX}${legacyCategoryKey(tab)}`;
}

/** The subcategory-level Section a tab belongs to, if any — only a tab whose sectionId resolves at least two levels deep (a real Subcategory or Project section) has one. Legacy-category tabs never do; there's no data to subdivide them by. */
function resolveSubcategorySection(tab: Tab, sections: Section[]): Section | null {
  if (!tab.sectionId) return null;
  const path = sectionPath(sections, tab.sectionId);
  return path.length >= 2 ? path[1] : null;
}

function presenceOf(totalTabCount: number, totalTabs: number): ClusterPresence {
  if (totalTabCount <= COMPACT_MAX_COUNT) return "compact";
  const share = totalTabs > 0 ? totalTabCount / totalTabs : 0;
  return share >= LARGE_SHARE_THRESHOLD ? "large" : "standard";
}

/**
 * Buckets `tabs` into a two-level Category → Subcategory forest (reusing
 * Section data via `sectionPath`, with a "legacy:<category>" fallback for
 * tabs that only carry the flat legacy `category` field), then folds in
 * `Collection`s as a third, cross-cutting clustering signal — a Collection
 * with at least 2 members present in `tabs` becomes its own ClusterNode,
 * parented by whichever category/subcategory holds the majority of its
 * members (ties broken by the lowest cluster id, for determinism). A
 * Collection spanning several categories is a real, expected case; "majority
 * parent" is a deliberate simplification, not a claim that the collection
 * belongs exclusively to that category.
 *
 * Pure and deterministic: the same tabs/sections/collections always produce
 * a structurally identical tree, which is what lets computeClusterAnchors
 * seed stable, reproducible positions without persisting anything new.
 */
export function buildClusterTree(tabs: Tab[], sections: Section[], collections: Collection[]): ClusterTree {
  const sectionsById = new Map(sections.map((s) => [s.id, s]));
  const clusterPathOfTab = new Map<string, string[]>();

  const categoryMembers = new Map<string, string[]>();
  const categoryLabel = new Map<string, string>();
  const subcategoryMembers = new Map<string, string[]>();
  const subcategoryLabel = new Map<string, string>();
  const subcategoryParent = new Map<string, string>();
  const subcategoriesByCategory = new Map<string, Set<string>>();

  for (const tab of tabs) {
    const categoryKey = resolveCategoryKey(tab, sections);
    const categoryId = `cat:${categoryKey}`;
    if (!categoryLabel.has(categoryKey)) {
      categoryLabel.set(
        categoryKey,
        categoryKey.startsWith(LEGACY_PREFIX)
          ? legacyCategoryLabel(categoryKey.slice(LEGACY_PREFIX.length))
          : (sectionsById.get(categoryKey)?.name ?? "Other")
      );
    }

    const subSection = resolveSubcategorySection(tab, sections);
    if (subSection) {
      const subId = `sub:${subSection.id}`;
      const list = subcategoryMembers.get(subId);
      if (list) list.push(tab.id);
      else subcategoryMembers.set(subId, [tab.id]);
      subcategoryLabel.set(subId, subSection.name);
      subcategoryParent.set(subId, categoryId);
      let siblingSet = subcategoriesByCategory.get(categoryId);
      if (!siblingSet) {
        siblingSet = new Set();
        subcategoriesByCategory.set(categoryId, siblingSet);
      }
      siblingSet.add(subId);
      clusterPathOfTab.set(tab.id, [categoryId, subId]);
    } else {
      const list = categoryMembers.get(categoryKey);
      if (list) list.push(tab.id);
      else categoryMembers.set(categoryKey, [tab.id]);
      clusterPathOfTab.set(tab.id, [categoryId]);
    }
  }

  const totalTabs = tabs.length;
  const byId = new Map<string, ClusterNode>();

  const roots: ClusterNode[] = [...categoryLabel.keys()].map((categoryKey) => {
    const categoryId = `cat:${categoryKey}`;
    const directMembers = categoryMembers.get(categoryKey) ?? [];
    const subIds = [...(subcategoriesByCategory.get(categoryId) ?? [])];
    const children: ClusterNode[] = subIds.map((subId) => {
      const members = subcategoryMembers.get(subId) ?? [];
      const node: ClusterNode = {
        id: subId,
        kind: "subcategory",
        depth: 1,
        parentId: categoryId,
        label: subcategoryLabel.get(subId) ?? "Subcategory",
        memberTabIds: members,
        totalTabIds: members,
        weight: members.length,
        presence: presenceOf(members.length, totalTabs),
        children: [],
      };
      byId.set(subId, node);
      return node;
    });
    children.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

    const totalTabIds = [...directMembers, ...children.flatMap((c) => c.totalTabIds)];
    const node: ClusterNode = {
      id: categoryId,
      kind: "category",
      depth: 0,
      parentId: null,
      label: categoryLabel.get(categoryKey) ?? "Other",
      memberTabIds: directMembers,
      totalTabIds,
      weight: totalTabIds.length,
      presence: presenceOf(totalTabIds.length, totalTabs),
      children,
    };
    byId.set(categoryId, node);
    return node;
  });

  roots.sort((a, b) => b.weight - a.weight || a.id.localeCompare(b.id));

  // Collections: a strong, cross-cutting clustering signal, layered on top
  // of the category/subcategory structure above rather than replacing it.
  // Mirrors engine.ts's existing <2-member skip so this tree never disagrees
  // with what the physics simulation actually clusters.
  const tabIdSet = new Set(tabs.map((t) => t.id));
  for (const collection of collections) {
    const memberIds = collection.tabIds.filter((id) => tabIdSet.has(id));
    if (memberIds.length < 2) continue;

    const parentCounts = new Map<string, number>();
    for (const tabId of memberIds) {
      const path = clusterPathOfTab.get(tabId);
      const parentId = path?.[path.length - 1];
      if (!parentId) continue;
      parentCounts.set(parentId, (parentCounts.get(parentId) ?? 0) + 1);
    }
    let bestParentId: string | null = null;
    let bestCount = -1;
    for (const [parentId, count] of [...parentCounts.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      if (count > bestCount) {
        bestCount = count;
        bestParentId = parentId;
      }
    }
    if (!bestParentId) continue;
    const parent = byId.get(bestParentId);
    if (!parent) continue;

    const collectionId = `col:${collection.id}`;
    const node: ClusterNode = {
      id: collectionId,
      kind: "collection",
      depth: 2,
      parentId: bestParentId,
      label: collection.name,
      memberTabIds: memberIds,
      totalTabIds: memberIds,
      weight: memberIds.length,
      presence: presenceOf(memberIds.length, totalTabs),
      children: [],
    };
    byId.set(collectionId, node);
    parent.children.push(node);
  }

  return { roots, byId, clusterPathOfTab };
}

export type ClusterAnchorAssignment = {
  categoryAnchor: { x: number; y: number } | null;
  subcategoryAnchor: { x: number; y: number } | null;
  /**
   * The region this tab is confined to, under CLUSTER_LAYOUT_MODE "packed2d" —
   * its category's (or subcategory's) reserved disc. Null under "ring" mode,
   * where nothing is confined and the anchors above are the only cluster
   * force. Carried here rather than through a separate simulation setter so
   * the existing setClusterAnchors() call site stays the single place layout
   * intent reaches the physics engine.
   *
   * Optional: absent means "not confined", so every existing caller that
   * builds an assignment by hand keeps working unchanged.
   */
  confineTo?: ClusterRegion | null;
};

/** Small, pure, deterministic hash — used only to jitter anchor placement so it doesn't read as a perfect pie chart, never for anything security-sensitive. */
function hashToUnit(id: string): number {
  let hash = 2166136261;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return ((hash >>> 0) % 100000) / 100000;
}

const CATEGORY_RING_BASE_RADIUS = 260;
const CATEGORY_RING_GROWTH = 3.2;

/**
 * Deterministic anchor seeding: same cluster tree in ⇒ same anchors out, so
 * a reload looks like "the same neighborhood" without persisting anything
 * new. Categories sit on a ring around the origin, each given angular width
 * proportional to sqrt(weight) (large categories get more room; small ones
 * aren't squeezed to the same sliver) plus a small hash-based jitter within
 * its own slice. Subcategories/collections sit on a smaller ring around
 * their parent category's anchor, by the same logic.
 */
export function computeClusterAnchors(tree: ClusterTree): Map<string, ClusterAnchorAssignment> {
  if (CLUSTER_LAYOUT_MODE === "packed2d") return computePackedClusterAnchors(tree);
  return computeRingClusterAnchors(tree);
}

/**
 * "packed2d": every category gets a reserved disc (see cluster-regions.ts)
 * rather than a point on a shared ring, and its members are confined to it.
 * The anchor spring is left at its existing weak strength — the confinement,
 * not the spring, is what holds a category together, so nothing about the
 * force balance between charge/collide/link changes.
 */
function computePackedClusterAnchors(tree: ClusterTree): Map<string, ClusterAnchorAssignment> {
  const regions = computeClusterRegions(tree);
  const result = new Map<string, ClusterAnchorAssignment>();

  for (const category of tree.roots) {
    const region = regions.get(category.id);
    if (!region) continue;

    const subcategories = category.children.filter((child) => child.kind === "subcategory");
    const subcategoryRegions = new Map<string, ClusterRegion>();
    subcategories.forEach((sub, index) => {
      subcategoryRegions.set(sub.id, computeSubcategoryRegion(region, index, subcategories.length, sub.weight));
    });

    for (const tabId of category.totalTabIds) {
      const path = tree.clusterPathOfTab.get(tabId);
      const subRegion = path && path.length > 1 ? subcategoryRegions.get(path[1]) : undefined;
      result.set(tabId, {
        categoryAnchor: { x: region.x, y: region.y },
        subcategoryAnchor: subRegion ? { x: subRegion.x, y: subRegion.y } : null,
        // A tab in a subcategory is confined to that subcategory's own disc,
        // which sits wholly inside its parent's — so a subcategory's boundary
        // box nests inside its category's instead of merely overlapping it.
        confineTo: subRegion ?? region,
      });
    }
  }

  return result;
}

function computeRingClusterAnchors(tree: ClusterTree): Map<string, ClusterAnchorAssignment> {
  const anchors = new Map<string, { x: number; y: number }>();
  const totalTabs = tree.roots.reduce((sum, r) => sum + r.weight, 0);
  const totalShare = tree.roots.reduce((sum, r) => sum + Math.sqrt(Math.max(1, r.weight)), 0) || 1;

  let cursor = 0;
  for (const category of tree.roots) {
    const share = Math.sqrt(Math.max(1, category.weight)) / totalShare;
    const angularWidth = share * Math.PI * 2;
    const jitter = (hashToUnit(category.id) - 0.5) * angularWidth * 0.3;
    const angle = cursor + angularWidth / 2 + jitter;
    cursor += angularWidth;

    const radiusMultiplier = category.presence === "large" ? 0.78 : category.presence === "compact" ? 1.25 : 1;
    const ringRadius = (CATEGORY_RING_BASE_RADIUS + Math.sqrt(totalTabs) * CATEGORY_RING_GROWTH) * radiusMultiplier;
    const categoryAnchor = { x: Math.cos(angle) * ringRadius, y: Math.sin(angle) * ringRadius };
    anchors.set(category.id, categoryAnchor);

    const children = category.children;
    const childRing = 40 + Math.sqrt(category.weight) * 9;
    const n = children.length;
    children.forEach((child, i) => {
      const baseAngle = n > 0 ? (i / n) * Math.PI * 2 : 0;
      const childJitter = n > 0 ? (hashToUnit(child.id) - 0.5) * ((Math.PI * 2) / n) * 0.4 : 0;
      const childAngle = baseAngle + childJitter;
      anchors.set(child.id, {
        x: categoryAnchor.x + Math.cos(childAngle) * childRing,
        y: categoryAnchor.y + Math.sin(childAngle) * childRing,
      });
    });
  }

  const result = new Map<string, ClusterAnchorAssignment>();
  for (const [tabId, path] of tree.clusterPathOfTab) {
    const categoryAnchor = anchors.get(path[0]) ?? null;
    const subcategoryAnchor = path.length > 1 ? (anchors.get(path[1]) ?? null) : null;
    result.set(tabId, { categoryAnchor, subcategoryAnchor, confineTo: null });
  }
  return result;
}
