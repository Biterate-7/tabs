import { afterEach, describe, expect, it, vi } from "vitest";
import { organizeTabsIntoSections } from "./organize";
import type { Section } from "../types";
import type { Tab } from "@/lib/tabs/types";
import type { SemanticClusterHint } from "@/lib/organize/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return { url: `https://example.com/${over.id}`, normalizedUrl: `https://example.com/${over.id}`, domain: "example.com", category: "other", ...over };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("organizeTabsIntoSections", () => {
  it("creates a well-evidenced single-tab subsection: existing parent category + the tab's own title backs the specific name", async () => {
    const existingRoot: Section = { id: "root-school", parentId: null, name: "School", source: "user", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: [{ tabId: "1", path: ["School", "Physics"], confidence: "high", reason: "Discusses physics coursework." }],
      })
    );

    const result = await organizeTabsIntoSections(
      [makeTab({ id: "1", category: "school", title: "Physics 101 - Classroom" })],
      [existingRoot]
    );

    const physics = result.sections.find((s) => s.name === "Physics")!;
    expect(physics).toBeDefined();
    expect(physics.parentId).toBe(existingRoot.id);
    expect(result.tabs[0].sectionId).toBe(physics.id);
    expect(result.tabs[0].organizationStatus).toBe("classified");
    expect(result.tabs[0].organizationReason).toBe("Discusses physics coursework.");
  });

  it("does NOT create a new subsection/category from a single high-confidence tab with no corroboration and no existing parent (evidence too weak)", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: [{ tabId: "1", path: ["Projects", "Chrome Extension Documentation"], confidence: "high", reason: "" }],
      })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1", category: "other", title: "API reference" })], []);

    expect(result.sections).toEqual([]);
    expect(result.tabs[0].sectionId).toBeUndefined();
    expect(result.tabs[0].organizationStatus).toBe("uncertain");
  });

  it("creates a new subsection when two tabs in the batch agree on the same leaf, even without an existing parent or keyword overlap", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          { tabId: "1", path: ["Projects", "TabDump"], confidence: "high", reason: "Part of the TabDump codebase." },
          { tabId: "2", path: ["Projects", "TabDump"], confidence: "high", reason: "Part of the TabDump codebase." },
        ],
      })
    );

    const result = await organizeTabsIntoSections(
      [makeTab({ id: "1", category: "projects" }), makeTab({ id: "2", category: "projects" })],
      []
    );

    expect(result.sections.map((s) => s.name).sort()).toEqual(["Projects", "TabDump"]);
    expect(result.tabs.every((t) => t.organizationStatus === "classified")).toBe(true);
    expect(result.tabs.every((t) => t.organizationReason === "Part of the TabDump codebase.")).toBe(true);
  });

  it("reuses an existing similarly-named section instead of creating a duplicate", async () => {
    const existing: Section = { id: "existing-physics", parentId: null, name: "Physics", source: "user", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Physics Research"], confidence: "high", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1" })], [existing]);

    expect(result.sections).toHaveLength(1); // no new section created
    expect(result.tabs[0].sectionId).toBe("existing-physics");
  });

  it("never reassigns a section-locked tab, and never sends it to the model", async () => {
    const fetchSpy = vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "2", path: ["Research"], confidence: "high", reason: "" }] })
    );

    const locked = makeTab({ id: "1", sectionId: "manual", sectionLocked: true });
    const unlocked = makeTab({ id: "2", category: "research" });
    const result = await organizeTabsIntoSections([locked, unlocked], []);

    expect(result.tabs.find((t) => t.id === "1")).toEqual(locked);
    const promptSent = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string).prompt as string;
    expect(promptSent).not.toContain("id=1 ");
  });

  it("falls back deterministically (by legacy category) when the model call fails over the network", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await organizeTabsIntoSections([makeTab({ id: "1", category: "shopping" })], []);

    expect(result.tabs[0].organizationStatus).toBe("fallback");
    expect(result.sections.map((s) => s.name)).toEqual(["Shopping"]);
    expect(result.tabs[0].sectionId).toBe(result.sections[0].id);
  });

  it("falls back deterministically when the model returns malformed JSON", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(jsonResponse({ data: "not an array" }));

    const result = await organizeTabsIntoSections([makeTab({ id: "1", category: "news" })], []);

    expect(result.tabs[0].organizationStatus).toBe("fallback");
    expect(result.sections.map((s) => s.name)).toEqual(["News"]);
  });

  it("dumping never throws even when the AI service is completely unreachable", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new Error("boom"));
    await expect(organizeTabsIntoSections([makeTab({ id: "1" })], [])).resolves.toBeDefined();
  });

  it("detects a project cluster in the fallback path via shared embedding-cluster hints", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const tabs = [
      makeTab({ id: "1", category: "research", title: "Schwarzschild metric paper" }),
      makeTab({ id: "2", category: "research", title: "S2 star orbit data" }),
      makeTab({ id: "3", category: "research", title: "General relativity notes" }),
    ];
    const hints: SemanticClusterHint[] = tabs.map((t) => ({ tabId: t.id, clusterKey: "sem-0" }));

    const result = await organizeTabsIntoSections(tabs, [], hints);

    // A root "Research" section plus a derived subsection for the shared cluster.
    expect(result.sections.some((s) => s.name === "Research" && s.parentId === null)).toBe(true);
    const researchRoot = result.sections.find((s) => s.name === "Research")!;
    const sub = result.sections.find((s) => s.parentId === researchRoot.id);
    expect(sub).toBeDefined();
    expect(result.tabs.every((t) => t.sectionId === sub!.id)).toBe(true);
  });

  it("does not create a subsection in the fallback path when the shared cluster is too small", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const tabs = [
      makeTab({ id: "1", category: "research" }),
      makeTab({ id: "2", category: "research" }),
    ];
    const hints: SemanticClusterHint[] = tabs.map((t) => ({ tabId: t.id, clusterKey: "sem-0" }));

    const result = await organizeTabsIntoSections(tabs, [], hints);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].name).toBe("Research");
  });

  it("downgrades a low-confidence assignment to an existing ancestor instead of creating a new section", async () => {
    const existingRoot: Section = { id: "root-research", parentId: null, name: "Research", source: "ai", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Research", "Obscure Topic"], confidence: "low", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1" })], [existingRoot]);

    expect(result.sections).toHaveLength(1); // "Obscure Topic" never created
    expect(result.tabs[0].sectionId).toBe("root-research");
    expect(result.tabs[0].organizationStatus).toBe("uncertain");
  });

  it("leaves a tab unset (falls into Other) when a low-confidence assignment has no existing ancestor at all", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Totally New Thing"], confidence: "low", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1" })], []);

    expect(result.sections).toEqual([]);
    expect(result.tabs[0].sectionId).toBeUndefined();
    expect(result.tabs[0].organizationStatus).toBe("uncertain");
  });

  it("applies a medium-confidence assignment shared by two or more tabs in the batch", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          { tabId: "1", path: ["Projects", "TabDump"], confidence: "medium", reason: "" },
          { tabId: "2", path: ["Projects", "TabDump"], confidence: "medium", reason: "" },
        ],
      })
    );

    const result = await organizeTabsIntoSections(
      [makeTab({ id: "1", category: "projects" }), makeTab({ id: "2", category: "projects" })],
      []
    );

    expect(result.sections.map((s) => s.name).sort()).toEqual(["Projects", "TabDump"]);
    expect(result.tabs.every((t) => t.organizationStatus === "classified")).toBe(true);
  });

  it("downgrades an isolated medium-confidence assignment (no agreement) instead of creating a section", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Projects", "Lonely Project"], confidence: "medium", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1", category: "projects" })], []);

    expect(result.sections.some((s) => s.name === "Lonely Project")).toBe(false);
  });

  it("never creates a real 'Other' root section in the fallback path — an other-categorized tab with no cluster just stays unset", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const result = await organizeTabsIntoSections([makeTab({ id: "1", category: "other" })], []);

    expect(result.sections).toEqual([]);
    expect(result.tabs[0].sectionId).toBeUndefined();
    expect(result.tabs[0].organizationStatus).toBe("uncertain");
  });

  it("promotes a strong cluster among other-categorized tabs straight to its own root, skipping the blocked 'Other' parent", async () => {
    vi.spyOn(global, "fetch").mockRejectedValue(new TypeError("Failed to fetch"));

    const tabs = [
      makeTab({ id: "1", category: "other", title: "Vintage synthesizer forum" }),
      makeTab({ id: "2", category: "other", title: "Vintage synthesizer parts" }),
      makeTab({ id: "3", category: "other", title: "Vintage synthesizer repair" }),
    ];
    const hints: SemanticClusterHint[] = tabs.map((t) => ({ tabId: t.id, clusterKey: "sem-0" }));

    const result = await organizeTabsIntoSections(tabs, [], hints);

    expect(result.sections).toHaveLength(1);
    expect(result.sections[0].name).not.toBe("Other");
    expect(result.sections[0].parentId).toBeNull();
    expect(result.tabs.every((t) => t.sectionId === result.sections[0].id)).toBe(true);
  });

  it("never creates a real 'Other' root even when the model itself confidently proposes it", async () => {
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Other"], confidence: "high", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1" })], []);

    expect(result.sections).toEqual([]);
    expect(result.tabs[0].sectionId).toBeUndefined();
  });

  it("is a no-op when every tab is already section-locked", async () => {
    const fetchSpy = vi.spyOn(global, "fetch");
    const tabs = [makeTab({ id: "1", sectionId: "x", sectionLocked: true })];

    const result = await organizeTabsIntoSections(tabs, []);

    expect(result.tabs).toEqual(tabs);
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("organizeTabsIntoSections — section explosion prevention", () => {
  it("consolidates several clearly-related tabs into ONE subsection when the model proposes a consistent path", async () => {
    const variants = ["Physics textbook", "Physics lecture", "Physics homework", "Physics notes", "Physics article", "Physics simulation", "Physics assignment"];
    const tabs = variants.map((title, i) => makeTab({ id: `${i + 1}`, category: "school", title }));
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: tabs.map((t) => ({ tabId: t.id, path: ["School", "Physics"], confidence: "high", reason: "" })),
      })
    );

    const result = await organizeTabsIntoSections(tabs, []);

    expect(result.sections.map((s) => s.name).sort()).toEqual(["Physics", "School"]);
    const physics = result.sections.find((s) => s.name === "Physics")!;
    expect(result.tabs.every((t) => t.sectionId === physics.id)).toBe(true);
  });

  it("refuses to create a fragmented per-variant subsection when the model (wrongly) proposes a different one-off leaf for each tab", async () => {
    const existingSchool: Section = { id: "root-school", parentId: null, name: "School", source: "user", createdAt: 0, updatedAt: 0 };
    const variants = ["Homework", "Lecture", "Notes", "Article", "Simulation", "Assignment", "Textbook"];
    const tabs = variants.map((v, i) => makeTab({ id: `${i + 1}`, category: "school", title: `Physics ${v}` }));
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: tabs.map((t, i) => ({ tabId: t.id, path: ["School", "Physics", variants[i]], confidence: "high", reason: "" })),
      })
    );

    const result = await organizeTabsIntoSections(tabs, [existingSchool]);

    // None of the seven distinct single-tab leaves should have been created —
    // each lacked corroboration, so at most the pre-existing "School" root
    // is reused; no "Physics" node and none of its seven variants exist.
    expect(result.sections.map((s) => s.name)).toEqual(["School"]);
  });
});

