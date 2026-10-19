import { describe, expect, it } from "vitest";
import { buildSessionCapture, describeLeftOut, describeSaveFailure } from "./sessions.js";
import { MAX_SESSION_TABS } from "./browser-commands.js";

const SELF = "https://hubble-hq.vercel.app";

function tab(over) {
  return { id: 1, index: 0, url: "https://example.com/", title: "Example", status: "complete", pinned: false, ...over };
}

describe("buildSessionCapture", () => {
  it("keeps the window's web pages in tab-strip order with titles, icons and pins", () => {
    const capture = buildSessionCapture(
      [
        {
          incognito: false,
          tabs: [
            tab({ index: 1, url: "https://b.example/", title: "B" }),
            tab({ index: 0, url: "https://a.example/", title: "A", pinned: true, favIconUrl: "https://a.example/i.png" }),
          ],
        },
      ],
      SELF
    );
    expect(capture.tabs).toEqual([
      { url: "https://a.example/", title: "A", favicon: "https://a.example/i.png", pinned: true },
      { url: "https://b.example/", title: "B" },
    ]);
    expect(capture).toMatchObject({ restricted: 0, privateTabs: 0, tooMany: 0 });
  });

  it("leaves out browser pages and counts them; leaves out Hubble without counting it", () => {
    const capture = buildSessionCapture(
      [
        {
          incognito: false,
          tabs: [
            tab({ url: "chrome://newtab/" }),
            tab({ url: "https://chromewebstore.google.com/x", index: 1 }),
            tab({ url: `${SELF}/`, index: 2 }),
            tab({ url: "file:///C:/notes.txt", index: 3 }),
          ],
        },
      ],
      SELF
    );
    expect(capture.tabs.map((entry) => entry.url)).toEqual(["https://chromewebstore.google.com/x"]);
    expect(capture.restricted).toBe(2);
  });

  it("never saves a private window's tabs", () => {
    const capture = buildSessionCapture([{ incognito: true, tabs: [tab({ url: "https://secret.example/" })] }, { incognito: false, tabs: [tab({})] }], SELF);
    expect(capture.tabs.map((entry) => entry.url)).toEqual(["https://example.com/"]);
    expect(capture.privateTabs).toBe(1);
  });

  it("drops a placeholder title and icon while a tab is still loading", () => {
    const capture = buildSessionCapture([{ tabs: [tab({ status: "loading", title: "Loading…", favIconUrl: "https://old.example/i.png" })] }], SELF);
    expect(capture.tabs).toEqual([{ url: "https://example.com/" }]);
  });

  it("stops at the per-session limit and says how many were left", () => {
    const tabs = Array.from({ length: MAX_SESSION_TABS + 3 }, (_, i) => tab({ index: i, url: `https://example.com/${i}` }));
    const capture = buildSessionCapture([{ tabs }], SELF);
    expect(capture.tabs).toHaveLength(MAX_SESSION_TABS);
    expect(capture.tooMany).toBe(3);
  });
});

describe("popup wording", () => {
  it("says what a save left out, and nothing when it saved everything", () => {
    expect(describeLeftOut({})).toBe("");
    expect(describeLeftOut({ restricted: 1, privateTabs: 2 })).toBe("Not saved: 1 browser page, 2 private tabs.");
  });

  it("never reports a failure as a success", () => {
    for (const error of ["no-hubble-tab", "storage-failed", "project-missing", "empty", undefined]) {
      expect(describeSaveFailure(error)).toMatch(/nothing was saved|no web pages|try again/i);
    }
  });
});
