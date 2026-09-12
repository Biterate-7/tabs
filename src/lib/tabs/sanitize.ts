import { isValidTimestamp } from "@/lib/timestamps";
import type { Tab } from "./types";

/**
 * `Tab` fields typed `string | undefined` that are read as strings.
 *
 * `title?.trim()` alone appears in roughly a dozen render paths, and `?.`
 * guards null — not a number. So a tab carrying `"title": 12345` throws
 * "title?.trim is not a function" the first time the graph or a tab card
 * draws it, which in practice means the whole app fails to start.
 *
 * `id`/`url`/`normalizedUrl`/`domain` are absent because they are required
 * and already type-checked by every entry point. `groupId`/`sectionId` are
 * absent because the import path resolves those through their own id maps.
 */
export const OPTIONAL_STRING_TAB_FIELDS = [
  "category",
  "title",
  "favicon",
  "notes",
  "organizationReason",
] as const;

/**
 * Timestamp fields on a `Tab`. Both optional (a tab may predate them), both
 * epoch-ms numbers when present.
 *
 * These get the same repair-don't-reject treatment as the string fields
 * above, for the same reason: a hand-edited file carrying
 * `"updatedAt": "yesterday"` or `{}` would otherwise be compared against a
 * real number by every later sync decision. Dropping the field leaves the
 * tab in the honest "unknown" state it would have had before timestamps
 * existed, which the rest of the code already handles.
 */
const TIMESTAMP_TAB_FIELDS = ["createdAt", "updatedAt"] as const;

/**
 * Strips the fields above from `tab` when they are not strings, and any
 * timestamp field that is not a finite number.
 *
 * Both places that turn outside data into `Tab`s use this, so they cannot
 * drift apart:
 *
 * - `parseWorkspaceExport` (src/lib/workspace/json-import.ts) — an export
 *   file is a plain .json someone can hand you or edit by hand.
 * - `loadWorkspaceStore` (src/lib/workspace/persistence.ts) — localStorage
 *   is untrusted persisted input too. It can hold a tab written by a build
 *   from before these checks existed, which is the case import-time
 *   validation alone can never reach.
 *
 * Deliberately repairs rather than rejects: it removes the offending field
 * and keeps the tab. Dropping the row (or refusing the whole store) would
 * turn one bad value into silent data loss, and a workspace is the user's
 * own content — the goal is that the app still starts, not that the record
 * disappears.
 *
 * Mutates and returns the same object; callers here own freshly built tabs.
 */
export function stripWrongTypedTabFields(tab: Tab): Tab {
  const raw = tab as unknown as Record<string, unknown>;
  for (const field of OPTIONAL_STRING_TAB_FIELDS) {
    if (field in raw && typeof raw[field] !== "string") delete raw[field];
  }
  for (const field of TIMESTAMP_TAB_FIELDS) {
    if (field in raw && !isValidTimestamp(raw[field])) delete raw[field];
  }
  return tab;
}
