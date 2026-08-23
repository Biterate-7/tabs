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
};

export type ParseResult = {
  tabs: Tab[];
  invalidCount: number;
};
