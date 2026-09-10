import { afterEach, describe, expect, it, vi } from "vitest";
import { organizeTabsCollectively } from "./pipeline";
import type { Section } from "../types";
import type { Tab } from "@/lib/tabs/types";
import { buildSyntheticDump } from "@/lib/tabs/__fixtures__/synthetic-dump";
import { buildSectionTree } from "../tree";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: `https://example.com/${over.id}`, normalizedUrl: `https://example.com/${over.id}`, domain: "example.com", category: "other", ...over };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

/** A small keyword→path table standing in for "the AI classified it correctly" — good enough to exercise the pipeline's cluster-application logic against realistic, topically-varied input without a live model. */
const TOPIC_RULES: { pattern: RegExp; path: string[] }[] = [
  { pattern: /schwarzschild|black hole|relativity|orbit|physics|quantum|photoelectric|newtonian|kepler|gravitational|electromagnetic|thermodynamics/i, path: ["School", "Physics"] },
  { pattern: /economic|gdp|inflation|macroeconomic|microeconomic|fiscal|monetary|exchange rate|unemployment|elasticity|comparative advantage/i, path: ["School", "Economics"] },
  { pattern: /world war|versailles|trench|franz ferdinand|wwi|interwar/i, path: ["School", "History"] },
  { pattern: /react|next\.js|typescript|github|vercel|css|tailwind|node\.js|hydration|useeffect|server components/i, path: ["Technology", "Web Development"] },
  { pattern: /premiere|after effects|figma|photoshop|canva|color grading|motion graphics|editing/i, path: ["Creative", "Video & Design"] },
  { pattern: /s&p|federal reserve|tradingview|bloomberg|bond yields|oil prices|tech stocks|markets/i, path: ["Finance", "Markets"] },
  { pattern: /amazon|ebay|etsy/i, path: ["Shopping"] },
];

function classifyText(text: string): string[] | null {
  for (const rule of TOPIC_RULES) if (rule.pattern.test(text)) return rule.path;
  return null;
}