describe("organizeTabsIntoSections — duplicate section prevention", () => {
  it("reuses an existing top-level 'Physics' for every naming variant the model proposes, never creating a sibling like 'Physics Research'", async () => {
    const existingPhysics: Section = { id: "root-physics", parentId: null, name: "Physics", source: "user", createdAt: 0, updatedAt: 0 };
    const proposals = ["Physics", "Physics Research", "Physics Resources"];
    const tabs = proposals.map((_, i) => makeTab({ id: `${i + 1}`, category: "school" }));
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: tabs.map((t, i) => ({ tabId: t.id, path: [proposals[i]], confidence: "high", reason: "" })),
      })
    );

    const result = await organizeTabsIntoSections(tabs, [existingPhysics]);

    expect(result.sections).toEqual([existingPhysics]);
    expect(result.tabs.every((t) => t.sectionId === existingPhysics.id)).toBe(true);
  });

  it("reuses an existing nested 'School > Physics' even when a moved/renamed tree means it's no longer where a naive lookup might expect", async () => {
    const school: Section = { id: "root-school", parentId: null, name: "School", source: "user", createdAt: 0, updatedAt: 0 };
    const research: Section = { id: "root-research", parentId: null, name: "Research", source: "user", createdAt: 0, updatedAt: 0 };
    // Physics lives under Research, not School — simulating a user having
    // manually moved it there (spec: "AI respects the new hierarchy").
    const physics: Section = { id: "physics", parentId: research.id, name: "Physics", source: "user", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Research", "Physics"], confidence: "high", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1" })], [school, research, physics]);

    expect(result.sections).toEqual([school, research, physics]); // nothing new created
    expect(result.tabs[0].sectionId).toBe(physics.id);
  });
});

