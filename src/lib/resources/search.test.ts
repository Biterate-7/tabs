import { describe, expect, it } from "vitest";
import { describeLocation, markMatches, searchProject, transcriptMoments } from "./search";
import type { ProjectSearchHit } from "./search";
import type { ResourceContent, TabResource, TranscriptSegment } from "./types";

const ready: TabResource = { kind: "youtube", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1, content: { chars: 1, extractedAt: 1 } };

function video(id: string, title: string) {
  return { id, title, url: `https://www.youtube.com/watch?v=${id.padEnd(11, "x")}`, domain: "youtube.com", resource: ready };
}

/** One line every 4 seconds from `from`, so times are easy to read in assertions. */
function lines(texts: string[], from = 0): TranscriptSegment[] {
  return texts.map((text, index) => ({ start: from + index * 4, end: from + index * 4 + 4, text }));
}

const PHYSICS = lines(
  [
    "Welcome back to physics revision.",
    "Today: energy stores.",
    "Let's start with kinetic energy.",
    ...Array.from({ length: 120 }, (_, i) => `Filler sentence number ${i} about nothing much.`),
    "Now, Gravitational Potential",
    "energy is the energy an object has because of its height.",
    "We write it as E equals m g h.",
    ...Array.from({ length: 30 }, (_, i) => `More filler ${i}.`),
    "So remember: potential energy depends on height.",
  ],
  0
);
// "Now, Gravitational Potential" is line 123 → 492s = 8:12.
const GPE_LINE = 123;

const CHEMISTRY = lines(["Bond energy is released when bonds form.", "Activation energy is the minimum energy needed.", "That is all for today."], 600);

const contents = new Map<string, ResourceContent>([
  ["phys", { kind: "youtube", transcript: PHYSICS, extractedAt: 1 }],
  ["chem", { kind: "youtube", transcript: CHEMISTRY, extractedAt: 1 }],
]);
const tabs = [video("phys", "Physics revision"), video("chem", "Chemistry: energetics")];

const transcriptHits = (hits: ProjectSearchHit[]) => hits.filter((hit): hit is Extract<ProjectSearchHit, { type: "source" }> => hit.type === "source" && hit.location.kind === "transcript");