/** Simulates a competent-but-not-omniscient AI: matches clusters (or, in the per-tab fallback prompt, individual tabs) against TOPIC_RULES; anything it doesn't recognize (e.g. social media) is returned at "low" confidence against its prior category, exactly like a real model would per the prompt's own instructions. */
function installSmartAiMock() {
  vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const prompt: string = body.prompt;
    const isClusterPrompt = /\bsize=\d+/.test(prompt);
    const lines = prompt.split("\n").filter((l) => l.startsWith("- id="));

    const data = lines.map((line) => {
      const idMatch = /id=(\S+)/.exec(line);
      const id = idMatch![1];
      const path = classifyText(line);
      if (path) {
        return { [isClusterPrompt ? "clusterId" : "tabId"]: id, path, confidence: "high", reason: "Matches a known topic." };
      }
      const priorMatch = /prior_categories=([^ ]+(?: [^ (]+)*)/.exec(line) ?? /existing_category=(\S+)/.exec(line);
      const priorName = priorMatch ? priorMatch[1].replace(/\(\d+\)$/, "").trim() : "Other";
      return { [isClusterPrompt ? "clusterId" : "tabId"]: id, path: [priorName], confidence: "low", reason: "" };
    });

    return jsonResponse({ data });
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organizeTabsCollectively", () => {
  it("places tabs directly under a full path when the AI reuses it and it already exists", async () => {
    const existingRoot: Section = { id: "root-school", parentId: null, name: "School", source: "user", createdAt: 0, updatedAt: 0 };
    installSmartAiMock();

    const result = await organizeTabsCollectively(
      "w1",
      "General",
      [
        makeTab({ id: "1", category: "school", title: "Schwarzschild radius derivation" }),
        makeTab({ id: "2", category: "school", title: "Black holes explained" }),
      ],
      [existingRoot]
    );

    const physics = result.sections.find((s) => s.name === "Physics");
    expect(physics?.parentId).toBe(existingRoot.id);
    expect(result.tabs.every((t) => t.sectionId === physics?.id)).toBe(true);
    expect(result.tabs.every((t) => t.organizationStatus === "classified")).toBe(true);
  });

  it("passes sectionLocked tabs through untouched", async () => {
    installSmartAiMock();
    const locked = makeTab({ id: "1", sectionLocked: true, sectionId: "manual-section" });

    const result = await organizeTabsCollectively("w1", "General", [locked], []);

    expect(result.tabs[0]).toEqual(locked);
    expect(result.sections).toEqual([]);
  });

  it("never leaves a tab without a sectionId even when the AI call fails outright", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("network down"));

    const tabs = [
      makeTab({ id: "1", category: "other", title: "Some obscure one-off page" }),
      makeTab({ id: "2", category: "other", title: "Totally unrelated other page" }),
    ];
    const result = await organizeTabsCollectively("w1", "General", tabs, []);

    expect(result.tabs.every((t) => Boolean(t.sectionId))).toBe(true);
    expect(result.report.unclassifiedCount).toBe(0);
    // Never a real, persisted "Other" root — see src/lib/sections/relations.ts's isReservedRootOtherName.
    expect(result.sections.some((s) => s.parentId === null && s.name.toLowerCase() === "other")).toBe(false);
  });

  it("merges a near-duplicate proposed name into an already-existing similar section instead of creating a sibling", async () => {
    const existing: Section = { id: "existing-physics", parentId: null, name: "Physics", source: "user", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
      const body = JSON.parse(String((init as RequestInit).body));
      const id = /id=(\S+)/.exec(body.prompt)![1];
      return jsonResponse({ data: [{ clusterId: id, path: ["Physics Research"], confidence: "high", reason: "" }] });
    });

    const result = await organizeTabsCollectively(
      "w1",
      "General",
      [makeTab({ id: "1", category: "school", title: "Some physics paper" }), makeTab({ id: "2", category: "school", title: "Some physics paper" })],
      [existing]
    );

    expect(result.sections.filter((s) => s.parentId === null)).toHaveLength(1);
    expect(result.tabs.every((t) => t.sectionId === existing.id)).toBe(true);
  });

  it("resolves a large, realistically-shuffled dump (the reported 580-tab failure case) to near-zero unclassified tabs across meaningful categories", async () => {
    installSmartAiMock();
    const tabs = buildSyntheticDump(580);

    const result = await organizeTabsCollectively("w1", "General", tabs, []);

    const unclassifiedShare = result.report.unclassifiedCount / result.report.totalTabs;
    expect(unclassifiedShare).toBeLessThan(0.05);

    const tree = buildSectionTree(result.sections, result.tabs);
    const otherNode = tree.find((n) => n.section.id === "other");
    // The old chunk-of-40 pipeline left the large majority of a dump this
    // size in the synthetic "Other" bucket (444/580 in the reported case) —
    // this is the acceptance bar for the redesign.
    expect((otherNode?.totalTabCount ?? 0) / tabs.length).toBeLessThan(0.05);

    const categoryNames = tree.filter((n) => n.section.id !== "other").map((n) => n.section.name);
    expect(categoryNames).toEqual(expect.arrayContaining(["School", "Technology", "Creative", "Finance"]));

    // No category explosion: near-duplicate concepts should have collapsed
    // into one root rather than several (spec's "Physics"/"Physics Research" example).
    const schoolRoots = categoryNames.filter((n) => /^school/i.test(n));
    expect(schoolRoots.length).toBe(1);
  }, 20000);
});

/** Realistic browser-tab titles for a domain — deliberately generic/varied, the way real tabs look, not hand-crafted to all contain the brand word. */
function domainTabs(prefix: string, domain: string, titles: string[], hostVariants: string[] = [domain]): Tab[] {
  return titles.map((title, i) => makeTab({ id: `${prefix}${i}`, domain: hostVariants[i % hostVariants.length], title }));
}

const INSTAGRAM_TITLES = [
  "Instagram", "Login • Instagram", "(3) Instagram", "Explore • Instagram",
  "jane_doe • Instagram photos and videos", "Reels • Instagram", "Instagram creator dashboard",
  "Instagram help center", "Instagram insights", "Direct • Instagram", "Instagram post",
  "Instagram profile", "Story • Instagram", "Settings • Instagram", "Instagram",
];
const INSTAGRAM_HOSTS = ["www.instagram.com", "instagram.com", "m.instagram.com"];

