/**
 * The reported failure, end to end: a subsection correctly containing one
 * YouTube video pulled in every OTHER YouTube tab in the dump.
 *
 * These drive the real pipeline (organizeTabsCollectively) against a mock AI,
 * because no single stage owns the bug — the clustering put the tabs in one
 * cluster, and the cluster stage then filed every member of that cluster at
 * one path. The assertions are therefore about where tabs LAND, not about
 * which intermediate structure produced them.
 *
 * The invariant throughout: a shared website may put tabs in the same
 * PLATFORM bucket (that is the existing, deliberate "14 Instagram tabs become
 * an Instagram section" behaviour), but it may never put them in the same
 * TOPICAL subsection. Semantic relevance decides topical membership; the
 * platform is metadata.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { organizeTabsCollectively } from "./pipeline";
import type { Section } from "../types";
import type { Tab } from "@/lib/tabs/types";

function yt(id: string, title: string): Tab {
  return {
    id,
    url: `https://www.youtube.com/watch?v=${id}`,
    normalizedUrl: `https://www.youtube.com/watch?v=${id}`,
    domain: "www.youtube.com",
    title,
    category: "other",
  };
}

function site(id: string, domain: string, title: string): Tab {
  return { id, url: `https://${domain}/${id}`, normalizedUrl: `https://${domain}/${id}`, domain, title, category: "other" };
}

/**
 * A model that recognizes topics from the titles it is shown and is otherwise
 * unopinionated — the same shape as pipeline.test.ts's mock. It deliberately
 * answers confidently, because the bug was never the model being wrong: it
 * named a cluster from the titles it was given, and the pipeline then applied
 * that name to tabs the model had never been shown.
 */
function installAiMock() {
  vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const prompt: string = body.prompt;
    const isClusterPrompt = /\bsize=\d+/.test(prompt);
    const key = isClusterPrompt ? "clusterId" : "tabId";
    const data = prompt
      .split("\n")
      .filter((l) => l.startsWith("- id="))
      .map((line) => {
        const id = /id=(\S+)/.exec(line)![1];
        if (/projectile|kinematic|launch/i.test(line)) {
          return { [key]: id, path: ["Physics", "Projectile Motion"], confidence: "high", reason: "" };
        }
        if (/chemistry/i.test(line)) return { [key]: id, path: ["Chemistry", "Organic Chemistry"], confidence: "high", reason: "" };
        if (/inflation|economic/i.test(line)) return { [key]: id, path: ["Economics", "Inflation"], confidence: "high", reason: "" };
        return { [key]: id, path: ["Other"], confidence: "low", reason: "" };
      });
    return new Response(JSON.stringify({ data }), { status: 200 });
  });
}

/** "Physics > Projectile Motion" for a placed tab, or "(unplaced)". */
function pathOf(tab: Tab, sections: Section[]): string {
  const byId = new Map(sections.map((s) => [s.id, s]));
  const parts: string[] = [];
  let cur = tab.sectionId ? byId.get(tab.sectionId) : undefined;
  while (cur) {
    parts.unshift(cur.name);
    cur = cur.parentId ? byId.get(cur.parentId) : undefined;
  }
  return parts.join(" > ") || "(unplaced)";
}

