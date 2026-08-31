export type Tab = {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  category?: string;
  confidence?: number;
  title?: string;
  favicon?: string;
  isDuplicate?: boolean;
  /** Set when a tab arrives via the browser extension's pinned-tab state. */
  pinned?: boolean;
  /**
   * The id of a Group (see src/lib/workspace/types.ts) this tab belongs to,
   * within whichever workspace currently holds this tab. Optional for
   * backward compat with tabs saved before group membership existed — an
   * absent value just means "ungrouped," not "invalid." Invariant enforced
   * by the store/action layer (never by this type alone): a tab's groupId
   * must always reference a group that lives in the SAME workspace as the
   * tab itself — see assignTabsToGroup in src/lib/workspace/store.ts.
   */
  groupId?: string;
  /** Freeform personal note for this tab. Absent (not an empty string) means no note — see tab-notes-button.tsx, which normalizes whitespace-only input back to undefined on save. */
  notes?: string;
  /** User-toggled "keep this close" flag — see tab-favorite-button.tsx. Absent (not false) for tabs saved before Favorites existed; treated identically to false everywhere it's read. */
  isFavorite?: boolean;
  /** Epoch ms of the last time the user intentionally opened this tab from TabDump (see openTab call sites) — never set just from the tab rendering, being hovered, or appearing in Graph. Absent means "never opened from here." Drives the Recents view (src/lib/workspace/recents.ts) and Favorites' default sort. */
  lastAccessedAt?: number;
};

export type ParseResult = {
  tabs: Tab[];
  invalidCount: number;
};