describe("organizeTabsIntoSections — project detection", () => {
  it("clusters several project-identifying tabs under one new Projects/<name> section", async () => {
    const tabs = [
      makeTab({ id: "1", category: "projects", domain: "github.com", title: "Biterate-7/tabdump" }),
      makeTab({ id: "2", category: "projects", domain: "github.com", title: "TabDump architecture notes" }),
      makeTab({ id: "3", category: "other", domain: "vercel.com", title: "tabdump — Vercel deployment" }),
      makeTab({ id: "4", category: "other", domain: "developer.chrome.com", title: "Chrome Extensions API reference" }),
      makeTab({ id: "5", category: "other", domain: "nextjs.org", title: "Next.js Docs" }),
    ];
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: tabs.map((t) => ({ tabId: t.id, path: ["Projects", "TabDump"], confidence: "high", reason: "Part of the TabDump project." })),
      })
    );

    const result = await organizeTabsIntoSections(tabs, []);

    expect(result.sections.map((s) => s.name).sort()).toEqual(["Projects", "TabDump"]);
    const tabDump = result.sections.find((s) => s.name === "TabDump")!;
    expect(tabDump.parentId).toBe(result.sections.find((s) => s.name === "Projects")!.id);
    expect(result.tabs.every((t) => t.sectionId === tabDump.id && t.organizationStatus === "classified")).toBe(true);
  });

  it("clusters a research topic into an existing School/Physics subsection as a new project underneath it", async () => {
    const school: Section = { id: "root-school", parentId: null, name: "School", source: "ai", createdAt: 0, updatedAt: 0 };
    const physics: Section = { id: "physics", parentId: school.id, name: "Physics", source: "ai", createdAt: 0, updatedAt: 0 };
    const tabs = [
      makeTab({ id: "1", category: "research", title: "S2 star orbit paper" }),
      makeTab({ id: "2", category: "research", title: "Schwarzschild solution" }),
      makeTab({ id: "3", category: "research", title: "General relativity notes" }),
    ];
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: tabs.map((t) => ({ tabId: t.id, path: ["School", "Physics", "S2 / General Relativity"], confidence: "high", reason: "" })),
      })
    );

    const result = await organizeTabsIntoSections(tabs, [school, physics]);

    const project = result.sections.find((s) => s.name === "S2 / General Relativity");
    expect(project).toBeDefined();
    expect(project!.parentId).toBe(physics.id);
    expect(result.tabs.every((t) => t.sectionId === project!.id)).toBe(true);
  });
});

