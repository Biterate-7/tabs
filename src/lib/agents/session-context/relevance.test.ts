import { describe, expect, it } from "vitest";
import { largeSnapshot, snapshotOf, studentSnapshot, tab, STUDENT_TABS } from "./__fixtures__/reasoning";
import { validateWorkspacePlan } from "./plan";
import { findRelatedTabs, rankCollections, recommendPlacement } from "./relevance";
import { analyzeTopics } from "./topics";
import type { Placement } from "./relevance";
import type { SessionContextSnapshot } from "./snapshot";

/**
 * Natural-language reads and collection reasoning (Phase J.6.2, J.6.4): what
 * matches a topic and why, which collections already cover it, and — as data
 * only — where unorganized tabs could go.
 */

const ids = (result: { matches: readonly { tabId: string }[] }) => result.matches.map((match) => match.tabId);

/** A suggestion must be something J.5 would accept as-is: same validator, same version. */
function expectValidSuggestion(snapshot: SessionContextSnapshot, placement: Placement) {
  if (!("operation" in placement)) return;
  const checked = validateWorkspacePlan(
    snapshot,
    { basedOnVersion: 1, operations: [placement.operation] },
    { workspaceId: snapshot.workspace.id, version: 1 }
  );
  expect(checked, JSON.stringify(placement)).toMatchObject({ ok: true });
}

describe("findRelatedTabs", () => {
  it("finds a topic directly, then by the matches' shared words — each with why", () => {
    const found = findRelatedTabs(studentSnapshot(), { query: "college applications" });
    expect(found.understoodAs).toEqual(["College", "Application"]);
    expect(ids(found)).toEqual(["c3", "c6", "c1", "c4", "c5", "d1", "c2"]);
    expect(found.totals).toEqual({ direct: 6, related: 1 });
    expect(found.matches[0]).toMatchObject({ strength: "direct", matchedOn: ["title"], why: "Title mentions “Application”" });
    // Stanford never says "college" or "application", but shares "admission" with the matches.
    expect(found.matches.at(-1)).toMatchObject({ tabId: "c2", strength: "related", confidence: "low", why: "Shares “Admission” with the matching tabs" });
    expect(found.vocabulary).toEqual(["Requirements", "Admission"]);
  });

  it("widens a few matches through their own words: every physics tab, though only two say “physics”", () => {
    const found = findRelatedTabs(studentSnapshot(), { query: "physics" });
    expect(ids(found)).toEqual(["p2", "p3", "p4", "p1", "p5"]);
    expect(found.totals).toEqual({ direct: 2, related: 3 });
    expect(found.matches[2]).toMatchObject({ tabId: "p4", confidence: "medium", why: "Shares “Black”, “General”, “Hole” with the matching tabs" });
    // One word, but shared with half the matches: said with the word it rests on.
    expect(found.matches.find((match) => match.tabId === "p1")).toMatchObject({ confidence: "medium", why: "Shares “Schwarzschild” with the matching tabs" });
  });

  it("follows a relationship the user drew from a match, even with no word in common", () => {
    const snapshot = snapshotOf({
      tabs: [
        tab("a", "Thesis draft on orbital resonance", "https://docs.example.com/thesis"),
        tab("b", "Grocery list", "https://notes.example.org/groceries"),
        tab("c", "Weather", "https://weather.example.net"),
      ],
      dependencies: [{ id: "d1", parentTabId: "a", childTabId: "b" }],
    });
    const found = findRelatedTabs(snapshot, { query: "thesis" });
    expect(ids(found)).toEqual(["a", "b"]);
    expect(found.matches[1]).toMatchObject({ strength: "related", confidence: "medium", why: "Linked by a relationship to “Thesis draft on orbital resonance”" });
  });

  it("finds tabs related to given tabs, without listing the given tabs", () => {
    const found = findRelatedTabs(studentSnapshot(), { tabIds: ["p2", "not-a-tab", "ws-private-tab"] });
    expect(ids(found)).toEqual(["p4", "p3", "p5"]);
    expect(found.matches[0]).toMatchObject({ confidence: "medium", why: "Shares “General”, “Relativity” with the given tabs" });
    expect(found.unknownTabIds).toBe(2);
    expect(JSON.stringify(found)).not.toMatch(/not-a-tab|ws-private-tab/);
  });

  it("answers nothing for a query of stopwords, an unknown topic, or a secret query value", () => {
    const snapshot = studentSnapshot();
    expect(findRelatedTabs(snapshot, { query: "the and of for" })).toMatchObject({ understoodAs: [], matches: [], totals: { direct: 0, related: 0 } });
    expect(findRelatedTabs(snapshot, { query: "volcanoes" }).matches).toEqual([]);
    for (const probe of ["SECRET123", "access_token", "token"]) expect(findRelatedTabs(snapshot, { query: probe }).matches).toEqual([]);
  });

  it("searches only unorganized tabs when asked", () => {
    const found = findRelatedTabs(studentSnapshot(), { query: "physics", uncategorizedOnly: true });
    expect(ids(found)).not.toContain("p2");
    expect(ids(found)).toContain("p3");
  });

  it("is bounded in a large workspace and says when it cut the list", () => {
    const found = findRelatedTabs(largeSnapshot(800, 30), { query: "astronomy", limit: 500 });
    expect(found.matches.length).toBe(50);
    expect(found.truncated).toBe(true);
    expect(found.totals.direct).toBe(80);
  });

  it("finds sites by name", () => {
    const found = findRelatedTabs(
      snapshotOf({ tabs: [tab("a", "Lo-fi beats", "https://www.youtube.com/watch?v=1"), tab("b", "Tax forms", "https://irs.example.gov")] }),
      { query: "youtube" }
    );
    expect(found.matches).toMatchObject([{ tabId: "a", matchedOn: ["site"], why: "Site mentions “Youtube”" }]);
  });
});

