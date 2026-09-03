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