const YOUTUBE_TITLES = [
  "YouTube", "(12) YouTube", "Some Cool Video - YouTube", "YouTube Studio",
  "Trending - YouTube", "Home - YouTube", "Watch Later - YouTube", "YouTube Music",
  "Subscriptions - YouTube", "YouTube Shorts", "Another video - YouTube", "YouTube Premium",
  "Library - YouTube", "Live - YouTube", "YouTube Kids",
];
const YOUTUBE_HOSTS = ["www.youtube.com", "youtube.com", "m.youtube.com"];

const GITHUB_TITLES = [
  "GitHub", "biterate-7/tabdump", "Issues · biterate-7/tabdump", "Pull requests · biterate-7/tabdump",
  "Commits · main · biterate-7/tabdump", "Actions · biterate-7/tabdump", "GitHub - vercel/next.js",
  "Settings · biterate-7/tabdump", "README.md at main", "GitHub Copilot",
];

/** Never a real, persisted "Other" root — src/lib/sections/relations.ts's isReservedRootOtherName — plus the synthetic Other bucket every workspace has for tabs with no sectionId. Both should be empty. */
function assertNoOther(result: Awaited<ReturnType<typeof organizeTabsCollectively>>) {
  expect(result.tabs.every((t) => Boolean(t.sectionId))).toBe(true);
  expect(result.sections.some((s) => s.parentId === null && s.name.trim().toLowerCase() === "other")).toBe(false);
}

