import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";
import { sectionPath } from "@/lib/sections/relations";
import type { WorkspaceLookup } from "./relations";

/**
 * Which category a saved tab belongs to, for the "same category" relation
 * (relations.ts's buildGraphEdges), which the context resolver and the tab
 * peek still read. (The tab map that also drew these as boundaries is now
 * part of the Graph, which groups by project.)
 */

const LEGACY_PREFIX = "legacy:";
const PROJECT_PREFIX = "project:";
const NO_WORKSPACES: WorkspaceLookup = new Map();

function legacyCategoryKey(tab: Tab): string {
  return tab.category?.trim() || "other";
}

/**
 * The category-level key a tab belongs to: the id of its root Section when
 * `tab.sectionId` resolves to a live section, otherwise a
 * `"legacy:<CategoryId>"` key built from the flat legacy category field —
 * the same fallback buildGraphEdges has always used for tabs that predate
 * Sections.
 *
 * A tab with neither (no section, no confident category — which is every
 * source added to a project from a PDF, an upload or an unrecognised site)
 * falls back to the project (Workspace) that holds it: `"project:<id>"`.
 * Without `workspaceOf` that fallback was one global `"legacy:other"`, which
 * chained "category" edges across projects that have nothing in common.
 * Only a tab no workspace holds (a deleted project, a caller without a
 * lookup) still lands in "Other".
 */
export function resolveCategoryKey(tab: Tab, sections: Section[], workspaceOf: WorkspaceLookup = NO_WORKSPACES): string {
  if (tab.sectionId) {
    const path = sectionPath(sections, tab.sectionId);
    if (path.length > 0) return path[0].id;
  }
  const legacyKey = legacyCategoryKey(tab);
  if (legacyKey === "other") {
    const projectId = workspaceOf.get(tab.id)?.id;
    if (projectId) return `${PROJECT_PREFIX}${projectId}`;
  }
  return `${LEGACY_PREFIX}${legacyKey}`;
}
