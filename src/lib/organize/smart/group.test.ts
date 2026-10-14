import { describe, expect, it } from "vitest";
import { describeAddress } from "./items";
import { proposeSmartOrganization, stem, topicText } from "./group";
import type { Workspace } from "@/lib/workspace/types";
import type { SmartItem, SmartProposal } from "./types";

let counter = 0;
function item(url: string, title: string, extra: Partial<SmartItem> = {}): SmartItem {
  const address = describeAddress(url);
  if (!address) throw new Error(`bad fixture url ${url}`);
  counter += 1;
  return { id: `chrome-${counter}`, ...address, title, ...extra };
}

function subject(id: string, name: string, tabs: { url: string; title?: string }[] = []): Workspace {
  return {
    id,
    name,
    tabs: tabs.map((tab, index) => {
      const address = describeAddress(tab.url)!;
      return { id: `${id}-tab-${index}`, url: address.url, normalizedUrl: address.normalizedUrl, domain: address.domain, ...(tab.title ? { title: tab.title } : {}) };
    }),
    createdAt: 1,
    updatedAt: 1,
  };
}

function titlesByGroup(proposal: SmartProposal): Record<string, string[]> {
  const byId = new Map(proposal.items.map((entry) => [entry.id, entry]));
  return Object.fromEntries(proposal.groups.map((group) => [group.name, group.itemIds.map((id) => byId.get(id)!.title).sort()]));
}

function reviewTitles(proposal: SmartProposal): string[] {
  const byId = new Map(proposal.items.map((entry) => [entry.id, entry]));
  return proposal.review.map((id) => byId.get(id)!.title).sort();
}

const openTabs = (items: SmartItem[], subjects: Workspace[] = []) => proposeSmartOrganization(items, { mode: "open-tabs", subjects });

describe("topic words", () => {
  it("drops the part of a title that only names the site", () => {
    expect(topicText("Projectile motion - YouTube", "youtube.com")).toBe("Projectile motion");
    expect(topicText("Photosynthesis | Khan Academy", "khanacademy.org")).toBe("Photosynthesis");
    expect(topicText("Vectors | The Physics Classroom", "physicsclassroom.com")).toBe("Vectors");
    expect(topicText("Physics IA draft - Google Docs", "docs.google.com")).toBe("Physics IA draft");
    expect(topicText("(3) Instagram", "instagram.com")).toBe("");
  });

  it("stems plurals symmetrically without mangling short words", () => {
    expect(stem("derivatives")).toBe("derivative");
    expect(stem("studies")).toBe("study");
    expect(stem("process")).toBe("process");
    expect(stem("analysis")).toBe("analysis");
    expect(stem("gas")).toBe("gas");
  });
});

