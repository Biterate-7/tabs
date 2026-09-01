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
  /** Where this tab was dumped from. Absent means "tabs" (the original, and still overwhelmingly common, path) — never written explicitly for that case, so every tab saved before History Dump existed is indistinguishable from an ordinary dump. Set to "history" only by buildTabsFromBrowserImport when the source BrowserImportEntry carries it (see src/lib/tabs/browser-import.ts, src/lib/history-dump/). */
  source?: "tabs" | "history";
  /** chrome.history.HistoryItem.visitCount at the moment this tab was dumped from History Dump — a point-in-time snapshot, not kept in sync afterward. Absent for source !== "history". */
  historyVisitCount?: number;
  /** Epoch ms of the history entry's last visit at the moment it was dumped — distinct from lastAccessedAt, which only ever reflects opens from *within* TabDump. Absent for source !== "history". */
  historyLastVisitedAt?: number;
  /**
   * The id of a Section (see src/lib/sections/types.ts) this tab belongs to,
   * within whichever workspace currently holds this tab — TabDump's
   * hierarchical Category/Subcategory/Project organization, distinct from
   * (and orthogonal to) the flat `category` field above. Absent means
   * "not yet organized into a section" (falls back to "Other" in the
   * section-based views). Same same-workspace invariant as `groupId`.
   */
  sectionId?: string;
  /**
   * Set the moment a user manually assigns this tab's section (drag-drop or
   * the "Move to section" menu). Once true, the AI organization engine
   * (src/lib/sections/ai/organize.ts) never reassigns this tab's sectionId
   * again — manual placement always overrides the AI.
   */
  sectionLocked?: boolean;
  /** How this tab's current sectionId was decided — "manual" whenever a user assigned/moved it (see assignTabsToSection), or set by whichever path in src/lib/sections/ai/organize.ts assigned it otherwise. Absent for tabs never run through either (e.g. pre-migration). */
  organizationStatus?: "classified" | "uncertain" | "fallback" | "manual";
  /** Short, user-facing explanation of why this tab landed in its current section (e.g. "Discusses the Schwarzschild metric, alongside 3 other physics tabs in this batch.") — the AI's own `reason` field when available, or a synthesized one from the deterministic fallback. Never raw model reasoning/chain-of-thought. Cleared whenever a user manually moves the tab (see assignTabsToSection), since a stale AI-era explanation would be actively misleading once a human decided otherwise. */
  organizationReason?: string;
};

export type ParseResult = {
  tabs: Tab[];
  invalidCount: number;
};