describe("organizeTabsIntoSections — unrelated tabs stay distributed", () => {
  it("does not invent an artificial umbrella category for two genuinely unrelated low-confidence tabs, even while well-evidenced tabs elsewhere in the same batch are placed normally", async () => {
    const research: Section = { id: "root-research", parentId: null, name: "Research", source: "user", createdAt: 0, updatedAt: 0 };
    const projects: Section = { id: "root-projects", parentId: null, name: "Projects", source: "user", createdAt: 0, updatedAt: 0 };
    const tabs = [
      makeTab({ id: "1", category: "research", domain: "wikipedia.org", title: "Physics textbook" }),
      makeTab({ id: "2", category: "shopping", domain: "amazon.com", title: "Running shoes" }),
      makeTab({ id: "3", category: "other", domain: "youtube.com", title: "Music video" }),
      makeTab({ id: "4", category: "projects", domain: "github.com", title: "Biterate-7/tabdump" }),
      makeTab({ id: "5", category: "other", domain: "cnn.com", title: "Breaking news article" }),
      makeTab({ id: "6", category: "projects", domain: "github.com", title: "Biterate-7/tabdump pull request #12" }),
    ];
    // A poorly-behaved model proposing a shared umbrella for the two
    // one-off "other" tabs despite them having nothing to do with each
    // other — only low confidence behind it, no real batch evidence.
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: [
          { tabId: "1", path: ["Research", "Physics"], confidence: "high", reason: "" },
          { tabId: "2", path: ["Shopping"], confidence: "high", reason: "" },
          { tabId: "3", path: ["Research", "Random Internet"], confidence: "low", reason: "" },
          { tabId: "4", path: ["Projects", "TabDump"], confidence: "high", reason: "" },
          { tabId: "5", path: ["Research", "Random Internet"], confidence: "low", reason: "" },
          { tabId: "6", path: ["Projects", "TabDump"], confidence: "high", reason: "" },
        ],
      })
    );

    const result = await organizeTabsIntoSections(tabs, [research, projects]);

    // The bogus umbrella is never created, no matter how many low-confidence
    // votes it got.
    expect(result.sections.some((s) => s.name === "Random Internet")).toBe(false);
    // Well-evidenced placements (existing category + a title that actually
    // supports the specific name) still succeed normally in the same batch.
    expect(result.sections.some((s) => s.name === "Physics")).toBe(true);
    expect(result.sections.some((s) => s.name === "Shopping")).toBe(true);
    expect(result.sections.some((s) => s.name === "TabDump")).toBe(true);
    // The two stray tabs land at most in the existing "Research" root
    // (a safe, pre-existing ancestor) — never in a newly-invented section,
    // and never grouped together under one the model made up.
    const youtube = result.tabs.find((t) => t.id === "3")!;
    const cnn = result.tabs.find((t) => t.id === "5")!;
    expect([undefined, research.id]).toContain(youtube.sectionId);
    expect([undefined, research.id]).toContain(cnn.sectionId);
  });
});

