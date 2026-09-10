import { describe, expect, it } from "vitest";
import {
  evaluateMembership,
  isBroadSectionName,
  sectionIdentityTokens,
  tabBelongsInSection,
  tabNamesSection,
  validateSectionMembership,
} from "./membership";
import type { CohortMember } from "./membership";
import type { Section } from "../types";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string; domain: string; title: string }): Tab {
  const url = over.url ?? `https://${over.domain}/${over.id}`;
  return { url, normalizedUrl: url, category: "other", ...over };
}

function makeSection(over: Partial<Section> & { id: string; name: string }): Section {
  return { parentId: null, source: "ai", createdAt: 0, updatedAt: 0, ...over };
}

function cohortOf(tabs: Tab[]): CohortMember[] {
  return tabs.map((tab) => ({ tab }));
}

/** The reported bug's cast: a real ManageBac group, and the tabs that kept getting swept into it. */
const MANAGEBAC = [
  makeTab({ id: "mb1", domain: "managebac.com", title: "ManageBac - Dashboard" }),
  makeTab({ id: "mb2", domain: "managebac.com", title: "Assignments due this week" }),
  makeTab({ id: "mb3", domain: "managebac.com", title: "IB Diploma - Class of 2026" }),
];
const GENIUS = makeTab({ id: "gen", domain: "genius.com", title: "Kendrick Lamar - Money Trees Lyrics | Genius" });
const AI_STUDIO = makeTab({ id: "ais", domain: "aistudio.google.com", title: "Google AI Studio" });
const GOOGLE_SEARCH = makeTab({ id: "gs", domain: "www.google.com", title: "ib diploma deadlines - Google Search" });
const KHAN = makeTab({ id: "kh", domain: "khanacademy.org", title: "Intro to kinematics | Khan Academy" });
const CHATGPT = makeTab({ id: "gpt", domain: "chatgpt.com", title: "ChatGPT - help with my essay" });

describe("isBroadSectionName", () => {
  it("treats legacy categories and generic buckets as broad — they make no topical claim about a tab", () => {
    for (const name of ["School", "Research", "Shopping", "Reference", "General Resources", "Miscellaneous", "Technology"]) {
      expect(isBroadSectionName(name)).toBe(true);
    }
  });

  it("treats a specific site, product or topic name as narrow", () => {
    for (const name of ["ManageBac", "Instagram", "GitHub", "Physics", "TabDump", "Google Docs"]) {
      expect(isBroadSectionName(name)).toBe(false);
    }
  });
});

describe("sectionIdentityTokens", () => {
  it("drops qualifiers that don't say what the section is about", () => {
    expect(sectionIdentityTokens("Physics Research")).toEqual(["physics"]);
    expect(sectionIdentityTokens("S2 Orbit Research")).toEqual(["orbit"]);
  });

  it("keeps the tokens when stripping would leave a section with no identity at all", () => {
    expect(sectionIdentityTokens("Notes")).toEqual(["notes"]);
  });
});

describe("tabNamesSection", () => {
  it("matches a tab whose domain, URL or title carries the section's name", () => {
    expect(tabNamesSection(MANAGEBAC[0], "ManageBac")).toBe(true);
    expect(tabNamesSection(MANAGEBAC[1], "ManageBac")).toBe(true); // domain alone, title never says it
    expect(tabNamesSection(makeTab({ id: "x", domain: "example.com", title: "Physics 101 notes" }), "Physics")).toBe(true);
  });

  it("does not match a tab that merely shares a broad theme with the name", () => {
    expect(tabNamesSection(GENIUS, "ManageBac")).toBe(false);
    expect(tabNamesSection(AI_STUDIO, "ManageBac")).toBe(false);
    expect(tabNamesSection(KHAN, "ManageBac")).toBe(false);
  });
});