describe("organizeTabsCollectively — real-world domain clustering", () => {
  it("15 Instagram tabs (varied titles/host variants) become one Instagram section, 0 in Other", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = domainTabs("ig", "instagram.com", INSTAGRAM_TITLES, INSTAGRAM_HOSTS);

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const instagram = result.sections.find((s) => s.name === "Instagram");
    expect(instagram).toBeDefined();
    expect(result.tabs.every((t) => t.sectionId === instagram?.id)).toBe(true);
  });

  it("15 YouTube tabs become one YouTube section, 0 in Other", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = domainTabs("yt", "youtube.com", YOUTUBE_TITLES, YOUTUBE_HOSTS);

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const youtube = result.sections.find((s) => s.name === "YouTube");
    expect(youtube).toBeDefined();
    expect(result.tabs.every((t) => t.sectionId === youtube?.id)).toBe(true);
  });

  it("10 GitHub tabs become a GitHub section, 0 in Other", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = domainTabs("gh", "github.com", GITHUB_TITLES);

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const github = result.sections.find((s) => s.name === "GitHub");
    expect(github).toBeDefined();
    expect(result.tabs.filter((t) => t.sectionId === github?.id)).toHaveLength(10);
  });

  it("a mix of Instagram tabs and clearly unrelated tabs still separates cleanly, 0 in Other", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = [
      ...domainTabs("ig", "instagram.com", INSTAGRAM_TITLES, INSTAGRAM_HOSTS),
      makeTab({ id: "phys1", category: "school", title: "Schwarzschild radius derivation", domain: "arxiv.org" }),
      makeTab({ id: "phys2", category: "school", title: "Black holes and general relativity", domain: "en.wikipedia.org" }),
      makeTab({ id: "shop1", category: "shopping", title: "Amazon.com: wireless mouse", domain: "www.amazon.com" }),
    ];

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const sectionsById = new Map(result.sections.map((s) => [s.id, s]));
    const igSectionNames = new Set(
      result.tabs.filter((t) => t.id.startsWith("ig")).map((t) => sectionsById.get(t.sectionId!)?.name)
    );
    expect(igSectionNames).toEqual(new Set(["Instagram"]));
  });

  it("2 Instagram tabs still form a real, brand-named cluster (LEVEL 3 evidence)", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = [
      makeTab({ id: "ig0", domain: "www.instagram.com", title: "Instagram" }),
      makeTab({ id: "ig1", domain: "m.instagram.com", title: "jane_doe • Instagram photos and videos" }),
    ];
    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);
    expect(result.tabs[0].sectionId).toBe(result.tabs[1].sectionId);
  });

  it("a single Instagram tab (genuine singleton) still gets a real section, never Other", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = [makeTab({ id: "ig0", domain: "www.instagram.com", title: "Instagram" })];
    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);
  });

  it("distinguishes Google products (Docs/Drive/Calendar/Gmail) into separate sections rather than one 'Google' bucket", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = [
      makeTab({ id: "d0", domain: "docs.google.com", title: "Physics IA - Google Docs" }),
      makeTab({ id: "d1", domain: "docs.google.com", title: "Lab report draft - Google Docs" }),
      makeTab({ id: "r0", domain: "drive.google.com", title: "My Drive - Google Drive" }),
      makeTab({ id: "r1", domain: "drive.google.com", title: "Shared with me - Google Drive" }),
      makeTab({ id: "c0", domain: "calendar.google.com", title: "Google Calendar" }),
      makeTab({ id: "c1", domain: "calendar.google.com", title: "Week of Sept 1 - Google Calendar" }),
      makeTab({ id: "m0", domain: "mail.google.com", title: "Inbox (3) - Gmail" }),
      makeTab({ id: "m1", domain: "mail.google.com", title: "Sent - Gmail" }),
    ];
    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const names = new Set(result.sections.map((s) => s.name));
    expect(names).toEqual(new Set(["Google Docs", "Google Drive", "Google Calendar", "Gmail"]));
  });

  it("singleton recovery: a leftover tab sharing a site with several other leftovers still becomes a real section (spec §8)", async () => {
    // Each Instagram tab shares nothing keyword-wise with the others (only
    // the domain), and there are exactly MIN_CONFIDENT_CLUSTER_SIZE-worthy
    // leftovers scattered among unrelated singletons — exercising Stage F.3's
    // regroup-by-domain pass rather than the main clustering stage.
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));
    const tabs = [
      makeTab({ id: "ig0", domain: "www.instagram.com", title: "xj4k9 photography" }),
      makeTab({ id: "ig1", domain: "m.instagram.com", title: "qp2v7 travel diary" }),
      makeTab({ id: "ig2", domain: "instagram.com", title: "zn8h1 cooking clips" }),
      makeTab({ id: "s1", domain: "randomsite1.dev", title: "completely unrelated singleton one" }),
      makeTab({ id: "s2", domain: "randomsite2.dev", title: "completely unrelated singleton two" }),
    ];
    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const sectionsById = new Map(result.sections.map((s) => [s.id, s]));
    const igSectionIds = new Set(["ig0", "ig1", "ig2"].map((id) => result.tabs.find((t) => t.id === id)?.sectionId));
    expect(igSectionIds.size).toBe(1);
    expect(sectionsById.get([...igSectionIds][0]!)?.name).toBe("Instagram");
  });

  it("the realistic 185-tab mixed dump (Instagram/YouTube/GitHub/Reddit/Google Docs/Physics/Economics/Shopping) resolves to 0 Other", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("no AI in this test"));

    const tabs: Tab[] = [
      ...domainTabs("ig", "instagram.com", [...INSTAGRAM_TITLES, "Instagram reels", "Instagram home"], INSTAGRAM_HOSTS), // 17
      ...domainTabs("yt", "youtube.com", YOUTUBE_TITLES, YOUTUBE_HOSTS), // 15
      ...domainTabs("gh", "github.com", GITHUB_TITLES), // 10
      ...domainTabs(
        "rd",
        "reddit.com",
        ["reddit", "r/programming", "r/AskReddit", "r/webdev - Reddit", "Hot posts - Reddit", "r/nextjs", "r/ProgrammerHumor", "Reddit"],
        ["www.reddit.com", "old.reddit.com"]
      ), // 8
      ...domainTabs("gd", "docs.google.com", [
        "Physics IA - Google Docs", "Lab report draft - Google Docs", "Untitled document - Google Docs",
        "Economics IA outline - Google Docs", "Notes - Google Docs", "Personal statement - Google Docs",
        "Draft 2 - Google Docs", "Essay outline - Google Docs", "Meeting notes - Google Docs", "Untitled document - Google Docs",
      ]), // 10
      ...[
        "Schwarzschild radius derivation", "Black holes and general relativity", "S2 star orbit around Sagittarius A*",
        "Curved spacetime and geodesics", "Photoelectric effect and quantum theory", "Special relativity time dilation",
        "Newtonian mechanics problem set", "Kepler's laws of planetary orbits", "Gravitational wave detection - LIGO",
        "Physics IA - orbital simulation in Python",
      ].map((title, i) => makeTab({ id: `ph${i}`, category: "school", title, domain: i % 2 === 0 ? "en.wikipedia.org" : "arxiv.org" })), // 10
      ...[
        "IB Economics Paper 1 revision questions", "Why does inflation erode purchasing power",
        "Aggregate demand and market equilibrium", "Price elasticity of demand calculations",
        "How fiscal and monetary policy differ", "How GDP is calculated across countries",
        "Comparative advantage and international trade", "Fixed and floating exchange regimes compared",
        "Structural and cyclical unemployment", "Economic growth models explained",
      ].map((title, i) => makeTab({ id: `ec${i}`, category: "school", title, domain: "investopedia.com" })), // 10
      ...[
        "Amazon.com: wireless mouse", "Amazon.in: usb c cable", "Amazon.com: desk lamp",
        "Amazon.in: laptop stand", "Amazon.com: phone case", "eBay auction - vintage camera",
        "Etsy shop - handmade mat", "Amazon.com: keyboard", "Amazon.in: monitor arm", "Amazon.com: webcam",
      ].map((title, i) => makeTab({ id: `sh${i}`, category: "shopping", title, domain: i < 8 ? (i % 2 === 0 ? "www.amazon.com" : "www.amazon.in") : (i === 8 ? "www.ebay.com" : "www.etsy.com") })), // 10
      // A realistic "long tail": a handful more recognizable brands (each
      // small enough on its own to exercise LEVEL 2/3 evidence rather than
      // LEVEL 1) plus a spread of one-off singleton pages that share nothing
      // with anything else — the exact mix a real 185-tab browsing session
      // looks like, and what makes the old pipeline's "Other" bucket balloon.
      ...domainTabs("sp", "open.spotify.com", ["Spotify – Web Player", "Discover Weekly - Spotify", "Liked Songs - Spotify"]),
      ...domainTabs("li", "www.linkedin.com", ["LinkedIn", "Jobs - LinkedIn", "My Network - LinkedIn"]),
      ...domainTabs("cv", "www.canva.com", ["Canva", "Untitled design - Canva"]),
      ...domainTabs("nt", "www.notion.so", ["Notion", "TabDump roadmap - Notion"]),
      ...domainTabs("gpt", "chatgpt.com", ["ChatGPT", "New chat - ChatGPT", "ChatGPT - ideas for essay"], ["chatgpt.com", "chat.openai.com"]),
      ...domainTabs("nf", "www.netflix.com", ["Netflix", "Continue Watching - Netflix"]),
      ...domainTabs("tw", "www.twitch.tv", ["Twitch", "Live channel - Twitch"]),
      ...domainTabs("tt", "www.tiktok.com", ["TikTok", "For You - TikTok"]),
      ...Array.from({ length: 76 }, (_, i) =>
        makeTab({
          id: `tail${i}`,
          domain: `longtail-${i}.example-${i}.net`,
          title: `A one-off page about ${["budget", "recipe", "hiking", "airline", "mortgage", "puzzle", "camera", "garden", "concert", "dentist"][i % 10]} number ${i}`,
        })
      ),
    ];

    expect(tabs.length).toBeGreaterThanOrEqual(180);

    const result = await organizeTabsCollectively("w1", "General", tabs, []);
    assertNoOther(result);

    const tree = buildSectionTree(result.sections, result.tabs);
    const rootNames = tree.filter((n) => n.section.id !== "other").map((n) => n.section.name);
    expect(rootNames).toEqual(expect.arrayContaining(["Instagram", "YouTube", "GitHub", "Reddit", "Google Docs"]));
    expect(result.report.unclassifiedCount).toBe(0);
  }, 20000);
});

