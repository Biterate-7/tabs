import { createId } from "@/lib/id";
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types";
import type { Section } from "./types";

/**
 * Idempotent, one-time seed: a workspace saved before sections existed has
 * `sections === undefined`. This creates one root Section per distinct
 * legacy `category` actually present among its tabs (source: "ai"), and
 * points each such tab's `sectionId` at it — a straight "old flat categories
 * become top-level sections" port (spec §26), never touching a tab that
 * already has a `sectionId` and never reorganizing anything beyond this 1:1
 * mapping. A workspace whose `sections` is already defined (even `[]`,
 * meaning the user deleted every section) is returned unchanged.
 *
 * The legacy "other" category is deliberately never seeded into a real
 * section — every section tree already has a synthetic "Other" fallback
 * bucket (src/lib/sections/tree.ts) for tabs with no `sectionId`, so a
 * persisted "Other" root would just render as a confusing duplicate tile.
 * Tabs whose category is "other" are simply left without a `sectionId`.
 */
export function ensureSectionsSeeded(workspace: Workspace): Workspace {
  if (workspace.sections !== undefined) return workspace;

  const now = Date.now();
  const present = new Set(workspace.tabs.map((t) => ((t.category as CategoryId | undefined) ?? "other")));
  const ordered = CATEGORY_ORDER.filter((id) => id !== "other" && present.has(id));

  const sections: Section[] = [];
  const sectionIdByCategory = new Map<CategoryId, string>();
  for (const categoryId of ordered) {
    const section: Section = {
      id: createId("section"),
      parentId: null,
      name: CATEGORIES[categoryId].name,
      source: "ai",
      createdAt: now,
      updatedAt: now,
    };
    sections.push(section);
    sectionIdByCategory.set(categoryId, section.id);
  }

  const tabs = workspace.tabs.map((tab) => {
    if (tab.sectionId !== undefined) return tab;
    const categoryId = (tab.category as CategoryId | undefined) ?? "other";
    const sectionId = sectionIdByCategory.get(categoryId);
    if (!sectionId) return tab;
    return { ...tab, sectionId, organizationStatus: "classified" as const };
  });

  return { ...workspace, sections, tabs };
}

export function ensureSectionsSeededInStore(store: WorkspaceStore): WorkspaceStore {
  return { ...store, workspaces: store.workspaces.map(ensureSectionsSeeded) };
}
