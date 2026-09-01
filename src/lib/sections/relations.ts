import { createId } from "@/lib/id";
import { MAX_SECTION_DEPTH } from "./types";
import type { Section, SectionSource } from "./types";

/** Depth of `id` within `sections` (0 = root). Returns -1 if `id` isn't found. */
export function sectionDepth(sections: Section[], id: string): number {
  const byId = new Map(sections.map((s) => [s.id, s]));
  let depth = 0;
  let current = byId.get(id);
  if (!current) return -1;
  const seen = new Set<string>([current.id]);
  while (current.parentId !== null) {
    const parent = byId.get(current.parentId);
    // Missing parent (dangling reference) or one already visited (a cycle,
    // possible in hand-edited/corrupted data) — either way, stop rather than
    // looping forever; treat `current` as if it were a root from here.
    if (!parent || seen.has(parent.id)) break;
    seen.add(parent.id);
    depth += 1;
    current = parent;
  }
  return depth;
}

/** Root-to-leaf chain of sections ending at `id` (inclusive). Empty array if `id` isn't found. */
export function sectionPath(sections: Section[], id: string): Section[] {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const path: Section[] = [];
  let current = byId.get(id);
  const seen = new Set<string>();
  while (current && !seen.has(current.id)) {
    path.unshift(current);
    seen.add(current.id);
    current = current.parentId ? byId.get(current.parentId) : undefined;
  }
  return path;
}

/** Every id descended from `id` (children, grandchildren, ...), not including `id` itself. */
export function descendantIds(sections: Section[], id: string): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const s of sections) {
    if (s.parentId === null) continue;
    const list = childrenOf.get(s.parentId);
    if (list) list.push(s.id);
    else childrenOf.set(s.parentId, [s.id]);
  }
  const out: string[] = [];
  const seen = new Set<string>([id]); // guards against a cycle in hand-edited/corrupted data
  const queue = [...(childrenOf.get(id) ?? [])];
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (seen.has(next)) continue;
    seen.add(next);
    out.push(next);
    queue.push(...(childrenOf.get(next) ?? []));
  }
  return out;
}

export function rootSections(sections: Section[]): Section[] {
  return sections.filter((s) => s.parentId === null);
}

export function childrenOf(sections: Section[], parentId: string): Section[] {
  return sections.filter((s) => s.parentId === parentId);
}

/**
 * Creates a new section under `parentId` (null = root). Returns `null`
 * instead of creating anything when `parentId` is already at MAX_SECTION_DEPTH
 * (a project/depth-2 section may not have children) or doesn't exist.
 */
/**
 * "Other" is reserved for the synthetic fallback bucket every section tree
 * always has (src/lib/sections/tree.ts's OTHER_SECTION_ID) — a real,
 * persisted root section with the same name would render as a confusing
 * duplicate "Other" tile. Only guarded at the root: a subsection named
 * "Other" under a real category doesn't collide with anything.
 */
function isReservedRootOtherName(name: string): boolean {
  return name.trim().toLowerCase() === "other";
}

export function createSection(
  sections: Section[],
  parentId: string | null,
  name: string,
  source: SectionSource,
  now: number = Date.now()
): { sections: Section[]; section: Section } | null {
  const trimmed = name.trim();
  if (!trimmed) return null;
  if (parentId === null && isReservedRootOtherName(trimmed)) return null;

  if (parentId !== null) {
    const parentDepth = sectionDepth(sections, parentId);
    if (parentDepth === -1 || parentDepth >= MAX_SECTION_DEPTH) return null;
  }

  const section: Section = {
    id: createId("section"),
    parentId,
    name: trimmed,
    source,
    createdAt: now,
    updatedAt: now,
  };
  return { sections: [...sections, section], section };
}

export function renameSection(sections: Section[], id: string, name: string): Section[] {
  const trimmed = name.trim();
  if (!trimmed) return sections;
  const now = Date.now();
  return sections.map((s) => (s.id === id ? { ...s, name: trimmed, updatedAt: now } : s));
}

/**
 * Removes `id` and every descendant section. Returns the removed ids
 * (including `id` itself) so the caller can reassign/unset `sectionId` on
 * every tab that pointed at any of them — this function never touches tabs.
 */
export function deleteSection(sections: Section[], id: string): { sections: Section[]; removedIds: string[] } {
  const removedIds = [id, ...descendantIds(sections, id)];
  const removedSet = new Set(removedIds);
  return { sections: sections.filter((s) => !removedSet.has(s.id)), removedIds };
}

/**
 * Moves `id` under `newParentId` (null = make it a root). Returns `null`
 * (no-op) rather than mutating anything when the move would create a cycle
 * (`newParentId` is `id` itself or one of its own descendants) or would push
 * `id`'s subtree past MAX_SECTION_DEPTH.
 */
export function moveSection(sections: Section[], id: string, newParentId: string | null): Section[] | null {
  if (newParentId === id) return null;
  if (newParentId !== null) {
    if (descendantIds(sections, id).includes(newParentId)) return null;
    const newParentDepth = sectionDepth(sections, newParentId);
    if (newParentDepth === -1 || newParentDepth >= MAX_SECTION_DEPTH) return null;
    // The subtree being moved must still fit under the new depth — a
    // section with its own children can't be moved to depth MAX_SECTION_DEPTH.
    const subtreeHeight = Math.max(0, ...descendantIds(sections, id).map((d) => sectionDepth(sections, d) - sectionDepth(sections, id)));
    if (newParentDepth + 1 + subtreeHeight > MAX_SECTION_DEPTH) return null;
  }
  const now = Date.now();
  return sections.map((s) => (s.id === id ? { ...s, parentId: newParentId, updatedAt: now } : s));
}
