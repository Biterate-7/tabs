import { createId } from "@/lib/id";
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";
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

/**
 * Continuously keeps root sections aligned with each tab's flat `category`
 * — unlike ensureSectionsSeeded (a one-time port that only runs while
 * `sections === undefined`), this runs on every workspace mutation so a tab
 * that changes category later (recategorize, bulk recategorize, an edit from
 * Favorites/Recents) is never stranded in the synthetic "Other" bucket just
 * because that edit didn't go through a dump/import — the only paths that
 * trigger the async AI/fallback organizer (src/lib/sections/ai/organize.ts).
 *
 * Only touches a tab whose `sectionId` doesn't resolve to a section that
 * still exists in this workspace (never a tab that's already validly
 * sectioned, including one a user manually moved elsewhere), and only
 * reuses/creates a ROOT section by exact case-insensitive name match to the
 * category's display name (the same 1:1 mapping ensureSectionsSeeded uses,
 * made ongoing) — never renames or restructures an existing section. Like
 * ensureSectionsSeeded, never creates a section for the "other" category: a
 * tab with no confident category is simply left without a sectionId and
 * falls into the tree's synthetic "Other" bucket. A workspace whose
 * `sections` is still `undefined` (predates sections entirely, or a
 * brand-new workspace not yet seeded) is returned unchanged — seeding is
 * what turns `undefined` into a real array in the first place.
 */
/**
 * Applies a user's explicit "change category" pick (the legacy flat-category
 * dropdown, distinct from moving a tab between sections directly) to `tab`.
 *
 * Since the categorization pipeline (src/lib/sections/ai/pipeline.ts) now
 * gives nearly every tab a real sectionId — by design, to keep almost
 * nothing in the synthetic "Other" bucket — syncSectionsWithCategories's own
 * guard ("already has a valid sectionId, leave it alone") would otherwise
 * treat that tab as permanently settled and never re-sync it to a category
 * the user picks afterward. Clearing sectionId/organizationStatus/
 * organizationReason here (unless the tab is sectionLocked — an explicit
 * "move to section" already overrides any category-driven placement) makes
 * this manual pick look like an unsectioned tab again, so the very next
 * syncSectionsWithCategories call (every mutation runs through it — see
 * app-shell.tsx's persist) creates/reuses a root section matching the new
 * category, same as it always has for a genuinely never-organized tab.
 */
export function applyCategoryChange(tab: Tab, category: CategoryId): Tab {
  if (tab.sectionLocked) return { ...tab, category };
  return { ...tab, category, sectionId: undefined, organizationStatus: undefined, organizationReason: undefined };
}

export function syncSectionsWithCategories(workspace: Workspace): Workspace {
  if (workspace.sections === undefined) return workspace;

  const sections = [...workspace.sections];
  const rootByName = new Map(
    sections.filter((s) => s.parentId === null).map((s) => [s.name.trim().toLowerCase(), s] as const)
  );
  const validIds = new Set(sections.map((s) => s.id));
  const now = Date.now();
  let changed = false;

  const tabs = workspace.tabs.map((tab) => {
    if (tab.sectionId !== undefined && validIds.has(tab.sectionId)) return tab;

    const categoryId = (tab.category as CategoryId | undefined) ?? "other";
    if (categoryId === "other") return tab;

    const name = CATEGORIES[categoryId].name;
    let section = rootByName.get(name.toLowerCase());
    if (!section) {
      section = { id: createId("section"), parentId: null, name, source: "ai", createdAt: now, updatedAt: now };
      sections.push(section);
      rootByName.set(name.toLowerCase(), section);
      validIds.add(section.id);
    }

    changed = true;
    return { ...tab, sectionId: section.id, organizationStatus: "classified" as const };
  });

  if (!changed) return workspace;
  return { ...workspace, sections, tabs };
}

export function syncSectionsWithCategoriesInStore(store: WorkspaceStore): WorkspaceStore {
  return { ...store, workspaces: store.workspaces.map(syncSectionsWithCategories) };
}