/** Whether two tabs ended up in the same section. */
function together(a: Tab, b: Tab): boolean {
  return Boolean(a.sectionId) && a.sectionId === b.sectionId;
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("a shared platform never establishes topical membership", () => {
  it("TEST 1 — one relevant YouTube tab does not drag the rest of YouTube into its subsection", async () => {
    installAiMock();
    const tabs = [
      yt("p1", "Projectile Motion Explained"),
      yt("p2", "Projectile Motion Practice Problems"),
      yt("c1", "Organic Chemistry Basics"),
      yt("e1", "Economics: Inflation Explained"),
      yt("g1", "Insane Gaming Highlights Montage"),
    ];

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    const by = (id: string) => result.tabs.find((t) => t.id === id)!;

    expect(pathOf(by("p1"), result.sections)).toBe("Physics > Projectile Motion");
    expect(pathOf(by("p2"), result.sections)).toBe("Physics > Projectile Motion");

    for (const id of ["c1", "e1", "g1"]) {
      expect(together(by(id), by("p1")), `${id} must not be filed with the projectile-motion videos`).toBe(false);
      expect(pathOf(by(id), result.sections)).not.toContain("Projectile Motion");
    }
  });

  it("TEST 2 — relevant tabs from different sites group together while unrelated same-site ones stay out", async () => {
    installAiMock();
    const tabs = [
      yt("p1", "Projectile Motion Explained"),
      site("w1", "en.wikipedia.org", "Projectile motion"),
      site("k1", "khanacademy.org", "Projectile motion review"),
      yt("i1", "Calculus Integration By Parts"),
      yt("d1", "History Documentary: The Silk Road"),
    ];

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    const by = (id: string) => result.tabs.find((t) => t.id === id)!;

    // Cross-domain semantic grouping still works.
    expect(together(by("p1"), by("w1"))).toBe(true);
    expect(together(by("p1"), by("k1"))).toBe(true);
    expect(pathOf(by("p1"), result.sections)).toBe("Physics > Projectile Motion");

    // …and the YouTube tabs about other subjects are not swept along with it.
    expect(together(by("i1"), by("p1"))).toBe(false);
    expect(together(by("d1"), by("p1"))).toBe(false);
  });

  it("TEST 3 — same site, different subjects never share a topical subsection", async () => {
    installAiMock();
    const tabs = [
      yt("a1", "Organic Chemistry Basics"),
      yt("b1", "Economics: Inflation Explained"),
      yt("c1", "Insane Gaming Highlights Montage"),
      yt("d1", "Sourdough Starter From Scratch"),
    ];

    const result = await organizeTabsCollectively("w1", "General", tabs, []);

    // They may share a PLATFORM bucket — a section named for the site itself
    // is the existing, deliberate behaviour ("14 Instagram tabs become an
    // Instagram section") and makes no claim about subject. What they may
    // never share is a section that names a subject none of them is about.
    const shared = new Map<string, Tab[]>();
    for (const tab of result.tabs) {
      if (!tab.sectionId) continue;
      const bucket = shared.get(tab.sectionId);
      if (bucket) bucket.push(tab);
      else shared.set(tab.sectionId, [tab]);
    }
    for (const [, members] of shared) {
      if (members.length < 2) continue;
      const where = pathOf(members[0], result.sections);
      expect(where, `${members.map((t) => t.title).join(" + ")} share a section`).toMatch(/youtube/i);
    }
  });

  it("TEST 4 — different sites, same subject can share a subsection", async () => {
    installAiMock();
    const tabs = [
      yt("y1", "Projectile Motion Explained"),
      site("w1", "en.wikipedia.org", "Projectile motion"),
      site("k1", "khanacademy.org", "Projectile motion review"),
      site("b1", "physicsclassroom.com", "Projectile motion problems"),
      // Unrelated ballast, so "projectile" is not present in EVERY tab in the
      // dump. Keyword clustering discards a token carried by more than 75% of
      // the library as too generic to mean anything (cluster.ts's
      // MAX_KEYWORD_DOC_FRACTION), so a workspace consisting of nothing but
      // one topic has no keyword signal at all to cluster on — a real library
      // never looks like that, and the fixture should not either.
      site("z1", "news.ycombinator.com", "Show HN: a terminal file manager"),
      site("z2", "amazon.com", "Amazon.com: usb-c cable"),
      site("z3", "reddit.com", "Best noise cancelling headphones?"),
    ];

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    const physics = ["y1", "w1", "k1", "b1"].map((id) => result.tabs.find((t) => t.id === id)!);
    const ids = new Set(physics.map((t) => t.sectionId));
    expect(ids.size, "four tabs on one subject, from four sites, belong in one section").toBe(1);
    expect(pathOf(physics[0], result.sections)).toBe("Physics > Projectile Motion");
  });

  it("TEST 5 — a genuine website cluster still becomes that website's section", async () => {
    // The behaviour that must survive all of the above: domain clustering is
    // load-bearing, and removing it is not a fix.
    installAiMock();
    const tabs = Array.from({ length: 6 }, (_, i) =>
      site(`i${i}`, i % 2 === 0 ? "www.instagram.com" : "instagram.com", i === 0 ? "Instagram" : `Reel ${i} • Instagram`)
    );

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    const ids = new Set(result.tabs.map((t) => t.sectionId));
    expect(ids.size, "one site, one section").toBe(1);
    expect(result.tabs.every((t) => Boolean(t.sectionId))).toBe(true);
    expect(pathOf(result.tabs[0], result.sections)).toContain("Instagram");
  });

  it("released tabs are still placed somewhere — nothing is dropped", async () => {
    installAiMock();
    const tabs = [
      yt("p1", "Projectile Motion Explained"),
      yt("p2", "Projectile Motion Practice Problems"),
      yt("c1", "Organic Chemistry Basics"),
      yt("e1", "Economics: Inflation Explained"),
      yt("g1", "Insane Gaming Highlights Montage"),
    ];

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    expect(result.tabs).toHaveLength(tabs.length);
    expect(result.tabs.every((t) => Boolean(t.sectionId)), "every tab lands in a section").toBe(true);
  });
});