/**
 * The reported grouping bug and its general form: a model that has decided a
 * group is a good home for anything vaguely adjacent to it. These drive the
 * pipeline end to end with a mock that behaves exactly that way — it names
 * the real cluster correctly, then tries to sweep every leftover into it —
 * and assert the membership gate (src/lib/sections/ai/membership.ts) refuses.
 */
function makeSiteTab(over: Partial<Tab> & { id: string; domain: string; title: string }): Tab {
  const url = over.url ?? `https://${over.domain}/${over.id}`;
  return { url, normalizedUrl: url, category: "other", ...over };
}

/**
 * A model that files EVERY tab it is shown into `targetPath` at the given
 * confidence — the distilled version of "ManageBac is for school, this tab is
 * school-ish, therefore ManageBac". Confidence is a parameter because the
 * reported failure happened at "low" too: reusing an existing path used to
 * bypass every gate regardless of how unsure the model said it was.
 */
function installGroupStuffingAi(targetPath: string[], confidence: "high" | "medium" | "low") {
  vi.spyOn(global, "fetch").mockImplementation(async (_url, init) => {
    const body = JSON.parse(String((init as RequestInit).body));
    const prompt: string = body.prompt;
    const isClusterPrompt = /\bsize=\d+/.test(prompt);
    const key = isClusterPrompt ? "clusterId" : "tabId";
    const data = prompt
      .split("\n")
      .filter((l) => l.startsWith("- id="))
      .map((line) => ({
        [key]: /id=(\S+)/.exec(line)![1],
        path: targetPath,
        confidence,
        reason: "Feels related to the rest.",
      }));
    return jsonResponse({ data });
  });
}