describe("evaluateMembership — the reported ManageBac bug", () => {
  it("admits a real ManageBac tab on site evidence", () => {
    expect(evaluateMembership(MANAGEBAC[0], "ManageBac", cohortOf(MANAGEBAC))).toBe("site");
  });

  it.each([
    ["a lyrics site", GENIUS],
    ["an unrelated AI tool", AI_STUDIO],
    ["a Google search", GOOGLE_SEARCH],
    ["an unrelated educational site", KHAN],
    ["another unrelated AI tool", CHATGPT],
  ])("rejects %s from ManageBac", (_label, tab) => {
    expect(evaluateMembership(tab, "ManageBac", cohortOf(MANAGEBAC))).toBe("none");
  });

  it("still rejects them once even one real member of the group is visible", () => {
    expect(tabBelongsInSection(GENIUS, "ManageBac", cohortOf([MANAGEBAC[0]]))).toBe(false);
    expect(tabBelongsInSection(AI_STUDIO, "ManageBac", cohortOf([MANAGEBAC[0]]))).toBe(false);
  });

  it("rejects with no cohort at all — not knowing who else is in a group is no reason to admit someone", () => {
    // The conservative default. An incremental dump that can see none of
    // ManageBac's real tabs still keeps a lyrics page out of it; the tab
    // lands in a broad category or a deterministic bucket instead.
    expect(evaluateMembership(GENIUS, "ManageBac", [])).toBe("none");
    expect(evaluateMembership(AI_STUDIO, "ManageBac", [])).toBe("none");
    expect(tabBelongsInSection(GENIUS, "ManageBac")).toBe(false);
  });

  it("still admits a real member with no cohort — its own domain is evidence enough", () => {
    expect(evaluateMembership(MANAGEBAC[0], "ManageBac", [])).toBe("site");
  });

  it("does not let one unrelated tab vouch for another just because they resemble each other", () => {
    // Two genius.com tabs sitting in ManageBac share plenty of vocabulary with
    // EACH OTHER. Peer evidence only ever chains from an anchored member, so
    // neither of them props the other up.
    const secondGenius = makeTab({ id: "gen2", domain: "genius.com", title: "SZA - Money Trees verse | Genius lyrics" });
    const contaminated = cohortOf([...MANAGEBAC, GENIUS, secondGenius]);
    expect(evaluateMembership(GENIUS, "ManageBac", contaminated)).toBe("none");
    expect(evaluateMembership(secondGenius, "ManageBac", contaminated)).toBe("none");
  });

  it("never blocks a broad category, so a rejected tab still has somewhere honest to land", () => {
    expect(evaluateMembership(GENIUS, "School", [])).toBe("broad");
  });
});

describe("evaluateMembership — generality beyond ManageBac", () => {
  it("keeps a site group to its own site (Instagram)", () => {
    const instagram = [
      makeTab({ id: "ig1", domain: "www.instagram.com", title: "Instagram" }),
      makeTab({ id: "ig2", domain: "m.instagram.com", title: "jane_doe - photos and videos" }),
      makeTab({ id: "ig3", domain: "instagram.com", title: "Reels" }),
    ];
    const cohort = cohortOf(instagram);
    expect(evaluateMembership(instagram[1], "Instagram", cohort)).toBe("site");
    expect(evaluateMembership(makeTab({ id: "tt", domain: "tiktok.com", title: "For You - TikTok" }), "Instagram", cohort)).toBe("none");
    expect(evaluateMembership(makeTab({ id: "fb", domain: "facebook.com", title: "Facebook" }), "Instagram", cohort)).toBe("none");
  });

  it("keeps a code-hosting group to its own site (GitHub)", () => {
    const github = [
      makeTab({ id: "gh1", domain: "github.com", title: "biterate-7/tabdump" }),
      makeTab({ id: "gh2", domain: "github.com", title: "Issues - biterate-7/tabdump" }),
    ];
    const cohort = cohortOf(github);
    expect(evaluateMembership(github[0], "GitHub", cohort)).toBe("site");
    expect(evaluateMembership(makeTab({ id: "sh", domain: "www.amazon.com", title: "Amazon.com: mechanical keyboard" }), "GitHub", cohort)).toBe("none");
  });

  it("lets a topic group span domains when members share real vocabulary, and still turns away a stranger", () => {
    const anchor = makeTab({ id: "p1", domain: "en.wikipedia.org", title: "Schwarzschild metric - physics of black holes" });
    const cohort = cohortOf([anchor]);

    // Never says "physics", lives on a different site, and is still plainly
    // the same subject: two specific words shared with an anchored member.
    const sameTopic = makeTab({ id: "p2", domain: "arxiv.org", title: "Schwarzschild geometry near black holes" });
    expect(evaluateMembership(sameTopic, "Physics", cohort)).toBe("peer");

    // One word in common is a coincidence, not a topic.
    const oneWordInCommon = makeTab({ id: "p3", domain: "investopedia.com", title: "Black Friday retail deals roundup" });
    expect(evaluateMembership(oneWordInCommon, "Physics", cohort)).toBe("none");
    expect(evaluateMembership(makeTab({ id: "sp", domain: "open.spotify.com", title: "Discover Weekly" }), "Physics", cohort)).toBe("none");
  });

  it("rejects a tab it cannot tie to the group, accepting the false negative", () => {
    // "Curved spacetime and geodesics" really is physics, and with no cohort
    // to compare against there is no way to show it. The conservative answer
    // wins: it is filed one level up rather than guessed into Physics. Give
    // the check one anchored member and it gets in on peer evidence — which
    // is why the pipeline feeds it every section's real occupants.
    const orphan = makeTab({ id: "u", domain: "example.com", title: "Curved spacetime and geodesics" });
    expect(evaluateMembership(orphan, "Physics", [])).toBe("none");

    const anchor = makeTab({ id: "p", domain: "example.com", title: "Curved spacetime in physics — geodesics explained" });
    expect(evaluateMembership(orphan, "Physics", cohortOf([anchor]))).toBe("peer");
  });
});

