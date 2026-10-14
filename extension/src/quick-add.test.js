import { describe, expect, it } from "vitest";
import {
  readStoredTarget,
  readProjectList,
  resolveTarget,
  menuTitle,
  menuScope,
  describeAdding,
  isBlankTab,
  describeOutcome,
  describeStatuses,
  statusesSettled,
} from "./quick-add.js";

const HISTORY = { id: "ws-history", name: "History IA" };
const PHYSICS = { id: "ws-physics", name: "Physics EE" };
const PROJECTS = [HISTORY, PHYSICS];

describe("readStoredTarget", () => {
  it("reads the {id, name} form and an older popup's bare id", () => {
    expect(readStoredTarget(HISTORY)).toEqual(HISTORY);
    expect(readStoredTarget("ws-history")).toEqual({ id: "ws-history", name: "" });
  });

  it("refuses anything else", () => {
    for (const raw of [undefined, null, "", 7, {}, { id: "" }, { id: 3 }, { id: "x".repeat(201) }]) {
      expect(readStoredTarget(raw)).toBeUndefined();
    }
  });
});

describe("readProjectList", () => {
  it("keeps ids and names only, and names an unnamed project", () => {
    expect(readProjectList([{ id: "a", name: "", secret: "x" }, { id: 4, name: "bad" }, null])).toEqual([{ id: "a", name: "Untitled project" }]);
    expect(readProjectList("nope")).toEqual([]);
  });
});

describe("resolveTarget", () => {
  it("opening a project in Hubble makes it the target", () => {
    expect(resolveTarget({ stored: PHYSICS, lastFocusId: "ws-physics", focus: { id: "ws-history" }, projects: PROJECTS })).toEqual({ target: HISTORY, lastFocusId: "ws-history" });
  });

  it("a hidden Hubble tab reporting the same project (one the extension opened to deliver) does not override a popup pick", () => {
    expect(resolveTarget({ stored: PHYSICS, lastFocusId: "ws-history", focus: { id: "ws-history" }, projects: PROJECTS, visible: false })).toEqual({ target: PHYSICS, lastFocusId: "ws-history" });
  });

  it("looking at Hubble again makes the project on screen the current one, even after a popup pick", () => {
    expect(resolveTarget({ stored: PHYSICS, lastFocusId: "ws-history", focus: { id: "ws-history" }, projects: PROJECTS, visible: true })).toEqual({ target: HISTORY, lastFocusId: "ws-history" });
  });

  it("picks up a rename of the remembered project", () => {
    const renamed = [{ id: "ws-physics", name: "Physics extended essay" }, HISTORY];
    expect(resolveTarget({ stored: PHYSICS, lastFocusId: "ws-history", focus: { id: "ws-history" }, projects: renamed }).target).toEqual({ id: "ws-physics", name: "Physics extended essay" });
  });

  it("drops a remembered project that no longer exists, falling back to the one on screen", () => {
    expect(resolveTarget({ stored: { id: "ws-deleted", name: "Old" }, lastFocusId: "ws-history", focus: { id: "ws-history" }, projects: PROJECTS }).target).toEqual(HISTORY);
  });

  it("never invents a project the page did not list", () => {
    expect(resolveTarget({ stored: undefined, lastFocusId: undefined, focus: { id: "ws-unknown" }, projects: PROJECTS }).target).toBeUndefined();
  });
});

describe("menuTitle", () => {
  it("names the project the tab will go to", () => {
    expect(menuTitle(HISTORY)).toBe("Add to History IA");
    expect(menuTitle({ id: "x", name: "A".repeat(60) })).toBe(`Add to ${"A".repeat(39)}…`);
    expect(menuTitle({ id: "x", name: "" })).toBe("Add to Hubble project");
    expect(menuTitle(undefined)).toBe("Add to a Hubble project…");
  });
});

describe("menuScope", () => {
  it("a right-clicked tab that is part of a selection adds the whole selection, like Chrome's own tab menu", () => {
    expect(menuScope({ id: 5, windowId: 2, highlighted: true }, "tab")).toEqual({ scope: "selected", windowId: 2 });
  });

  it("a right-clicked tab outside the selection adds just that tab", () => {
    expect(menuScope({ id: 5, windowId: 2, highlighted: false }, "tab")).toEqual({ scope: "tabs", tabIds: [5], windowId: 2 });
  });

  it("a right-click on the page adds that page, whatever else is selected", () => {
    expect(menuScope({ id: 5, windowId: 2, highlighted: true }, "page")).toEqual({ scope: "tabs", tabIds: [5], windowId: 2 });
  });
});