describe("organizeTabsIntoSections — realistic mixed batch (20+ tabs)", () => {
  it("clusters related tabs, reuses existing sections, groups a project, distributes unrelated tabs, and never touches a locked tab", async () => {
    const school: Section = { id: "root-school", parentId: null, name: "School", source: "ai", createdAt: 0, updatedAt: 0 };
    const research: Section = { id: "root-research", parentId: null, name: "Research", source: "ai", createdAt: 0, updatedAt: 0 };

    const locked = makeTab({ id: "locked-1", sectionId: "user-picked", sectionLocked: true, organizationStatus: "manual", category: "school" });

    const batch = [
      // School / Physics (3)
      makeTab({ id: "p1", category: "school", title: "Physics 101 syllabus" }),
      makeTab({ id: "p2", category: "school", title: "Physics lecture notes" }),
      makeTab({ id: "p3", category: "school", title: "Physics homework 4" }),
      // School / Economics (2)
      makeTab({ id: "e1", category: "school", title: "Economics midterm review" }),
      makeTab({ id: "e2", category: "school", title: "Economics case study" }),
      // School / History (2)
      makeTab({ id: "h1", category: "school", title: "History reading" }),
      makeTab({ id: "h2", category: "school", title: "History essay draft" }),
      // Projects / TabDump (4) — a real cross-domain project cluster
      makeTab({ id: "t1", category: "projects", domain: "github.com", title: "Biterate-7/tabdump" }),
      makeTab({ id: "t2", category: "projects", domain: "github.com", title: "tabdump pull request #12" }),
      makeTab({ id: "t3", category: "other", domain: "vercel.com", title: "tabdump — deployment" }),
      makeTab({ id: "t4", category: "other", domain: "developer.chrome.com", title: "Chrome Extensions API (for tabdump)" }),
      // Research / University (2)
      makeTab({ id: "u1", category: "research", title: "University application checklist" }),
      makeTab({ id: "u2", category: "research", title: "University application essay" }),
      // Research / Law (2)
      makeTab({ id: "l1", category: "research", title: "Law case brief" }),
      makeTab({ id: "l2", category: "research", title: "Law journal article" }),
      // Shopping, no subsection (2)
      makeTab({ id: "s1", category: "shopping", title: "Running shoes" }),
      makeTab({ id: "s2", category: "shopping", title: "Desk lamp" }),
      // Unrelated one-offs — should scatter, not form an umbrella (3)
      makeTab({ id: "n1", category: "other", domain: "youtube.com", title: "Live concert clip" }),
      makeTab({ id: "n2", category: "other", domain: "cnn.com", title: "Election coverage" }),
      makeTab({ id: "n3", category: "other", domain: "reddit.com", title: "Random thread" }),
    ];

    function pathFor(id: string): string[] {
      if (id.startsWith("p")) return ["School", "Physics"];
      if (id.startsWith("e")) return ["School", "Economics"];
      if (id.startsWith("h")) return ["School", "History"];
      if (id.startsWith("t")) return ["Projects", "TabDump"];
      if (id.startsWith("u")) return ["Research", "University"];
      if (id.startsWith("l")) return ["Research", "Law"];
      if (id.startsWith("s")) return ["Shopping"];
      return ["Other-Guess"]; // the n* tabs: model can't confidently place them
    }
    function confidenceFor(id: string): "high" | "low" {
      return id.startsWith("n") ? "low" : "high";
    }

    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({
        data: batch.map((t) => ({ tabId: t.id, path: pathFor(t.id), confidence: confidenceFor(t.id), reason: "" })),
      })
    );

    const result = await organizeTabsIntoSections([locked, ...batch], [school, research]);

    // The locked tab is never touched.
    expect(result.tabs.find((t) => t.id === "locked-1")).toEqual(locked);

    // Existing top-level sections are reused, not duplicated.
    expect(result.sections.filter((s) => s.name === "School")).toHaveLength(1);
    expect(result.sections.filter((s) => s.name === "Research")).toHaveLength(1);
    expect(result.sections.find((s) => s.name === "School")!.id).toBe(school.id);
    expect(result.sections.find((s) => s.name === "Research")!.id).toBe(research.id);

    // Related tabs cluster: every physics tab shares one Physics section, nested under School.
    const physics = result.sections.find((s) => s.name === "Physics")!;
    expect(physics).toBeDefined();
    expect(physics.parentId).toBe(school.id);
    for (const id of ["p1", "p2", "p3"]) {
      expect(result.tabs.find((t) => t.id === id)!.sectionId).toBe(physics.id);
    }

    // The cross-domain project cluster is grouped as one Projects/TabDump section.
    const tabDump = result.sections.find((s) => s.name === "TabDump")!;
    expect(tabDump).toBeDefined();
    for (const id of ["t1", "t2", "t3", "t4"]) {
      expect(result.tabs.find((t) => t.id === id)!.sectionId).toBe(tabDump.id);
    }

    // Other clearly-evidenced clusters also land correctly and distinctly.
    expect(result.sections.some((s) => s.name === "Economics" && s.parentId === school.id)).toBe(true);
    expect(result.sections.some((s) => s.name === "History" && s.parentId === school.id)).toBe(true);
    expect(result.sections.some((s) => s.name === "University" && s.parentId === research.id)).toBe(true);
    expect(result.sections.some((s) => s.name === "Law" && s.parentId === research.id)).toBe(true);
    expect(result.sections.some((s) => s.name === "Shopping")).toBe(true);

    // No section explosion: exactly one section per real cluster above, no
    // near-duplicates and no invented umbrella for the unrelated tabs.
    expect(result.sections.some((s) => s.name === "Other-Guess")).toBe(false);
    const names = result.sections.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length); // no duplicate names anywhere in the tree

    // "Other reduction": every well-evidenced tab (18 of 20 unlocked — everything but the 3 low-confidence n* tabs) got a real section.
    const organizedCount = batch.filter((t) => !t.id.startsWith("n")).length;
    const actuallyOrganized = result.tabs.filter((t) => t.id !== "locked-1" && t.sectionId !== undefined).length;
    expect(actuallyOrganized).toBeGreaterThanOrEqual(organizedCount);

    // The genuinely unrelated, low-confidence tabs have no existing ancestor
    // to safely fall back to (nothing resembling "Other-Guess" exists), so
    // they're left unset (Other) rather than grouped into a fabricated cluster.
    for (const id of ["n1", "n2", "n3"]) {
      expect(result.tabs.find((t) => t.id === id)!.sectionId).toBeUndefined();
    }
  });
});