describe("validateSectionMembership", () => {
  const managebacSection = makeSection({ id: "sec-mb", name: "ManageBac" });

  it("unfiles the tabs a group has no evidence for and leaves the real members alone", () => {
    const tabs = [...MANAGEBAC, GENIUS, AI_STUDIO].map((t) => ({ ...t, sectionId: managebacSection.id, organizationStatus: "classified" as const }));

    const result = validateSectionMembership(tabs, [managebacSection]);

    expect(result.evictedIds.sort()).toEqual(["ais", "gen"]);
    for (const id of ["mb1", "mb2", "mb3"]) {
      expect(result.tabs.find((t) => t.id === id)?.sectionId).toBe(managebacSection.id);
    }
    for (const id of ["gen", "ais"]) {
      const evicted = result.tabs.find((t) => t.id === id)!;
      expect(evicted.sectionId).toBeUndefined();
      expect(evicted.organizationStatus).toBe("uncertain");
      expect(evicted.organizationReason).toContain("ManageBac");
    }
  });

  it("returns the original array untouched when every membership checks out", () => {
    const tabs = MANAGEBAC.map((t) => ({ ...t, sectionId: managebacSection.id }));
    const result = validateSectionMembership(tabs, [managebacSection]);
    expect(result.evictedIds).toEqual([]);
    expect(result.tabs).toBe(tabs);
  });

  it("never touches a placement the user made by hand", () => {
    const locked = { ...GENIUS, sectionId: managebacSection.id, sectionLocked: true };
    const manual = { ...AI_STUDIO, sectionId: managebacSection.id, organizationStatus: "manual" as const };
    const tabs = [...MANAGEBAC.map((t) => ({ ...t, sectionId: managebacSection.id })), locked, manual];

    const result = validateSectionMembership(tabs, [managebacSection]);

    expect(result.evictedIds).toEqual([]);
    expect(result.tabs.find((t) => t.id === "gen")?.sectionId).toBe(managebacSection.id);
    expect(result.tabs.find((t) => t.id === "ais")?.sectionId).toBe(managebacSection.id);
  });

  it("leaves a broad bucket alone — 'Reference' claims nothing about what's in it", () => {
    const reference = makeSection({ id: "sec-ref", name: "General Resources" });
    const tabs = [GENIUS, AI_STUDIO, KHAN].map((t) => ({ ...t, sectionId: reference.id }));
    expect(validateSectionMembership(tabs, [reference]).evictedIds).toEqual([]);
  });

  it("has no exemption for how a tab got there — clustering does not buy a place in the wrong group", () => {
    // Two genius.com tabs are a genuine cluster, and clustering placing them
    // together says nothing about whether ManageBac is where that cluster
    // belongs. Nothing about their origin exempts them from the check.
    const secondGenius = makeTab({ id: "gen2", domain: "genius.com", title: "SZA - Money Trees verse | Genius lyrics" });
    const tabs = [...MANAGEBAC, GENIUS, secondGenius].map((t) => ({ ...t, sectionId: managebacSection.id }));

    const result = validateSectionMembership(tabs, [managebacSection]);

    expect(result.evictedIds.sort()).toEqual(["gen", "gen2"]);
  });
});