describe("rankCollections", () => {
  it("ranks an existing collection by its name, with the evidence", () => {
    expect(rankCollections(studentSnapshot(), { query: "physics" }).collections).toEqual([
      { collectionId: "col-physics", name: "Physics", tabCount: 2, score: 3.5, covers: true, alreadyHolds: 0, evidence: ["Its name matches “Physics”"] },
    ]);
  });

  it("lists nothing when no collection is relevant", () => {
    expect(rankCollections(studentSnapshot(), { query: "cookies" }).collections).toEqual([]);
    expect(rankCollections(snapshotOf({ tabs: [tab("a", "x", "https://a.example.com")] }), { query: "anything" }).collections).toEqual([]);
  });

  it("finds a collection by what its tabs are about, and by what it already holds", () => {
    const snapshot = studentSnapshot();
    const byContent = rankCollections(snapshot, { tabIds: ["p4", "p5"] }).collections[0];
    expect(byContent).toMatchObject({ name: "Physics", alreadyHolds: 0, evidence: ["Its tabs also mention “Relativity”"] });
    const holding = rankCollections(snapshot, { tabIds: ["p1", "p5"] }).collections[0];
    expect(holding).toMatchObject({ name: "Physics", alreadyHolds: 1 });
    expect(holding.evidence).toContain("1 of the 2 tabs is already in it");
  });

  it("scores many collections in a large workspace, bounded", () => {
    const ranked = rankCollections(largeSnapshot(800, 30), { query: "chemistry" });
    expect(ranked.collections.length).toBeLessThanOrEqual(10);
    expect(ranked.collections[0].name).toMatch(/^chemistry/);
  });
});

