import { describe, expect, it } from "vitest";
import {
  matchesQuery,
  filterTabs,
  sortTabs,
  categoryCounts,
} from "./search";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("matchesQuery", () => {
  it("matches on title", () => {
    const tab = makeTab({ title: "My Great Article" });
    expect(matchesQuery(tab, "great")).toBe(true);
  });

  it("matches on domain", () => {
    const tab = makeTab({ domain: "github.com" });
    expect(matchesQuery(tab, "GITHUB")).toBe(true);
  });

  it("matches on url", () => {
    const tab = makeTab({ url: "https://example.com/deep/path" });
    expect(matchesQuery(tab, "deep/path")).toBe(true);
  });

  it("matches on category display name", () => {
    const tab = makeTab({ category: "research" });
    expect(matchesQuery(tab, "resea")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    const tab = makeTab({ title: "Foo", domain: "bar.com" });
    expect(matchesQuery(tab, "zzz")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesQuery(makeTab({}), "")).toBe(true);
  });
});

describe("filterTabs", () => {
  const tabs = [
    makeTab({ id: "1", domain: "github.com", category: "projects" }),
    makeTab({ id: "2", domain: "arxiv.org", category: "research" }),
    makeTab({ id: "3", domain: "github.io", category: "projects" }),
  ];

  it("filters by query only", () => {
    expect(filterTabs(tabs, { query: "github", categoryId: "all" })).toHaveLength(2);
  });

  it("filters by category only", () => {
    expect(filterTabs(tabs, { query: "", categoryId: "research" })).toEqual([tabs[1]]);
  });

  it("combines query and category", () => {
    expect(
      filterTabs(tabs, { query: "github", categoryId: "projects" })
    ).toHaveLength(2);
    expect(
      filterTabs(tabs, { query: "arxiv", categoryId: "projects" })
    ).toHaveLength(0);
  });

  it("returns everything for an empty query and 'all' category", () => {
    expect(filterTabs(tabs, { query: "", categoryId: "all" })).toHaveLength(3);
  });
});

describe("filterTabs duplicatesOnly", () => {
  it("returns only duplicate-flagged tabs when duplicatesOnly is set", () => {
    const tabs = [
      makeTab({ id: "1", domain: "a.com", isDuplicate: false }),
      makeTab({ id: "2", domain: "b.com", isDuplicate: true }),
    ];
    const result = filterTabs(tabs, { query: "", categoryId: "all", duplicatesOnly: true });
    expect(result).toHaveLength(1);
    expect(result[0].id).toBe("2");
  });

  it("combines with query and category filters", () => {
    const tabs = [
      makeTab({ id: "1", domain: "a.com", isDuplicate: true, category: "research" }),
      makeTab({ id: "2", domain: "b.com", isDuplicate: true, category: "news" }),
    ];
    const result = filterTabs(tabs, { query: "", categoryId: "research", duplicatesOnly: true });
    expect(result.map((t) => t.id)).toEqual(["1"]);
  });
});

describe("sortTabs", () => {
  const tabs = [
    makeTab({ id: "1", domain: "zebra.com", title: "Zeta", category: "shopping" }),
    makeTab({ id: "2", domain: "alpha.com", title: "Alpha", category: "research" }),
    makeTab({ id: "3", domain: "middle.com", category: "projects" }),
  ];

  it("'recent' preserves original order", () => {
    expect(sortTabs(tabs, "recent").map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("sorts by title (falling back to domain when title is absent)", () => {
    expect(sortTabs(tabs, "title").map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts by domain", () => {
    expect(sortTabs(tabs, "domain").map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts by category display name", () => {
    expect(sortTabs(tabs, "category").map((t) => t.id)).toEqual(["3", "2", "1"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...tabs];
    sortTabs(tabs, "title");
    expect(tabs).toEqual(copy);
  });
});

describe("categoryCounts", () => {
  it("counts tabs per category, including zero for unused ones", () => {
    const tabs = [
      makeTab({ id: "1", category: "projects" }),
      makeTab({ id: "2", category: "projects" }),
    ];
    const counts = categoryCounts(tabs);
    expect(counts.projects).toBe(2);
    expect(counts.research).toBe(0);
    expect(Object.keys(counts)).toHaveLength(8);
  });
});

describe("performance", () => {
  it("filters and sorts 500 tabs quickly", () => {
    const categories = ["research", "school", "projects", "shopping", "creative", "news", "read-later", "other"] as const;
    const tabs = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      url: `https://example${i}.com/page`,
      normalizedUrl: `https://example${i}.com/page`,
      domain: `example${i}.com`,
      category: categories[i % categories.length],
      title: `Page ${i}`,
    }));

    const start = performance.now();
    const filtered = filterTabs(tabs, { query: "page", categoryId: "all" });
    const sorted = sortTabs(filtered, "title");
    const elapsed = performance.now() - start;

    expect(sorted).toHaveLength(500);
    expect(elapsed).toBeLessThan(200);
  });
});