describe("proposeSmartOrganization — open tabs", () => {
  it("separates clearly distinct topics and names them from the titles", () => {
    const proposal = openTabs([
      item("https://www.physicsclassroom.com/class/vectors/projectile", "Projectile Motion | The Physics Classroom"),
      item("https://www.omnicalculator.com/physics/projectile-motion", "Projectile Motion Calculator"),
      item("https://www.youtube.com/watch?v=aaa", "Projectile motion explained - YouTube"),
      item("https://en.wikipedia.org/wiki/French_Revolution", "French Revolution - Wikipedia"),
      item("https://www.britannica.com/event/French-Revolution", "French Revolution | Causes, Summary & Facts | Britannica"),
      item("https://www.youtube.com/watch?v=bbb", "The French Revolution: crash course - YouTube"),
      item("https://www.commonapp.org/blog/essay-prompts", "Common App essay prompts 2026"),
      item("https://www.collegeessayguy.com/blog/college-essay-examples", "College essay examples that worked"),
    ]);
    expect(titlesByGroup(proposal)).toEqual({
      "Projectile motion": ["Projectile Motion Calculator", "Projectile Motion | The Physics Classroom", "Projectile motion explained - YouTube"],
      "French Revolution": ["French Revolution - Wikipedia", "French Revolution | Causes, Summary & Facts | Britannica", "The French Revolution: crash course - YouTube"],
      Essay: ["College essay examples that worked", "Common App essay prompts 2026"],
    });
    expect(proposal.review).toEqual([]);
    expect(proposal.groups.every((group) => group.destination.kind === "new-subject")).toBe(true);
    expect(proposal.groups[0]!.reason).toMatch(/Titles mention “Projectile”/);
  });

  it("does not group unrelated topics because they share a platform or a page type", () => {
    const proposal = openTabs([
      item("https://www.youtube.com/watch?v=1", "Organic chemistry nomenclature - YouTube"),
      item("https://www.youtube.com/watch?v=2", "lofi hip hop radio - beats to relax/study to - YouTube"),
      item("https://docs.google.com/document/d/1", "Physics past paper notes - Google Docs"),
      item("https://docs.google.com/document/d/2", "Chemistry past paper notes - Google Docs"),
    ]);
    // Chemistry meets chemistry across two platforms; the shared platforms and "past paper notes" join nothing else.
    expect(titlesByGroup(proposal)).toEqual({
      Chemistry: ["Chemistry past paper notes - Google Docs", "Organic chemistry nomenclature - YouTube"],
    });
    expect(reviewTitles(proposal)).toEqual(["Physics past paper notes - Google Docs", "lofi hip hop radio - beats to relax/study to - YouTube"]);
  });

  it("groups a site that is the activity itself, but never a platform that hosts anything", () => {
    const proposal = openTabs([
      item("https://www.instagram.com/p/abc/", "Instagram"),
      item("https://www.instagram.com/explore/", "Instagram"),
      item("https://www.netflix.com/browse", "Netflix"),
      item("https://www.netflix.com/title/1", "Stranger Things | Netflix Official Site"),
      item("https://www.youtube.com/watch?v=9", "Never gonna give you up - YouTube"),
      item("https://en.wikipedia.org/wiki/Mitochondrion", "Mitochondrion - Wikipedia"),
    ]);
    expect(titlesByGroup(proposal)).toEqual({
      Instagram: ["Instagram", "Instagram"],
      Netflix: ["Netflix", "Stranger Things | Netflix Official Site"],
    });
    expect(reviewTitles(proposal)).toEqual(["Mitochondrion - Wikipedia", "Never gonna give you up - YouTube"]);
  });

  it("leaves an ambiguous tab for review instead of forcing it into a group", () => {
    const proposal = openTabs([
      item("https://a.example/derivatives", "Derivatives rules"),
      item("https://b.example/derivative-calculator", "Derivative calculator"),
      item("https://c.example/chain-rule-derivatives", "Chain rule for derivatives"),
      item("https://d.example/random", "Weekend plans"),
    ]);
    expect(titlesByGroup(proposal)).toEqual({ Derivatives: ["Chain rule for derivatives", "Derivative calculator", "Derivatives rules"] });
    expect(reviewTitles(proposal)).toEqual(["Weekend plans"]);
  });

  it("copes with empty titles, unusual domains and pages that share only a site", () => {
    const proposal = openTabs([
      item("https://physics.stackexchange.com/questions/1", ""),
      item("https://xn--bcher-kva.example/", ""),
      item("https://192.168.1.10/admin", ""),
      item("https://mathsgenie.co.uk/a", ""),
      item("https://mathsgenie.co.uk/b", ""),
    ]);
    expect(proposal.groups).toHaveLength(1);
    expect(proposal.groups[0]!.itemIds).toHaveLength(2);
    expect(proposal.groups[0]!.name).toBe("Mathsgenie");
    expect(proposal.review).toHaveLength(3);
  });

  it("leaves pages already saved in Hubble out by default, so confirming never saves a second copy", () => {
    const saved = subject("physics", "Physics", []);
    saved.tabs = [{ id: "t1", url: "https://www.physicsclassroom.com/class/vectors/projectile", normalizedUrl: "x", domain: "physicsclassroom.com", resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1 } }];
    const proposal = openTabs(
      [
        item("https://www.physicsclassroom.com/class/vectors/projectile", "Projectile Motion", { savedIn: { workspaceId: "physics", name: "Physics" } }),
        item("https://a.example/1", "Projectile motion lab"),
        item("https://b.example/2", "Projectile motion formulas"),
      ],
      [saved]
    );
    expect(proposal.excluded).toEqual([{ itemId: proposal.items[0]!.id, reason: "already-saved" }]);
    expect(proposal.groups[0]!.itemIds).toEqual([proposal.items[1]!.id, proposal.items[2]!.id]);
  });

  it("sends a group to the existing project it clearly belongs to", () => {
    const history = subject("history", "History HL", [
      { url: "https://x.example/1", title: "Causes of the French Revolution essay" },
      { url: "https://x.example/2", title: "Napoleon timeline" },
    ]);
    const physics = subject("physics", "Physics", [{ url: "https://y.example/1", title: "Kinematics" }]);
    const proposal = openTabs(
      [
        item("https://en.wikipedia.org/wiki/French_Revolution", "French Revolution - Wikipedia"),
        item("https://www.britannica.com/event/French-Revolution", "French Revolution | Britannica"),
        item("https://a.example/physics-1", "Physics wave equations"),
        item("https://b.example/physics-2", "Physics wave interference"),
      ],
      [history, physics]
    );
    const destinations = Object.fromEntries(proposal.groups.map((group) => [group.name, group.destination]));
    expect(destinations["French Revolution"]).toEqual({ kind: "subject", workspaceId: "history" });
    expect(destinations["Physics wave"]).toEqual({ kind: "subject", workspaceId: "physics" });
  });

  it("names a group the way its titles phrase it, and leaves an identifier's case alone", () => {
    const proposal = openTabs([
      item("https://en.wikipedia.org/wiki/Treaty_of_Versailles", "Treaty of Versailles - Wikipedia"),
      item("https://www.britannica.com/event/Treaty-of-Versailles-1919", "Treaty of Versailles | Definition, Summary, Terms, & Facts | Britannica"),
      item("https://react.dev/reference/react/useEffect", "useEffect – React"),
      item("https://stackoverflow.com/questions/1/x", "reactjs - How to use useEffect cleanup? - Stack Overflow"),
    ]);
    expect(proposal.groups.map((group) => group.name).sort()).toEqual(["Treaty of Versailles", "useEffect"]);
  });

  it("keeps unrelated YouTube videos and generic pages out of groups", () => {
    const proposal = openTabs([
      item("https://www.youtube.com/watch?v=bbbbbbbbbbb", "Taylor Swift - Anti-Hero (Official Music Video) - YouTube"),
      item("https://www.youtube.com/watch?v=ccccccccccc", "I Survived 100 Days in Minecraft Hardcore - YouTube"),
      item("https://www.youtube.com/watch?v=ddddddddddd", "How to cook perfect rice - YouTube"),
      item("https://docs.google.com/document/d/1/edit", "Untitled document - Google Docs"),
      item("https://example.com/", "Home"),
      item("https://classroom.google.com/u/0/h", "Classes"),
    ]);
    expect(proposal.groups).toEqual([]);
    expect(proposal.review).toHaveLength(6);
  });

  it("matches on the word every tab shares, but not on a passing word", () => {
    const english = subject("english", "English Lit", [{ url: "https://notes.example/g", title: "Gatsby themes and symbolism" }]);
    const physics = subject("physics", "Physics", [{ url: "https://notes.example/m", title: "Motion graphs" }]);
    const proposal = openTabs(
      [
        item("https://www.sparknotes.com/lit/gatsby/", "The Great Gatsby: Study Guide | SparkNotes"),
        item("https://www.litcharts.com/lit/the-great-gatsby", "The Great Gatsby Study Guide | LitCharts"),
        item("https://www.youtube.com/watch?v=abcdefghijk", "Gatsby chapter 3 analysis - YouTube"),
        item("https://a.example/shm", "Simple harmonic motion"),
        item("https://b.example/shm2", "Simple harmonic motion lab"),
      ],
      [english, physics]
    );
    const destinations = Object.fromEntries(proposal.groups.map((group) => [group.name, group.destination]));
    expect(destinations["Gatsby"]).toEqual({ kind: "subject", workspaceId: "english" });
    // "Motion" alone is a third of what the group shares: not enough to file it under Physics.
    expect(destinations["Simple harmonic motion"]).toEqual({ kind: "new-subject" });
  });

  it("flags duplicates by Hubble's source identity, never by title alone", () => {
    const proposal = openTabs([
      item("https://www.youtube.com/watch?v=dQw4w9WgXcQ&t=30", "Cell biology - YouTube"),
      item("https://youtu.be/dQw4w9WgXcQ", "Cell biology - YouTube"),
      item("https://example.com/page?utm_source=x", "Same page"),
      item("https://example.com/page", "Same page"),
      item("https://example.com/other", "Same page"),
    ]);
    expect(proposal.duplicates).toEqual([
      { itemIds: [proposal.items[0]!.id, proposal.items[1]!.id], exact: false },
      { itemIds: [proposal.items[2]!.id, proposal.items[3]!.id], exact: true },
    ]);
  });

  it("is deterministic", () => {
    const build = () => {
      counter = 0;
      return openTabs([
        item("https://a.example/1", "Kinematics graphs"),
        item("https://b.example/2", "Kinematics equations"),
        item("https://c.example/3", "Essay outline"),
        item("https://d.example/4", "Essay hooks"),
      ]);
    };
    expect(build()).toEqual(build());
  });

  it("handles a large, messy tab set quickly and accounts for every tab", () => {
    const topics = ["photosynthesis", "trigonometry", "renaissance", "thermodynamics", "macbeth", "genetics", "calculus", "volcanoes"];
    const items: SmartItem[] = [];
    for (let i = 0; i < 300; i += 1) {
      const topic = topics[i % topics.length]!;
      items.push(item(`https://site${i % 37}.example/${topic}/${i}`, i % 5 === 0 ? "" : `${topic} lesson ${i} overview`));
    }
    const started = performance.now();
    const proposal = openTabs(items);
    expect(performance.now() - started).toBeLessThan(5000);
    const placed = proposal.groups.flatMap((group) => group.itemIds).length + proposal.review.length + proposal.excluded.length;
    expect(placed).toBe(300);
    expect(new Set(proposal.groups.map((group) => group.name.toLowerCase())).size).toBe(proposal.groups.length);
    for (const topic of topics) expect(proposal.groups.some((group) => group.name.toLowerCase() === topic)).toBe(true);
  });

  it("returns an empty proposal for no tabs", () => {
    expect(openTabs([])).toMatchObject({ groups: [], review: [], excluded: [], duplicates: [] });
  });
});