describe("recommendPlacement (data, never an action)", () => {
  it("prefers the collection that already covers a topic, and places only unorganized tabs", () => {
    const snapshot = studentSnapshot();
    const relativity = analyzeTopics(snapshot).groups.find((group) => group.label === "General Relativity")!;
    const placement = recommendPlacement(snapshot, { tabIds: relativity.tabIds, name: relativity.label, terms: relativity.terms, confidence: relativity.confidence });
    expect(placement).toMatchObject({
      action: "add_to_existing",
      collection: { collectionId: "col-physics", name: "Physics" },
      operation: { kind: "add_tabs_to_collection", collectionId: "col-physics", tabIds: ["p4", "p5"] },
    });
    // p2 is already in Physics: nothing about it being "left elsewhere".
    expect(placement.reason).not.toMatch(/left there/);
    expectValidSuggestion(snapshot, placement);
  });

  it("suggests a new collection only when nothing covers the topic", () => {
    const snapshot = studentSnapshot();
    const admission = analyzeTopics(snapshot).groups[0];
    const placement = recommendPlacement(snapshot, { tabIds: admission.tabIds, name: admission.label, terms: admission.terms, confidence: admission.confidence });
    expect(placement).toMatchObject({ action: "create", operation: { kind: "create_collection", name: "Admission Application", tabIds: ["c2", "c3", "c4", "c6"] } });
    expectValidSuggestion(snapshot, placement);
  });

  it("suggests nothing for a low-confidence group", () => {
    const snapshot = studentSnapshot();
    const college = analyzeTopics(snapshot).groups.find((group) => group.label === "College")!;
    expect(college.confidence).toBe("low");
    expect(recommendPlacement(snapshot, { tabIds: college.tabIds, name: college.label, confidence: "low" })).toEqual({
      action: "ask_user",
      reason: "This grouping is low-confidence, so no change is suggested. Ask the user whether these belong together.",
    });
  });

  it("never moves a tab the user filed, and says so", () => {
    const snapshot = studentSnapshot({ collections: [{ id: "col-physics", name: "Physics", tabIds: ["p1", "p2"] }, { id: "col-apps", name: "Apps", tabIds: ["c1"] }] });
    expect(recommendPlacement(snapshot, { tabIds: ["p1", "p2"], name: "Physics", confidence: "high" })).toEqual({
      action: "none",
      reason: "Already organized: all of them are in “Physics”.",
    });
    const mixed = recommendPlacement(snapshot, { tabIds: ["c1", "c4", "c5"], name: "College Research", confidence: "medium" });
    expect(mixed).toMatchObject({ action: "create", operation: { kind: "create_collection", name: "College Research", tabIds: ["c4", "c5"] } });
    expect(mixed.reason).toMatch(/1 tab is already in “Apps” and is left there\./);
    expectValidSuggestion(snapshot, mixed);
  });

  it("reuses a collection with the same name instead of colliding with it", () => {
    const snapshot = studentSnapshot();
    const placement = recommendPlacement(snapshot, { tabIds: ["r1", "r2"], name: "physics", confidence: "high" });
    expect(placement).toMatchObject({ action: "add_to_existing", collection: { name: "Physics" } });
    expectValidSuggestion(snapshot, placement);
  });

  it("asks rather than suggesting a one-tab collection, and ignores tabs that are not this workspace's", () => {
    const snapshot = studentSnapshot();
    expect(recommendPlacement(snapshot, { tabIds: ["r1"], name: "Baking", confidence: "high" }).action).toBe("ask_user");
    expect(recommendPlacement(snapshot, { tabIds: ["nope"], name: "X", confidence: "high" })).toEqual({ action: "none", reason: "None of those are tabs of this workspace." });
    const trimmed = recommendPlacement(snapshot, { tabIds: ["r1", "r2", "nope"], name: "Kitchen and planning", confidence: "high" });
    expect(trimmed).toMatchObject({ operation: { tabIds: ["r1", "r2"] } });
  });

  it("produces only suggestions J.5 accepts, for every group of a large workspace", () => {
    const snapshot = largeSnapshot(800, 30);
    const analysis = analyzeTopics(snapshot);
    let suggested = 0;
    for (const group of analysis.groups) {
      const placement = recommendPlacement(snapshot, { tabIds: group.tabIds, name: group.label, terms: group.terms, confidence: group.confidence });
      if (group.confidence === "low") expect(placement.action).toBe("ask_user");
      if ("operation" in placement) suggested += 1;
      expectValidSuggestion(snapshot, placement);
    }
    expect(suggested).toBeGreaterThan(0);
  });

  it("covers the student workspace's tabs without inventing any", () => {
    const snapshot = studentSnapshot();
    const known = new Set(STUDENT_TABS.map((entry) => entry.id));
    for (const group of analyzeTopics(snapshot).groups) {
      const placement = recommendPlacement(snapshot, { tabIds: group.tabIds, name: group.label, confidence: group.confidence });
      if ("operation" in placement) for (const tabId of placement.operation.tabIds) expect(known.has(tabId)).toBe(true);
    }
  });
});
