import { createTimestamp } from "@/lib/timestamps";
import type { Tab } from "./types";

/**
 * Fields that must not, on their own, count as a modification.
 *
 * `isDuplicate` is derived: `markDuplicates()` recomputes it across the whole
 * list from `normalizedUrl`, so it churns on tabs nobody touched. Moving one
 * tab into a workspace re-marks every tab already there — treating that as a
 * modification would stamp the entire workspace as edited, which is exactly
 * the "unrelated entity changed" case the timestamp contract forbids.
 *
 * `updatedAt` itself is excluded for the obvious reason: comparing it would
 * make every tab differ from itself the moment it is stamped once.
 */
const NON_MATERIAL_TAB_FIELDS = new Set<keyof Tab>(["isDuplicate", "updatedAt"]);

/**
 * Whether two versions of the same tab differ in state the user owns.
 *
 * A shallow key-by-key comparison is enough because `Tab` is flat — every
 * field is a primitive. If a nested field is ever added, this needs to know
 * about it.
 */
export function tabContentChanged(before: Tab, after: Tab): boolean {
  if (before === after) return false;

  const keys = new Set([...Object.keys(before), ...Object.keys(after)] as (keyof Tab)[]);
  for (const key of keys) {
    if (NON_MATERIAL_TAB_FIELDS.has(key)) continue;
    if (before[key] !== after[key]) return true;
  }
  return false;
}

/**
 * Stamps `updatedAt` on exactly the tabs whose state actually changed.
 *
 * The bulk setters hand over a whole replacement array — a rename, a
 * category change and a reorder all arrive the same way — so the only way to
 * keep `updatedAt` meaningful is to compare against what was there before.
 * Without this, re-saving an unchanged workspace would mark every tab as
 * modified, and a later sync would treat the entire workspace as newer than
 * whatever another device had.
 *
 * This only ever sets `updatedAt`, and only on a tab that was already here
 * and has actually changed. It deliberately does NOT stamp tabs that are new
 * to the list:
 *
 *  - a tab built by `toTab` already carries both timestamps;
 *  - a tab from an import carries whatever the file stated, which must
 *    survive untouched;
 *  - a tab from neither has no honest creation time, and inventing one here
 *    would be the same lie as backfilling on load.
 *
 * `createdAt` is never written or rewritten by this function. A tab that
 * predates timestamps gains an `updatedAt` the first time it is modified and
 * keeps an absent `createdAt`.
 */
export function stampChangedTabs(before: Tab[], after: Tab[], now = createTimestamp()): Tab[] {
  if (before === after) return after;

  const previous = new Map(before.map((tab) => [tab.id, tab]));
  let anyChanged = false;

  const stamped = after.map((tab) => {
    const prior = previous.get(tab.id);
    if (!prior) return tab;
    if (!tabContentChanged(prior, tab)) return tab;
    anyChanged = true;
    return { ...tab, updatedAt: now };
  });

  return anyChanged ? stamped : after;
}
