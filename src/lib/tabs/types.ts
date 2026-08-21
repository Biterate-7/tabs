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
};

export type ParseResult = {
  tabs: Tab[];
  invalidCount: number;
};
