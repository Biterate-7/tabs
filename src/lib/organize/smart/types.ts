/**
 * Smart Organize: a proposal for sorting a messy set of tabs into groups,
 * which the person reviews, edits and confirms before anything changes.
 *
 * Two scopes, one shape:
 *
 *   open-tabs — the tabs open in Chrome (read through Hubble for Chrome). A
 *               confirmed group becomes sources in a subject, new or existing.
 *   subject   — the loose tabs already saved in one subject. A confirmed
 *               group becomes a collection in that subject, new or existing.
 *
 * Everything here is plain data. The proposal is built by ./group.ts, edited
 * by ./edit.ts and applied by ./apply.ts; none of them touches storage.
 */

export type SmartMode = "open-tabs" | "subject";

export type SmartItem = {
  /** Stable within one proposal: `chrome-<tabId>` for an open tab, the Hubble tab id for a saved one. */
  id: string;
  url: string;
  /** Strict identity (tracking parameters, fragment and trailing slash removed) — see lib/tabs/normalize.ts. */
  normalizedUrl: string;
  /** The source identity Hubble's duplicate rule uses — see lib/resources/url.ts. */
  resourceKey: string;
  domain: string;
  /** As the page reported it, trimmed. May be empty. */
  title: string;
  favicon?: string;
  /** open-tabs: the subject this page is already saved in, if any. */
  savedIn?: { workspaceId: string; name: string };
  /** subject: the collection this tab already belongs to, if any. */
  inCollection?: { collectionId: string; name: string };
};

export type SmartDestination =
  /** open-tabs: a subject created from the group's name (or the existing one with that name, at apply time). */
  | { kind: "new-subject" }
  | { kind: "subject"; workspaceId: string }
  /** subject: a collection created from the group's name (or the existing one with that name, at apply time). */
  | { kind: "new-collection" }
  | { kind: "collection"; collectionId: string };

export type SmartGroup = {
  id: string;
  name: string;
  /** What the suggestion rests on, in words — only ever evidence from the tabs themselves. */
  reason: string;
  itemIds: string[];
  destination: SmartDestination;
};

export type SmartExclusionReason =
  /** open-tabs: already a source in a subject. */
  | "already-saved"
  /** subject: already in a collection the person made. */
  | "already-in-collection"
  /** An extra copy of a page that is also being organized. */
  | "duplicate"
  /** The person took it out. */
  | "you";

export type SmartExclusion = { itemId: string; reason: SmartExclusionReason };

/** Tabs showing the same page. `exact` when the addresses match exactly; otherwise they differ only in ways Hubble ignores (www, http/https, a video timestamp). */
export type SmartDuplicateSet = { itemIds: string[]; exact: boolean };

export type SmartProposal = {
  mode: SmartMode;
  /** Every item considered, in the order it arrived. */
  items: SmartItem[];
  groups: SmartGroup[];
  /** Not confident enough to place, or left ungrouped by the person: these stay exactly where they are. */
  review: string[];
  /** Taken out of the operation: these stay exactly where they are too. */
  excluded: SmartExclusion[];
  duplicates: SmartDuplicateSet[];
  /** Items past the analysis cap that were left out entirely. */
  truncated: number;
};
