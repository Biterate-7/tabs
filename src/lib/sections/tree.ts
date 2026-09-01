import type { Tab } from "@/lib/tabs/types";
import type { Section } from "./types";
import { rootSections, childrenOf } from "./relations";

export type SectionPresence = "large" | "standard" | "compact";

export type SectionTreeNode = {
  section: Section;
  /** Tabs assigned directly to this section (not its children). */
  tabs: Tab[];
  /** Direct tabs plus every descendant's tabs. */
  totalTabCount: number;
  /** Only meaningful for the top-level array returned by buildSectionTree. */
  presence: SectionPresence;
  children: SectionTreeNode[];
};

/** Synthetic id for the "Other" bucket — never produced by createId("section"), which always includes a timestamp. */
export const OTHER_SECTION_ID = "other";

const OTHER_SECTION: Section = {
  id: OTHER_SECTION_ID,
  parentId: null,
  name: "Other",
  source: "ai",
  createdAt: 0,
  updatedAt: 0,
};

const LARGE_SHARE_THRESHOLD = 0.2;
const COMPACT_MAX_COUNT = 1;

function buildNode(section: Section, sections: Section[], tabsBySection: Map<string, Tab[]>): SectionTreeNode {
  const children = childrenOf(sections, section.id).map((child) => buildNode(child, sections, tabsBySection));
  const tabs = tabsBySection.get(section.id) ?? [];
  const totalTabCount = tabs.length + children.reduce((sum, c) => sum + c.totalTabCount, 0);
  return { section, tabs, totalTabCount, presence: "standard", children };
}

/**
 * Buckets `tabs` by `sectionId` into a presence-ordered forest of root
 * sections (each with nested children up to MAX_SECTION_DEPTH). A tab with
 * no `sectionId`, or one that doesn't resolve to a section in `sections`
 * (deleted section, corrupt data), falls into a synthetic "Other" root node
 * — always present, always sorted last, mirroring the legacy flat
 * category grid's treatment of "other" (src/lib/workspace/hierarchy.ts).
 */
export function buildSectionTree(sections: Section[], tabs: Tab[]): SectionTreeNode[] {
  const validIds = new Set(sections.map((s) => s.id));
  const tabsBySection = new Map<string, Tab[]>();
  const otherTabs: Tab[] = [];

  for (const tab of tabs) {
    if (tab.sectionId && validIds.has(tab.sectionId)) {
      const bucket = tabsBySection.get(tab.sectionId);
      if (bucket) bucket.push(tab);
      else tabsBySection.set(tab.sectionId, [tab]);
    } else {
      otherTabs.push(tab);
    }
  }

  const roots = rootSections(sections).map((root) => buildNode(root, sections, tabsBySection));
  const otherNode: SectionTreeNode = { section: OTHER_SECTION, tabs: otherTabs, totalTabCount: otherTabs.length, presence: "standard", children: [] };

  const total = tabs.length;
  const withPresence = (node: SectionTreeNode): SectionTreeNode => {
    const share = total > 0 ? node.totalTabCount / total : 0;
    const presence: SectionPresence =
      node.totalTabCount <= COMPACT_MAX_COUNT ? "compact" : share >= LARGE_SHARE_THRESHOLD ? "large" : "standard";
    return { ...node, presence };
  };

  const sortedRoots = [...roots].sort((a, b) => b.totalTabCount - a.totalTabCount);
  return [...sortedRoots.map(withPresence), withPresence(otherNode)];
}

/** Every tab in a node's subtree — its own direct tabs plus every descendant's — for previews that should reflect totalTabCount rather than just the direct-tabs bucket (e.g. a folder tile whose tabs live entirely in subsections). */
export function collectSectionTreeTabs(node: SectionTreeNode): Tab[] {
  return node.children.reduce((acc, child) => acc.concat(collectSectionTreeTabs(child)), [...node.tabs]);
}

/** Finds a node anywhere in a section forest by its section id — used to resolve a drill-down navigation stack (root id, then child id, then grandchild id) back to the node currently being viewed. */
export function findSectionTreeNode(tree: SectionTreeNode[], sectionId: string): SectionTreeNode | undefined {
  for (const node of tree) {
    if (node.section.id === sectionId) return node;
    const found = findSectionTreeNode(node.children, sectionId);
    if (found) return found;
  }
  return undefined;
}