/** Names of the sections each tab id ended up in, for readable assertions. */
function sectionNamesById(result: Awaited<ReturnType<typeof organizeTabsCollectively>>): Map<string, string | undefined> {
  const byId = new Map(result.sections.map((s) => [s.id, s.name]));
  return new Map(result.tabs.map((t) => [t.id, t.sectionId ? byId.get(t.sectionId) : undefined]));
}

describe("organizeTabsCollectively — group membership is judged per tab", () => {
  const MANAGEBAC_TABS = [
    makeSiteTab({ id: "mb1", domain: "managebac.com", title: "ManageBac - Dashboard" }),
    makeSiteTab({ id: "mb2", domain: "managebac.com", title: "Assignments due this week" }),
    makeSiteTab({ id: "mb3", domain: "managebac.com", title: "IB Diploma - Class of 2026" }),
    makeSiteTab({ id: "mb4", domain: "managebac.com", title: "Term grades overview" }),
  ];
  /** Every "should NOT be included" case from the report: adjacent in theme, unrelated in fact. */
  const INTRUDERS = [
    makeSiteTab({ id: "gen", domain: "genius.com", title: "Kendrick Lamar - Money Trees Lyrics | Genius" }),
    makeSiteTab({ id: "ais", domain: "aistudio.google.com", title: "Google AI Studio" }),
    makeSiteTab({ id: "gs", domain: "www.google.com", title: "ib diploma deadlines - Google Search" }),
    makeSiteTab({ id: "kh", domain: "khanacademy.org", title: "Intro to kinematics | Khan Academy" }),
    makeSiteTab({ id: "gpt", domain: "chatgpt.com", title: "ChatGPT - help with my essay" }),
  ];

  it.each([["low"], ["medium"], ["high"]] as const)(
    "keeps unrelated tabs out of a ManageBac group even when the model insists at %s confidence",
    async (confidence) => {
      installGroupStuffingAi(["ManageBac"], confidence);

      const result = await organizeTabsCollectively("w1", "General", [...MANAGEBAC_TABS, ...INTRUDERS], []);
      const placement = sectionNamesById(result);

      // Casing varies by which namer won (the model's "ManageBac" vs the
      // deterministic domain namer's "Managebac"); the grouping is the point.
      const managebacSection = placement.get("mb1");
      expect(managebacSection?.toLowerCase()).toBe("managebac");
      for (const tab of MANAGEBAC_TABS) expect(placement.get(tab.id)).toBe(managebacSection);
      for (const tab of INTRUDERS) expect(placement.get(tab.id)).not.toBe(managebacSection);
      // Rejected, not lost: the pipeline's own fallback still finds each one a home.
      assertNoOther(result);
    }
  );

  it("keeps unrelated tabs out of an Instagram group", async () => {
    installGroupStuffingAi(["Instagram"], "high");
    const instagram = domainTabs("ig", "instagram.com", INSTAGRAM_TITLES.slice(0, 6), INSTAGRAM_HOSTS);
    const others = [
      makeSiteTab({ id: "nf", domain: "www.netflix.com", title: "Continue Watching - Netflix" }),
      makeSiteTab({ id: "az", domain: "www.amazon.com", title: "Amazon.com: desk lamp" }),
      makeSiteTab({ id: "ar", domain: "arxiv.org", title: "Schwarzschild radius derivation" }),
    ];

    const result = await organizeTabsCollectively("w1", "General", [...instagram, ...others], []);
    const placement = sectionNamesById(result);

    for (const tab of instagram) expect(placement.get(tab.id)).toBe("Instagram");
    for (const tab of others) expect(placement.get(tab.id)).not.toBe("Instagram");
    assertNoOther(result);
  });

  it("keeps unrelated tabs out of a named project group (GitHub/TabDump)", async () => {
    installGroupStuffingAi(["Projects", "TabDump"], "high");
    const project = [
      makeSiteTab({ id: "gh1", domain: "github.com", title: "biterate-7/tabdump" }),
      makeSiteTab({ id: "gh2", domain: "github.com", title: "Issues - biterate-7/tabdump" }),
      makeSiteTab({ id: "gh3", domain: "github.com", title: "Pull requests - biterate-7/tabdump" }),
    ];
    const others = [
      makeSiteTab({ id: "sp", domain: "open.spotify.com", title: "Discover Weekly - Spotify" }),
      makeSiteTab({ id: "tw", domain: "www.twitch.tv", title: "Live channel - Twitch" }),
    ];

    const result = await organizeTabsCollectively("w1", "General", [...project, ...others], []);
    const placement = sectionNamesById(result);

    for (const tab of project) expect(placement.get(tab.id)).toBe("TabDump");
    for (const tab of others) expect(placement.get(tab.id)).not.toBe("TabDump");
    assertNoOther(result);
  });

  it("still lets a genuine cross-domain topic group hold together — the check rejects strangers, not members", async () => {
    installGroupStuffingAi(["School", "Physics"], "high");
    const physics = [
      makeSiteTab({ id: "ph1", category: "school", domain: "en.wikipedia.org", title: "Schwarzschild metric - physics of black holes" }),
      makeSiteTab({ id: "ph2", category: "school", domain: "arxiv.org", title: "Schwarzschild geometry near black holes" }),
      makeSiteTab({ id: "ph3", category: "school", domain: "cern.ch", title: "Black holes and general relativity - physics notes" }),
      makeSiteTab({ id: "ph4", category: "school", domain: "khanacademy.org", title: "General relativity and curved spacetime" }),
    ];

    const result = await organizeTabsCollectively("w1", "General", physics, []);
    const placement = sectionNamesById(result);

    for (const tab of physics) expect(placement.get(tab.id)).toBe("Physics");
  });

  it("does not let two unrelated tabs legitimise each other inside a group", async () => {
    // Both genius.com tabs look like each other, so any rule that accepted a
    // tab for resembling SOME member of the group would keep them both.
    installGroupStuffingAi(["ManageBac"], "high");
    const lyrics = [
      makeSiteTab({ id: "gen1", domain: "genius.com", title: "Kendrick Lamar - Money Trees Lyrics | Genius" }),
      makeSiteTab({ id: "gen2", domain: "genius.com", title: "SZA - Money Trees verse | Genius lyrics" }),
    ];

    const result = await organizeTabsCollectively("w1", "General", [...MANAGEBAC_TABS, ...lyrics], []);
    const placement = sectionNamesById(result);

    const managebacSection = placement.get("mb1");
    expect(managebacSection?.toLowerCase()).toBe("managebac");
    for (const tab of MANAGEBAC_TABS) expect(placement.get(tab.id)).toBe(managebacSection);
    for (const tab of lyrics) expect(placement.get(tab.id)).not.toBe(managebacSection);
  });
});