describe("describeOutcome", () => {
  const target = { workspaceId: "ws-history", name: "History IA" };

  it("says it is adding, naming the project", () => {
    expect(describeAdding(target)).toEqual({ tone: "working", title: "Adding to History IA…" });
  });

  it("says where one source went", () => {
    expect(describeOutcome({ ok: true, accepted: 1, target })).toEqual({ tone: "done", title: "Added to History IA", detail: undefined });
  });

  it("counts several, and mentions the ones already there and the Chrome pages skipped", () => {
    expect(describeOutcome({ ok: true, accepted: 2, alreadyInProject: 1, skippedRestricted: 1, target })).toEqual({
      tone: "done",
      title: "Added 2 sources to History IA",
      detail: "1 already there · 1 Chrome page skipped",
    });
  });

  it("calls a duplicate 'already in' the project, not an error", () => {
    expect(describeOutcome({ ok: true, accepted: 0, alreadyInProject: 1, target })).toEqual({
      tone: "same",
      title: "Already in History IA",
      detail: "This source is already in the project.",
    });
    expect(describeOutcome({ ok: true, accepted: 0, alreadyInProject: 3, target }).detail).toBe("These sources are already in the project.");
  });

  it("names the project in every failure, with a reason the person can act on", () => {
    expect(describeOutcome({ ok: false, reason: "no-importable-tabs", target })).toEqual({
      tone: "error",
      title: "Couldn't add to History IA",
      detail: "Chrome's own pages can't be read. Web pages, PDFs and videos can.",
    });
    expect(describeOutcome({ ok: false, reason: "project-missing", target })).toMatchObject({
      title: "Couldn't add to History IA",
      detail: "History IA isn't in Hubble any more. Open the project you want, then try again.",
    });
    expect(describeOutcome({ ok: false, reason: "nothing-imported", target })).toMatchObject({ title: "Couldn't add to History IA", detail: expect.stringMatching(/web address/) });
    expect(describeOutcome({ ok: false, reason: "content-script-missing", target })).toMatchObject({ title: "Couldn't add to History IA", detail: expect.stringMatching(/Reload the Hubble page/) });
  });

  it("says a blank tab has nothing to add, instead of blaming Chrome", () => {
    expect(describeOutcome({ ok: false, reason: "no-importable-tabs", blankOnly: true, target })).toEqual({
      tone: "error",
      title: "Couldn't add to History IA",
      detail: "A blank tab has nothing to add. Open a page in it first.",
    });
    expect(isBlankTab({ url: "about:blank" })).toBe(true);
    expect(isBlankTab({ url: "chrome://newtab/" })).toBe(true);
    expect(isBlankTab({ url: "" })).toBe(true);
    expect(isBlankTab({ url: "chrome://settings/" })).toBe(false);
    expect(isBlankTab({ url: "https://example.com/" })).toBe(false);
  });

  it("without a project, asks for one to be opened", () => {
    expect(describeOutcome({ ok: false, reason: "no-project" })).toEqual({
      tone: "error",
      title: "Open a project in Hubble first",
      detail: "Tabs go to the project you have open in Hubble.",
    });
  });

  it("never offers to drag a tab, or talks about managing tabs", () => {
    const reasons = ["no-project", "project-missing", "no-importable-tabs", "nothing-imported", "already-running", "tab-load-timeout", "x"];
    for (const reason of reasons) expect(JSON.stringify(describeOutcome({ ok: false, reason, target }))).not.toMatch(/drag|manage|organi[sz]e/i);
  });
});

describe("reading status", () => {
  it("uses the project home's words for one source", () => {
    expect(describeStatuses([{ status: "pending" }])).toBe("Reading source…");
    expect(describeStatuses([{ status: "processing", detail: "ignored while reading" }])).toBe("Reading source…");
    expect(describeStatuses([{ status: "ready", detail: "1,840 words" }])).toBe("Ready · 1,840 words");
    expect(describeStatuses([{ status: "partial", detail: "Transcript isn't available" }])).toBe("Saved · Transcript isn't available");
    expect(describeStatuses([{ status: "failed", detail: "The site didn't answer" }])).toBe("Couldn't read · The site didn't answer");
  });

  it("summarises several", () => {
    expect(describeStatuses([{ status: "ready" }, { status: "ready" }, { status: "failed" }, { status: "pending" }])).toBe("2 ready · 1 couldn't be read · 1 being read");
  });

  it("is settled only when every source is ready, saved or failed", () => {
    expect(statusesSettled([{ status: "ready" }, { status: "partial" }, { status: "failed" }])).toBe(true);
    expect(statusesSettled([{ status: "ready" }, { status: "processing" }])).toBe(false);
    expect(statusesSettled([])).toBe(false);
    expect(statusesSettled(undefined)).toBe(false);
  });
});