describe("transcript search", () => {
  it("finds a phrase split across caption lines, at the time it is said", () => {
    const hits = transcriptHits(searchProject({ query: "gravitational potential energy", tabs, contents }));
    expect(hits[0]).toMatchObject({ tabId: "phys", location: { kind: "transcript", line: GPE_LINE, start: GPE_LINE * 4 } });
    expect(describeLocation(hits[0]!.location)).toBe("at 8:12");
    expect(hits[0]!.snippet).toContain("Gravitational Potential energy is the energy an object has");
  });

  it("ignores case and stray whitespace and punctuation", () => {
    const a = transcriptHits(searchProject({ query: "  GRAVITATIONAL   potential-Energy ", tabs, contents }));
    const b = transcriptHits(searchProject({ query: "gravitational potential energy", tabs, contents }));
    expect(a.map((hit) => [hit.tabId, hit.location])).toEqual(b.map((hit) => [hit.tabId, hit.location]));
  });

  it("matches the start of a word", () => {
    const hits = transcriptHits(searchProject({ query: "gravitat", tabs, contents }));
    expect(hits.map((hit) => hit.tabId)).toEqual(["phys"]);
  });

  it("needs every word within one passage, not anywhere in the video", () => {
    // "kinetic" is said at 0:08 and "height" minutes later: no single passage says both.
    expect(transcriptHits(searchProject({ query: "kinetic height", tabs, contents }))).toEqual([]);
  });

  it("finds the same word in several videos, each with its own times", () => {
    const hits = transcriptHits(searchProject({ query: "energy", tabs, contents }));
    expect(new Set(hits.map((hit) => hit.tabId))).toEqual(new Set(["phys", "chem"]));
    const chem = hits.filter((hit) => hit.tabId === "chem");
    // Two adjacent lines about energy are one passage, not two results.
    expect(chem).toHaveLength(1);
    expect(chem[0]!.location).toMatchObject({ start: 600 });
  });

  it("ranks the words in the order typed above the same words scattered", () => {
    const hits = transcriptHits(searchProject({ query: "potential energy", tabs, contents }));
    expect(hits[0]!.location).toMatchObject({ line: GPE_LINE });
  });

  it("never joins adjacent lines said minutes apart into one passage", () => {
    const gap: TranscriptSegment[] = [
      { start: 4, text: "Today: energy stores." },
      { start: 522, text: "Gravitational potential energy is mgh." },
    ];
    const moments = transcriptMoments(gap, ["potential", "energy"], "potential energy");
    expect(moments.map((moment) => moment.start)).toEqual([522]);
    expect(moments[0]!.snippet).not.toContain("energy stores");
  });

  it("puts the moment where the words begin, not on a line just before that borrows them", () => {
    const lecture: TranscriptSegment[] = [
      { start: 505, text: "Kinetic energy sentence 100." },
      { start: 522, text: "Gravitational potential energy is the energy an object has" },
      { start: 526, text: "because of its height." },
    ];
    const [moment] = transcriptMoments(lecture, ["gravitational", "potential", "energy"], "gravitational potential energy");
    expect(moment).toMatchObject({ line: 1, start: 522 });
    // A phrase that starts at the end of one line and runs into the next starts on the first.
    const split: TranscriptSegment[] = [
      { start: 0, text: "Filler." },
      { start: 4, text: "Now, gravitational potential" },
      { start: 8, text: "energy is mgh." },
    ];
    expect(transcriptMoments(split, ["gravitational", "potential", "energy"], "gravitational potential energy")[0]).toMatchObject({ line: 1, start: 4 });
  });

  it("never returns two results for one passage", () => {
    const repetitive = lines(["energy energy", "more energy here", "and energy again", "still energy", "energy once more"], 0);
    const moments = transcriptMoments(repetitive, ["energy"]);
    expect(moments).toHaveLength(1);
  });

  it("splits one very long run of mentions into separate moments, and caps a video's moments", () => {
    const long = lines(Array.from({ length: 200 }, () => "energy"), 0);
    const moments = transcriptMoments(long, ["energy"]);
    expect(moments.length).toBe(5);
    const starts = moments.map((moment) => moment.start!).sort((a, b) => a - b);
    for (let i = 1; i < starts.length; i++) expect(starts[i]! - starts[i - 1]!).toBeGreaterThan(60);
  });

  it("reports where the passage ends when the captions say", () => {
    const [moment] = transcriptMoments(CHEMISTRY, ["bond"]);
    expect(moment).toMatchObject({ line: 0, start: 600, end: 612 });
  });

  it("works on transcripts without times", () => {
    const untimed: TranscriptSegment[] = [{ text: "Intro" }, { text: "The quarantine begins" }];
    const [moment] = transcriptMoments(untimed, ["quarantine"]);
    expect(moment).toMatchObject({ line: 1 });
    expect(moment!.start).toBeUndefined();
    expect(describeLocation({ kind: "transcript", line: 1 })).toBe("in the transcript");
  });

  it("only searches the sources it is given — removed or filtered-out ones never appear", () => {
    const hits = searchProject({ query: "energy", tabs: [tabs[1]!], contents });
    expect(hits.every((hit) => hit.type === "source" && hit.tabId === "chem")).toBe(true);
  });

  it("finds a video by title before its transcript has been read", () => {
    const pending = { ...video("new", "Gravitational fields lecture"), resource: { ...ready, status: "processing" as const } };
    const hits = searchProject({ query: "gravitational", tabs: [pending], contents: new Map() });
    expect(hits).toMatchObject([{ type: "source", tabId: "new", location: { kind: "title" } }]);
  });

  it("stays fast over a large collection", () => {
    const many = new Map<string, ResourceContent>();
    const manyTabs = [];
    for (let v = 0; v < 150; v++) {
      many.set(`v${v}`, { kind: "youtube", transcript: lines(Array.from({ length: 900 }, (_, i) => `Line ${i} of lecture ${v} on thermodynamics and entropy.`)), extractedAt: 1 });
      manyTabs.push(video(`v${v}`, `Lecture ${v}`));
    }
    searchProject({ query: "warm up", tabs: manyTabs, contents: many });
    const started = performance.now();
    const hits = searchProject({ query: "entropy lecture 42", tabs: manyTabs, contents: many, limit: 30 });
    expect(performance.now() - started).toBeLessThan(1500);
    expect(hits.length).toBeGreaterThan(0);
  });
});

describe("markMatches", () => {
  it("splits text into matching and plain parts, longest term first", () => {
    expect(markMatches("Potential energy, POTENTIALLY.", ["potential", "energy"])).toEqual([
      { text: "Potential", match: true },
      { text: " ", match: false },
      { text: "energy", match: true },
      { text: ", ", match: false },
      { text: "POTENTIAL", match: true },
      { text: "LY.", match: false },
    ]);
  });

  it("leaves markup in text as text", () => {
    expect(markMatches("<img src=x onerror=alert(1)> energy", ["energy"])).toEqual([
      { text: "<img src=x onerror=alert(1)> ", match: false },
      { text: "energy", match: true },
    ]);
  });
});
