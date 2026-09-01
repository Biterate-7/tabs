/**
 * A node in a workspace's hierarchical organization tree: Category (depth 0,
 * `parentId === null`) → Subcategory (depth 1) → Project/topic (depth 2).
 * Lives alongside the flat legacy `CategoryId` system (src/lib/categories/*)
 * rather than replacing it — see src/lib/sections/migrate.ts for how a
 * workspace's existing categories seed its initial root sections.
 */
export type SectionSource = "ai" | "user";

export type Section = {
  id: string;
  /** null = root (category-equivalent, depth 0). */
  parentId: string | null;
  name: string;
  source: SectionSource;
  createdAt: number;
  updatedAt: number;
};

/** Root(0) → Subcategory(1) → Project(2). A depth-2 section may not have children. */
export const MAX_SECTION_DEPTH = 2;

export type OrganizationStatus = "classified" | "uncertain" | "fallback";
