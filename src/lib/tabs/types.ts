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
};

export type ParseResult = {
  tabs: Tab[];
  invalidCount: number;
};