describe("organizeTabsIntoSections — manual organization is authoritative", () => {
  it("never removes a user-created section, even one with no tabs after this run", async () => {
    const userSection: Section = { id: "user-1", parentId: null, name: "Law", source: "user", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Shopping"], confidence: "high", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1", category: "shopping" })], [userSection]);

    expect(result.sections.some((s) => s.id === userSection.id && s.name === "Law")).toBe(true);
  });

  it("never renames a section itself — a user's chosen name for an existing section is preserved verbatim even when the model uses different wording for the same node", async () => {
    const renamed: Section = { id: "s1", parentId: null, name: "CS", source: "user", createdAt: 0, updatedAt: 0 };
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "1", path: ["Computer Science"], confidence: "high", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([makeTab({ id: "1" })], [renamed]);

    const match = result.sections.find((s) => s.id === "s1")!;
    expect(match.name).toBe("CS"); // unchanged — findSimilarSibling matched it for reuse, nothing renamed it
    expect(result.sections).toHaveLength(1); // no duplicate "Computer Science" created either
  });

  it("skips a locked tab entirely while still organizing its unlocked siblings in the same batch", async () => {
    const locked = makeTab({ id: "1", sectionId: "manual-section", sectionLocked: true, organizationStatus: "manual" });
    const unlocked = makeTab({ id: "2", category: "shopping" });
    vi.spyOn(global, "fetch").mockResolvedValue(
      jsonResponse({ data: [{ tabId: "2", path: ["Shopping"], confidence: "high", reason: "" }] })
    );

    const result = await organizeTabsIntoSections([locked, unlocked], []);

    expect(result.tabs.find((t) => t.id === "1")).toEqual(locked);
    expect(result.tabs.find((t) => t.id === "2")?.sectionId).toBeDefined();
  });
});
