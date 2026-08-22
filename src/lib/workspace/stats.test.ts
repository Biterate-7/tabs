import { describe, expect, it } from "vitest";
import { computeOverview, groupByCategory, representativeTabLabels } from "./stats";
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

describe("computeOverview", () => {
  it("counts total, unique, categoriesInUse, and duplicates", () => {
    const tabs = [
      makeTab({ id: "1", category: "projects" }),
      makeTab({ id: "2", category: "projects", isDuplicate: true }),
      makeTab({ id: "3", category: "research" }),
    ];
    expect(computeOverview(tabs)).toEqual({
      total: 3,
      unique: 2,
      categoriesInUse: 2,
      duplicates: 1,
    });
  });

  it("handles an empty workspace", () => {
    expect(computeOverview([])).toEqual({
      total: 0,
      unique: 0,
      categoriesInUse: 0,
      duplicates: 0,
    });
  });
});

describe("groupByCategory", () => {
  it("buckets tabs under every one of the 8 categories, including empty ones", () => {
    const tabs = [makeTab({ id: "1", category: "projects" })];
    const groups = groupByCategory(tabs);
    expect(Object.keys(groups)).toHaveLength(8);
    expect(groups.projects).toHaveLength(1);
    expect(groups.research).toHaveLength(0);
  });

  it("falls back tabs with no category to other", () => {
    const tabs = [makeTab({ id: "1", category: undefined })];
    const groups = groupByCategory(tabs);
    expect(groups.other).toHaveLength(1);
  });
});

describe("representativeTabLabels", () => {
  it("returns up to `limit` unique domains, duplicates excluded first", () => {
    const tabs = [
      makeTab({ id: "1", domain: "a.com" }),
      makeTab({ id: "2", domain: "a.com", isDuplicate: true }),
      makeTab({ id: "3", domain: "b.com" }),
      makeTab({ id: "4", domain: "c.com" }),
      makeTab({ id: "5", domain: "d.com" }),
    ];
    expect(representativeTabLabels(tabs, 3)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("returns an empty array for no tabs", () => {
    expect(representativeTabLabels([], 3)).toEqual([]);
  });

  it("prefers the resolved title over the domain", () => {
    const tabs = [
      makeTab({ id: "1", domain: "github.com", title: "GitHub · Change Password" }),
    ];
    expect(representativeTabLabels(tabs, 3)).toEqual(["GitHub · Change Password"]);
  });

  it("falls back to the domain when no title is resolved", () => {
    const tabs = [makeTab({ id: "1", domain: "github.com", title: undefined })];
    expect(representativeTabLabels(tabs, 3)).toEqual(["github.com"]);
  });

  it("falls back to the domain when the title is blank", () => {
    const tabs = [makeTab({ id: "1", domain: "github.com", title: "   " })];
    expect(representativeTabLabels(tabs, 3)).toEqual(["github.com"]);
  });

  it("handles a mix of tabs with and without resolved titles", () => {
    const tabs = [
      makeTab({ id: "1", domain: "github.com", title: "GitHub · Change Password" }),
      makeTab({ id: "2", domain: "vercel.com" }),
      makeTab({ id: "3", domain: "mail.google.com", title: "Inbox (4) — Gmail" }),
    ];
    expect(representativeTabLabels(tabs, 3)).toEqual([
      "GitHub · Change Password",
      "vercel.com",
      "Inbox (4) — Gmail",
    ]);
  });
});