/**
 * The incremental-dump case: the ManageBac group was built by an EARLIER
 * session, and this dump contains none of its tabs — only unrelated ones the
 * model wants to file there. Nothing in the current batch can vouch for the
 * group, which is precisely when a gate that trusts the model would let
 * everything through.
 */
describe("organizeTabsCollectively — a dump of only unrelated tabs cannot join an existing group", () => {
  const MANAGEBAC_SECTION: Section = { id: "sec-managebac", parentId: null, name: "ManageBac", source: "ai", createdAt: 0, updatedAt: 0 };
  /** Already filed by a previous run — passed as read-only context, never re-organized. */
  const ALREADY_FILED = [
    makeSiteTab({ id: "old1", domain: "managebac.com", title: "ManageBac - Dashboard", sectionId: MANAGEBAC_SECTION.id, organizationStatus: "classified" }),
    makeSiteTab({ id: "old2", domain: "managebac.com", title: "Assignments due this week", sectionId: MANAGEBAC_SECTION.id, organizationStatus: "classified" }),
    makeSiteTab({ id: "old3", domain: "managebac.com", title: "IB Diploma - Class of 2026", sectionId: MANAGEBAC_SECTION.id, organizationStatus: "classified" }),
  ];
  const NEW_DUMP = [
    makeSiteTab({ id: "gen", domain: "genius.com", title: "Kendrick Lamar - Money Trees Lyrics | Genius" }),
    makeSiteTab({ id: "ais", domain: "aistudio.google.com", title: "Google AI Studio" }),
    makeSiteTab({ id: "kh", domain: "khanacademy.org", title: "Intro to kinematics | Khan Academy" }),
  ];

  it.each([["low"], ["medium"], ["high"]] as const)(
    "rejects them at %s confidence, leaves the existing group untouched, and re-homes them safely",
    async (confidence) => {
      installGroupStuffingAi(["ManageBac"], confidence);

      const result = await organizeTabsCollectively(
        "w1",
        "General",
        NEW_DUMP,
        [MANAGEBAC_SECTION],
        undefined,
        [...ALREADY_FILED, ...NEW_DUMP]
      );
      const placement = sectionNamesById(result);

      // 4. None of the new tabs got into ManageBac.
      for (const tab of NEW_DUMP) expect(placement.get(tab.id)).not.toBe("ManageBac");
      // 6. They are not stranded either — each has a real, safe home.
      assertNoOther(result);

      // 5. The existing group is exactly as it was: same section, and none of
      //    its tabs came back changed (they were context, not input).
      expect(result.sections.find((s) => s.id === MANAGEBAC_SECTION.id)).toEqual(MANAGEBAC_SECTION);
      expect(result.tabs.map((t) => t.id).sort()).toEqual(["ais", "gen", "kh"]);
      for (const filed of ALREADY_FILED) expect(result.tabs.some((t) => t.id === filed.id)).toBe(false);
    }
  );

  it("accepts a genuine ManageBac tab arriving in that same incremental dump", async () => {
    installGroupStuffingAi(["ManageBac"], "high");
    const genuine = makeSiteTab({ id: "new-mb", domain: "managebac.com", title: "ManageBac - Term grades" });

    const result = await organizeTabsCollectively(
      "w1",
      "General",
      [...NEW_DUMP, genuine],
      [MANAGEBAC_SECTION],
      undefined,
      [...ALREADY_FILED, ...NEW_DUMP, genuine]
    );
    const placement = sectionNamesById(result);

    expect(placement.get("new-mb")).toBe("ManageBac");
    for (const tab of NEW_DUMP) expect(placement.get(tab.id)).not.toBe("ManageBac");
  });

  it("rejects them even with no context at all — an unreadable group is not an open one", async () => {
    installGroupStuffingAi(["ManageBac"], "high");

    const result = await organizeTabsCollectively("w1", "General", NEW_DUMP, [MANAGEBAC_SECTION]);
    const placement = sectionNamesById(result);

    for (const tab of NEW_DUMP) expect(placement.get(tab.id)).not.toBe("ManageBac");
    assertNoOther(result);
  });
});