describe("proposeSmartOrganization — a project's tabs", () => {
  it("proposes collections for loose tabs and leaves tabs already in a collection alone", () => {
    const workspace = subject("bio", "Biology", [
      { url: "https://a.example/1", title: "Mitosis stages" },
      { url: "https://b.example/2", title: "Mitosis vs meiosis" },
      { url: "https://c.example/3", title: "Enzyme kinetics" },
      { url: "https://d.example/4", title: "Enzyme inhibition" },
      { url: "https://e.example/5", title: "Enzyme lab report" },
    ]);
    const collections = [{ id: "col-1", workspaceId: "bio", name: "Enzymes", tabIds: ["bio-tab-2"], createdAt: 1, updatedAt: 1 }];
    const items = workspace.tabs.map((tab) => ({
      id: tab.id,
      ...describeAddress(tab.url)!,
      title: tab.title ?? "",
      ...(tab.id === "bio-tab-2" ? { inCollection: { collectionId: "col-1", name: "Enzymes" } } : {}),
    }));
    const proposal = proposeSmartOrganization(items, { mode: "subject", workspace, collections });
    expect(proposal.excluded).toEqual([{ itemId: "bio-tab-2", reason: "already-in-collection" }]);
    expect(proposal.groups.map((group) => [group.name, group.itemIds, group.destination])).toEqual([
      ["Mitosis", ["bio-tab-0", "bio-tab-1"], { kind: "new-collection" }],
      ["Enzyme", ["bio-tab-3", "bio-tab-4"], { kind: "collection", collectionId: "col-1" }],
    ]);
  });
});
