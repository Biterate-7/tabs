import { describe, expect, it } from "vitest";
import { buildClusterManifest } from "./manifest";
import type { RawCluster } from "@/lib/organize/cluster";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: `https://example.com/${over.id}`, normalizedUrl: `https://example.com/${over.id}`, domain: "example.com", category: "other", ...over };
}

describe("buildClusterManifest", () => {
  it("summarizes a cluster's size, sample titles, dominant domains, and category distribution", () => {
    const tabs = [
      makeTab({ id: "1", title: "Schwarzschild radius derivation", domain: "arxiv.org", category: "school" }),
      makeTab({ id: "2", title: "Black holes explained", domain: "en.wikipedia.org", category: "school" }),
      makeTab({ id: "3", title: "S2 star orbit", domain: "arxiv.org", category: "research" }),
    ];
    const tabsById = new Map(tabs.map((t) => [t.id, t]));
    const cluster: RawCluster = { id: "c1", tabIds: ["1", "2", "3"], joinReasons: new Map([["1", "semantic"], ["2", "semantic"], ["3", "domain"]]) };

    const [entry] = buildClusterManifest([cluster], tabsById);

    expect(entry.clusterId).toBe("c1");
    expect(entry.size).toBe(3);
    expect(entry.sampleTitles).toEqual(["Schwarzschild radius derivation", "Black holes explained", "S2 star orbit"]);
    expect(entry.dominantDomains[0]).toBe("arxiv.org");
    expect(entry.categoryDistribution).toContain("School (2)");
    expect(entry.categoryDistribution).toContain("Research (1)");
    expect(entry.dominantJoinReason).toBe("semantic");
  });

  it("caps sample titles at 5 and skips missing/duplicate titles", () => {
    const tabs = Array.from({ length: 8 }, (_, i) => makeTab({ id: `${i}`, title: "Same title", domain: "example.com" }));
    tabs.push(makeTab({ id: "no-title" }));
    const tabsById = new Map(tabs.map((t) => [t.id, t]));
    const cluster: RawCluster = { id: "c1", tabIds: tabs.map((t) => t.id), joinReasons: new Map() };

    const [entry] = buildClusterManifest([cluster], tabsById);

    expect(entry.sampleTitles).toEqual(["Same title"]);
    expect(entry.size).toBe(9);
  });

  it("drops member ids that no longer resolve to a tab", () => {
    const tabsById = new Map([["1", makeTab({ id: "1" })]]);
    const cluster: RawCluster = { id: "c1", tabIds: ["1", "gone"], joinReasons: new Map() };

    const [entry] = buildClusterManifest([cluster], tabsById);

    expect(entry.size).toBe(1);
  });
});
