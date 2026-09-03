import { describe, expect, it } from "vitest";
import { buildRawClusters } from "./cluster";
import type { ScopedTab } from "./types";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string; url: string; domain: string }): Tab {
  return { normalizedUrl: over.url, title: over.domain, ...over };
}

function scoped(tab: Tab, workspaceId = "ws-1", workspaceName = "General"): ScopedTab {
  return { tab, workspaceId, workspaceName };
}

describe("buildRawClusters", () => {
  it("groups differently-worded tabs together purely from a shared semantic cluster key", () => {
    // AGENTS.md's key example: "General Relativity Notes" / "Schwarzschild
    // Metric" / "S2 Star Orbit Data" share no meaningful keyword and live on
    // different domains — only the semantic hint (computed client-side from
    // embeddings, see src/lib/ai/cluster.ts) can group them.
    const tabs = [
      scoped(makeTab({ id: "t1", url: "https://a.example/1", domain: "arxiv.org", title: "General Relativity Notes" })),
      scoped(makeTab({ id: "t2", url: "https://b.example/2", domain: "wikipedia.org", title: "Schwarzschild Metric" })),
      scoped(makeTab({ id: "t3", url: "https://c.example/3", domain: "nasa.gov", title: "S2 Star Orbit Data" })),
    ];

    const withoutHints = buildRawClusters(tabs, []);
    expect(withoutHints.every((c) => c.tabIds.length === 1)).toBe(true);

    const withHints = buildRawClusters(tabs, [
      { tabId: "t1", clusterKey: "sem-0" },
      { tabId: "t2", clusterKey: "sem-0" },
      { tabId: "t3", clusterKey: "sem-0" },
    ]);
    expect(withHints).toHaveLength(1);
    expect(new Set(withHints[0].tabIds)).toEqual(new Set(["t1", "t2", "t3"]));
    for (const id of ["t1", "t2", "t3"]) expect(withHints[0].joinReasons.get(id)).toBe("semantic");
  });

  it("groups tabs sharing a non-generic domain", () => {
    const tabs = [
      scoped(makeTab({ id: "t1", url: "https://github.com/a", domain: "github.com", title: "repo a" })),
      scoped(makeTab({ id: "t2", url: "https://github.com/b", domain: "github.com", title: "repo b" })),
    ];
    const clusters = buildRawClusters(tabs, []);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].joinReasons.get("t1")).toBe("domain");
  });

  it("never clusters tabs purely by a generic domain like google.com", () => {
    const tabs = [
      scoped(makeTab({ id: "t1", url: "https://google.com/search?q=a", domain: "google.com", title: "a - Google Search" })),
      scoped(makeTab({ id: "t2", url: "https://google.com/search?q=b", domain: "google.com", title: "b - Google Search" })),
    ];
    const clusters = buildRawClusters(tabs, []);
    expect(clusters.every((c) => c.tabIds.length === 1)).toBe(true);
  });

  it("groups tabs sharing a rare, specific keyword even across different domains", () => {
    const tabs = [
      scoped(makeTab({ id: "t1", url: "https://a.example/1", domain: "a.example", title: "Schwarzschild radius calculation" })),
      scoped(makeTab({ id: "t2", url: "https://b.example/2", domain: "b.example", title: "Understanding the Schwarzschild solution" })),
    ];
    const clusters = buildRawClusters(tabs, []);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].joinReasons.get("t1")).toBe("keyword");
  });

  it("does not let an overly generic keyword (present in most of the library) merge unrelated tabs", () => {
    const tabs = Array.from({ length: 10 }, (_, i) =>
      scoped(makeTab({ id: `t${i}`, url: `https://site${i}.example/page`, domain: `site${i}.example`, title: `Guide to topic ${i}` }))
    );
    // "guide" is filtered as a stopword already, but confirm no accidental
    // mega-cluster forms from a token that appears in nearly every tab.
    const clusters = buildRawClusters(tabs, []);
    expect(clusters.every((c) => c.tabIds.length === 1)).toBe(true);
  });

  it("groups tabs sharing a site across www/m/mobile host variants as one domain cluster", () => {
    const tabs = [
      scoped(makeTab({ id: "t1", url: "https://www.instagram.com/a", domain: "www.instagram.com", title: "Instagram" })),
      scoped(makeTab({ id: "t2", url: "https://m.instagram.com/b", domain: "m.instagram.com", title: "Login • Instagram" })),
      scoped(makeTab({ id: "t3", url: "https://instagram.com/c", domain: "instagram.com", title: "Reels • Instagram" })),
    ];
    const clusters = buildRawClusters(tabs, []);
    expect(clusters).toHaveLength(1);
    expect(clusters[0].tabIds).toHaveLength(3);
    expect(clusters[0].dominantDomain).toBe("instagram.com");
    expect(clusters[0].domainShare).toBe(1);
  });

  it("clusters YouTube, Gmail, ChatGPT, and Amazon by domain (previously excluded as 'generic')", () => {
    for (const [domain, title] of [
      ["youtube.com", "Some Cool Video - YouTube"],
      ["mail.google.com", "Inbox (4) - Gmail"],
      ["chatgpt.com", "New chat - ChatGPT"],
      ["amazon.com", "Amazon.com: wireless mouse"],
    ] as const) {
      const tabs = [
        scoped(makeTab({ id: "a", url: `https://${domain}/1`, domain, title })),
        scoped(makeTab({ id: "b", url: `https://${domain}/2`, domain, title: `${title} 2` })),
      ];
      const clusters = buildRawClusters(tabs, []);
      expect(clusters, `expected ${domain} to cluster`).toHaveLength(1);
      expect(clusters[0].joinReasons.get("a")).toBe("domain");
    }
  });

  it("still refuses to cluster bare google.com/bing.com search results by domain alone", () => {
    for (const domain of ["google.com", "bing.com"]) {
      const tabs = [
        scoped(makeTab({ id: "a", url: `https://${domain}/search?q=a`, domain, title: "a - Search" })),
        scoped(makeTab({ id: "b", url: `https://${domain}/search?q=b`, domain, title: "b - Search" })),
      ];
      const clusters = buildRawClusters(tabs, []);
      expect(clusters.every((c) => c.tabIds.length === 1)).toBe(true);
    }
  });

  it("does not let a keyword shared between two unrelated pairs transitively bridge two different site clusters", () => {
    // Regression for the reported 139/185 "Other" failure: two GitHub tabs
    // and two Notion tabs, individually unrelated, but one GitHub tab and one
    // Notion tab happen to both mention a project name ("tabdump") — before
    // domain-locking, union-find's transitive closure merged the whole
    // GitHub+Notion (+ anything else in the chain) group into one cluster.
    const tabs = [
      scoped(makeTab({ id: "gh1", url: "https://github.com/1", domain: "github.com", title: "GitHub" })),
      scoped(makeTab({ id: "gh2", url: "https://github.com/2", domain: "github.com", title: "biterate/tabdump" })),
      scoped(makeTab({ id: "nt1", url: "https://notion.so/1", domain: "notion.so", title: "TabDump roadmap - Notion" })),
      scoped(makeTab({ id: "nt2", url: "https://notion.so/2", domain: "notion.so", title: "Meeting notes - Notion" })),
    ];
    const clusters = buildRawClusters(tabs, []);
    const githubCluster = clusters.find((c) => c.tabIds.includes("gh1"));
    const notionCluster = clusters.find((c) => c.tabIds.includes("nt1"));
    expect(githubCluster).toBeDefined();
    expect(notionCluster).toBeDefined();
    expect(githubCluster).not.toBe(notionCluster);
    expect(githubCluster?.tabIds.sort()).toEqual(["gh1", "gh2"]);
    expect(notionCluster?.tabIds.sort()).toEqual(["nt1", "nt2"]);
  });
});
