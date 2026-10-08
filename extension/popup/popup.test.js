// Integration-style, matching background.test.js's approach: real DOM
// (mirroring popup.html's structure) plus a mocked chrome.* global, with
// popup.js imported fresh per test so its top-level detectTabs() call and
// event-listener wiring run against that test's own mocks.
//
// Focused on the error-reporting path this file added: a failed
// MSG_DUMP_TABS response's `reason` (and, where present, `detail`) must
// reach the popup as distinct, specific copy — not collapse into one
// generic "something went wrong" message that can't be told apart from any
// other failure.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DUMP_RUNNING_STALE_MS } from "../src/config.js";

const POPUP_HTML = readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "popup.html"), "utf8");

/**
 * Mounts the *real* popup.html body rather than a hand-written mirror of it.
 * popup.js resolves every one of its elements by id at module scope and
 * attaches listeners to several of them, so a markup/script mismatch doesn't
 * degrade — it throws on load and the popup renders nothing at all. A
 * hand-maintained copy of the DOM in this file could (and did) drift out of
 * sync with popup.html and hide exactly that class of breakage.
 */
function setPopupDom() {
  const body = POPUP_HTML.slice(POPUP_HTML.indexOf("<body>") + "<body>".length, POPUP_HTML.indexOf("</body>"));
  // Strip the module script tag: these tests import popup.js themselves,
  // per test, against that test's own chrome.* mocks.
  document.body.innerHTML = body.replace(/<script[\s\S]*?<\/script>/g, "");
}

let sessionStore;
// Listeners on the TOP-LEVEL chrome.storage.onChanged — the event that
// actually carries `areaName`.
let globalChangeListeners;
// Listeners on chrome.storage.session.onChanged. Kept separate, and invoked
// with the single argument the real StorageArea event passes, because the
// popup used to subscribe here with a `(changes, areaName)` handler: under a
// mock that helpfully supplied "session" it looked like it worked, while in
// Chrome it filtered out every event and the whole dump-recovery path was
// dead. A test double that lies about an API signature can only ever
// validate the lie.
let areaChangeListeners;

/** Fires a storage change the way Chrome does: on both events, with each one's real signature. */
function fireStorageChange(newValue) {
  const change = { tabdump_dump_state: { newValue } };
  for (const listener of areaChangeListeners) listener(change);
  for (const listener of globalChangeListeners) listener(change, "session");
}

let closed;

beforeEach(() => {
  setPopupDom();
  sessionStore = {};
  globalChangeListeners = [];
  areaChangeListeners = [];
  // In Chrome, popup.js's window.close() dismisses the action popup. In
  // jsdom it tears down the whole window — taking `document` with it and
  // breaking every subsequent test in the file — so it's stubbed and
  // asserted on instead.
  closed = vi.fn();
  window.close = closed;
  globalThis.chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://a.com", title: "A", status: "complete" }]),
    },
    runtime: {
      sendMessage: vi.fn(),
    },
    storage: {
      onChanged: {
        addListener: vi.fn((fn) => globalChangeListeners.push(fn)),
        removeListener: vi.fn((fn) => {
          globalChangeListeners = globalChangeListeners.filter((l) => l !== fn);
        }),
      },
      session: {
        get: vi.fn(async (key) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (items) => Object.assign(sessionStore, items)),
        onChanged: {
          addListener: vi.fn((fn) => areaChangeListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            areaChangeListeners = areaChangeListeners.filter((l) => l !== fn);
          }),
        },
      },
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  document.body.innerHTML = "";
  vi.resetModules();
});

async function loadPopup() {
  await import("./popup.js");
  // Let the module's top-level detectTabs() (tabs.query + the
  // best-effort askHubble round trip) settle before a test
  // drives the UI further.
  await vi.waitFor(() => {
    expect(document.getElementById("state-ready").hidden).toBe(false);
  });
}

function click(id) {
  document.getElementById(id).dispatchEvent(new Event("click", { bubbles: true }));
}

describe("popup dump-failure reporting", () => {
  it("shows a specific message and no detail for no-importable-tabs", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: false, reason: "no-importable-tabs", count: 0 });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("error-message").textContent).toBe("No importable tabs in this window.");
    expect(document.getElementById("error-detail").hidden).toBe(true);
  });

  it("distinguishes tab-open-failed from delivery-failed, each with its own detail", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: false,
      reason: "tab-open-failed",
      count: 1,
      detail: "This browser API function requires a user gesture to run.",
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("error-message").textContent).toBe("Couldn't open or find the Hubble tab.");
    expect(document.getElementById("error-detail").hidden).toBe(false);
    expect(document.getElementById("error-detail").textContent).toBe(
      "This browser API function requires a user gesture to run."
    );
  });

  it("surfaces the underlying delivery error so a wrong/stale tab is diagnosable", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: false,
      reason: "delivery-failed",
      count: 1,
      detail: "Could not establish connection. Receiving end does not exist.",
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("error-message").textContent).toBe(
      "Hubble didn't respond in that tab. Reload the Hubble page and try again."
    );
    expect(document.getElementById("error-detail").textContent).toBe(
      "Could not establish connection. Receiving end does not exist."
    );
  });

  it("reports a distinct message when the background service worker itself is unreachable", async () => {
    chrome.runtime.sendMessage.mockRejectedValue(new Error("Extension context invalidated."));
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("error-message").textContent).toBe(
      "Lost contact with the Hubble extension. Reopen this popup to see how the dump ended."
    );
    expect(document.getElementById("error-detail").textContent).toBe("Extension context invalidated.");
  });

  // Regression: the ack handshake's whole purpose is that a page which never
  // became able to ingest produces a real, distinguishable error instead of
  // a success the user can't reconcile with an empty workspace.
  it("reports a page that never confirmed the import distinctly from one that never answered", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: false,
      status: "error",
      reason: "page-not-ready",
      count: 3,
      detail: 'Hubble page reported "page-not-ready".',
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("error-message").textContent).toBe(
      "Hubble opened but never confirmed the import. Reload the Hubble page and try again."
    );
  });

  it("reports an unreachable Hubble origin distinctly from an unresponsive page", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: false,
      status: "error",
      reason: "tab-load-timeout",
      count: 3,
      detail: "https://tabsdump.vercel.app did not finish loading within 8000ms.",
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("error-message").textContent).toBe(
      "Hubble didn't finish loading. Check your connection and try again."
    );
  });

  it("never shows a zero-tab success — a page that took nothing is an error", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: false,
      status: "error",
      reason: "nothing-imported",
      count: 5,
      accepted: 0,
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });

    expect(document.getElementById("state-success").hidden).toBe(true);
    expect(document.getElementById("error-message").textContent).toBe(
      "Hubble received the tabs but couldn't import any of them."
    );
  });

  it("surfaces a dump the previous service worker was interrupted mid-way through", async () => {
    sessionStore.tabdump_dump_state = {
      status: "error",
      ok: false,
      reason: "interrupted",
      startedAt: Date.now() - 1000,
      finishedAt: Date.now(),
    };
    await import("./popup.js");

    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });
    expect(document.getElementById("error-message").textContent).toBe(
      "The previous dump was interrupted before it finished. Please try again."
    );
  });
});

// Regression: the dump used to end with background.js activating the Hubble
// tab and focusing its window. Chrome closes an open action popup the moment
// the foreground tab changes, so that focus routinely destroyed the popup
// before it could paint the result it had just been handed — the user saw
// "Dumping tabs…", then nothing. Focus now belongs to the popup, after it has
// rendered.
describe("window targeting", () => {
  it("names the window it previewed, so the background never has to guess which one to dump", async () => {
    chrome.tabs.query.mockResolvedValue([
      { id: 1, windowId: 4, url: "https://a.com", title: "A", status: "complete" },
      { id: 2, windowId: 4, url: "https://b.com", title: "B", status: "complete" },
    ]);
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true, status: "done", count: 2, accepted: 2 });
    await loadPopup();

    click("dump-button");

    await vi.waitFor(() => {
      const dumpCall = chrome.runtime.sendMessage.mock.calls.find(([msg]) => msg.type === "DUMP_TABS");
      expect(dumpCall?.[0].payload.windowId).toBe(4);
    });
  });
});

describe("focus handoff", () => {
  it("renders the result first, and only then asks the background to focus the Hubble tab", async () => {
    vi.useFakeTimers();
    try {
      chrome.runtime.sendMessage.mockResolvedValue({
        ok: true,
        status: "done",
        count: 2,
        accepted: 2,
        focusTabId: 99,
        focusWindowId: 10,
      });
      await import("./popup.js");
      await vi.waitFor(() => expect(document.getElementById("state-ready").hidden).toBe(false), { timeout: 100 });

      click("dump-button");
      await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false), { timeout: 100 });

      // Rendered, but not yet dismissed: no focus request has gone out.
      expect(chrome.runtime.sendMessage).not.toHaveBeenCalledWith(
        expect.objectContaining({ type: "TABDUMP_FOCUS" })
      );

      await vi.advanceTimersByTimeAsync(1000);
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "TABDUMP_FOCUS",
        payload: { tabId: 99, windowId: 10 },
      });
      await vi.waitFor(() => expect(closed).toHaveBeenCalled(), { timeout: 100 });
    } finally {
      vi.useRealTimers();
    }
  });

  it("offers an explicit way to reach the workspace, using the tab the dump actually landed in", async () => {
    sessionStore.tabdump_dump_state = {
      status: "done",
      ok: true,
      count: 4,
      accepted: 4,
      focusTabId: 77,
      focusWindowId: 3,
      finishedAt: Date.now(),
    };
    await import("./popup.js");
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));

    click("open-button");
    await vi.waitFor(() => {
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "TABDUMP_FOCUS",
        payload: { tabId: 77, windowId: 3 },
      });
    });
  });
});

describe("honest success reporting", () => {
  it("reports the count the page accepted, not the count that was sent", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: true, status: "partial", count: 10, accepted: 7 });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));

    expect(document.getElementById("success-count").textContent).toBe("7");
    expect(document.getElementById("success-detail").hidden).toBe(false);
    expect(document.getElementById("success-detail").textContent).toContain("3 couldn't be read as a link");
  });

  it("says how many browser pages Chrome wouldn't let it read, rather than quietly omitting them", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: true,
      status: "done",
      count: 4,
      accepted: 4,
      skippedRestricted: 2,
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));

    expect(document.getElementById("success-count").textContent).toBe("4");
    expect(document.getElementById("success-detail").textContent).toContain("2 browser pages skipped");
  });

  it("shows no extra detail line for a clean, complete dump", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({
      ok: true,
      status: "done",
      count: 4,
      accepted: 4,
      skippedRestricted: 0,
      skippedAlreadyImported: 0,
    });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));

    expect(document.getElementById("success-detail").hidden).toBe(true);
  });
});

// Regression: chrome.storage.session.onChanged hands its listener only
// `changes`. The popup used to subscribe there with a `(changes, areaName)`
// handler and drop everything, so no popup ever saw a dump finish — the
// recovery path that exists precisely for "the popup closed mid-dump"
// silently did nothing in every real browser.
describe("storage subscription", () => {
  it("subscribes to the storage event that actually carries an area name", async () => {
    sessionStore.tabdump_dump_state = { status: "running", phase: "delivering", startedAt: Date.now() };
    await import("./popup.js");
    await vi.waitFor(() => expect(document.getElementById("state-dumping").hidden).toBe(false));

    expect(chrome.storage.onChanged.addListener).toHaveBeenCalled();

    // Fire ONLY the StorageArea event, with its real single-argument
    // signature. A popup that leaned on it would be updated by this; the one
    // that correctly ignores it must still be waiting.
    for (const listener of areaChangeListeners) {
      listener({ tabdump_dump_state: { newValue: { status: "done", ok: true, count: 3, finishedAt: Date.now() } } });
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.getElementById("state-dumping").hidden).toBe(false);

    // The top-level event is the one that must drive it.
    for (const listener of globalChangeListeners) {
      listener(
        { tabdump_dump_state: { newValue: { status: "done", ok: true, count: 3, finishedAt: Date.now() } } },
        "session"
      );
    }
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));
    expect(document.getElementById("success-count").textContent).toBe("3");
  });

  it("ignores changes to other storage areas", async () => {
    sessionStore.tabdump_dump_state = { status: "running", phase: "delivering", startedAt: Date.now() };
    await import("./popup.js");
    await vi.waitFor(() => expect(document.getElementById("state-dumping").hidden).toBe(false));

    for (const listener of globalChangeListeners) {
      listener(
        { tabdump_dump_state: { newValue: { status: "done", ok: true, count: 3, finishedAt: Date.now() } } },
        "local"
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(document.getElementById("state-dumping").hidden).toBe(false);
  });
});

describe("in-flight progress", () => {
  it("reflects the phase the dump has reached instead of a frozen 'Dumping tabs…'", async () => {
    chrome.runtime.sendMessage.mockReturnValue(new Promise(() => {}));
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => expect(document.getElementById("state-dumping").hidden).toBe(false));
    expect(document.getElementById("dumping-message").textContent).toBe("Reading your open tabs…");

    fireStorageChange({ status: "running", phase: "delivering", startedAt: Date.now() });
    await vi.waitFor(() => {
      expect(document.getElementById("dumping-message").textContent).toBe("Handing your tabs to Hubble…");
    });

    fireStorageChange({ status: "running", phase: "retrying-in-new-tab", startedAt: Date.now() });
    await vi.waitFor(() => {
      expect(document.getElementById("dumping-message").textContent).toContain("retrying in a new one");
    });
  });
});

// Covers the case a plain "popup closed before the response arrived" test
// can't: a *second*, freshly reopened popup instance recovering the outcome
// of a dump that a now-gone earlier popup started — e.g. because the earlier
// popup lost focus (and Chrome closed it) while background.js's dumpTabs()
// was still waiting on a newly created tab. See background.js's
// setDumpState/DUMP_STATE_KEY.
describe("recovering dump state on a fresh popup open", () => {
  async function importPopup() {
    await import("./popup.js");
  }

  it("shows the dumping state and waits, instead of re-detecting tabs, when a dump is still running", async () => {
    sessionStore.tabdump_dump_state = { status: "running", startedAt: Date.now() };
    await importPopup();

    await vi.waitFor(() => {
      expect(document.getElementById("state-dumping").hidden).toBe(false);
    });
    // Must not have started a redundant tab-detection pass while a dump it
    // didn't start is still in flight.
    expect(chrome.tabs.query).not.toHaveBeenCalled();

    fireStorageChange({ status: "done", ok: true, count: 7, startedAt: Date.now(), finishedAt: Date.now() });

    await vi.waitFor(() => {
      expect(document.getElementById("state-success").hidden).toBe(false);
    });
    expect(document.getElementById("success-count").textContent).toBe("7");
  });

  it("surfaces the error from a dump that finished with a failure while no popup was open to see it", async () => {
    sessionStore.tabdump_dump_state = { status: "running", startedAt: Date.now() };
    await importPopup();

    await vi.waitFor(() => {
      expect(document.getElementById("state-dumping").hidden).toBe(false);
    });

    fireStorageChange({
      status: "error",
      ok: false,
      reason: "delivery-failed",
      count: 1,
      detail: "Receiving end does not exist.",
      startedAt: Date.now(),
      finishedAt: Date.now(),
    });

    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });
    expect(document.getElementById("error-message").textContent).toBe(
      "Hubble didn't respond in that tab. Reload the Hubble page and try again."
    );
  });

  it("treats a stale running record (service worker likely evicted mid-dump) as abandoned rather than waiting forever", async () => {
    sessionStore.tabdump_dump_state = { status: "running", startedAt: Date.now() - (DUMP_RUNNING_STALE_MS + 60_000) };
    await importPopup();

    await vi.waitFor(() => {
      expect(document.getElementById("state-error").hidden).toBe(false);
    });
    expect(document.getElementById("error-message").textContent).toBe(
      "The previous dump didn't finish. Please try again."
    );
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it("shows a just-finished successful dump's result instead of silently resetting to the ready state", async () => {
    sessionStore.tabdump_dump_state = { status: "done", ok: true, count: 4, finishedAt: Date.now() };
    await importPopup();

    await vi.waitFor(() => {
      expect(document.getElementById("state-success").hidden).toBe(false);
    });
    expect(document.getElementById("success-count").textContent).toBe("4");
    expect(chrome.tabs.query).not.toHaveBeenCalled();
  });

  it("ignores a stale finished record and proceeds with normal tab detection", async () => {
    sessionStore.tabdump_dump_state = { status: "done", ok: true, count: 4, finishedAt: Date.now() - 60_000 };
    await loadPopup();

    expect(document.getElementById("state-ready").hidden).toBe(false);
  });

  it("proceeds with normal tab detection when no prior dump record exists", async () => {
    await loadPopup();
    expect(document.getElementById("state-ready").hidden).toBe(false);
  });

  it("stops waiting and offers a retry if a running dump never reports back — e.g. its service worker was evicted or crashed", async () => {
    vi.useFakeTimers();
    try {
      sessionStore.tabdump_dump_state = { status: "running", startedAt: Date.now() };
      await import("./popup.js");

      await vi.waitFor(
        () => expect(document.getElementById("state-dumping").hidden).toBe(false),
        { timeout: 50 }
      );

      // No storage.onChanged event ever arrives (the dump's owner is gone).
      // Advance well past DUMP_RUNNING_STALE_MS — the popup must not
      // wait forever the way the original bug's "Dumping tabs…" did.
      await vi.advanceTimersByTimeAsync(DUMP_RUNNING_STALE_MS + 5_000);

      expect(document.getElementById("state-error").hidden).toBe(false);
      expect(document.getElementById("error-message").textContent).toBe(
        "The previous dump didn't finish. Please try again."
      );
    } finally {
      vi.useRealTimers();
    }
  });

  it("still shows the result when the dump finishes in the gap between reading storage and attaching the change listener", async () => {
    sessionStore.tabdump_dump_state = { status: "running", startedAt: Date.now() };
    // As soon as anything reads storage after this popup's own initial
    // read (i.e. watchForDumpCompletion's post-addListener double-check),
    // the dump has already finished — simulating a completion that landed
    // in the narrow window before the change listener was registered, so
    // onChanged itself would never fire for it.
    let getCalls = 0;
    chrome.storage.session.get.mockImplementation(async (key) => {
      getCalls += 1;
      if (getCalls >= 2) {
        sessionStore.tabdump_dump_state = { status: "done", ok: true, count: 9, finishedAt: Date.now() };
      }
      return { [key]: sessionStore[key] };
    });

    await import("./popup.js");

    await vi.waitFor(() => {
      expect(document.getElementById("state-success").hidden).toBe(false);
    });
    expect(document.getElementById("success-count").textContent).toBe("9");
  });
});

describe("double-click / re-entrant dump protection", () => {
  it("sends only one MSG_DUMP_TABS request when the dump button is clicked twice in quick succession", async () => {
    let resolveResponse;
    chrome.runtime.sendMessage.mockReturnValue(new Promise((resolve) => (resolveResponse = resolve)));
    await loadPopup();

    const button = document.getElementById("dump-button");
    button.dispatchEvent(new Event("click", { bubbles: true }));
    button.dispatchEvent(new Event("click", { bubbles: true }));

    // loadPopup()'s own detectTabs() already sent one MSG_CHECK_IMPORTED —
    // this only asserts on the dump request itself, exactly one of which
    // must have been sent despite the two clicks.
    const dumpCalls = chrome.runtime.sendMessage.mock.calls.filter(([msg]) => msg.type === "DUMP_TABS");
    expect(dumpCalls).toHaveLength(1);

    resolveResponse({ ok: true, count: 1 });
    await vi.waitFor(() => {
      expect(document.getElementById("state-success").hidden).toBe(false);
    });
  });

  it("attaches to the real dump's outcome instead of dead-ending when background.js reports already-running", async () => {
    chrome.runtime.sendMessage.mockResolvedValue({ ok: false, reason: "already-running", count: 0 });
    await loadPopup();

    click("dump-button");
    await vi.waitFor(() => {
      expect(document.getElementById("state-dumping").hidden).toBe(false);
    });
    // Must not have collapsed into a dead-end error screen while the real
    // dump this popup didn't start is still going.
    expect(document.getElementById("state-error").hidden).toBe(true);

    fireStorageChange({ status: "done", ok: true, count: 3, finishedAt: Date.now() });
    await vi.waitFor(() => {
      expect(document.getElementById("state-success").hidden).toBe(false);
    });
    expect(document.getElementById("success-count").textContent).toBe("3");
  });
});

// The popup and quick add (the tab's right-click menu, the shortcut) share one
// remembered project: preselected here, written as { id, name } so the menu
// can name it, and still read from an older popup's bare id.
describe("the remembered project", () => {
  const PROJECTS = [
    { id: "ws-history", name: "History IA", sources: 3 },
    { id: "ws-physics", name: "Physics EE", sources: 0 },
  ];

  const ONE_TAB = [{ id: 1, windowId: 5, url: "https://a.com", title: "A", status: "complete", active: true, highlighted: true }];

  function withProjects(stored, { tabs = ONE_TAB, hubbleOpen = true } = {}) {
    const local = { hubble_target_project: stored };
    chrome.tabs.query.mockResolvedValue(tabs);
    chrome.runtime.sendMessage.mockImplementation(async (message) => {
      if (message?.type === "TABDUMP_CHECK_IMPORTED") return hubbleOpen ? { ok: true, existingUrls: [], projects: PROJECTS } : { ok: false, reason: "no-tabdump-tab" };
      if (message?.type === "TABDUMP_ADD_TO_PROJECT") return { ok: true, status: "done", count: 1, accepted: 1, target: message.payload.target };
      return undefined;
    });
    chrome.storage.local = {
      get: vi.fn(async (key) => ({ [key]: local[key] })),
      set: vi.fn(async (items) => Object.assign(local, items)),
    };
    chrome.commands = { getAll: vi.fn(async () => [{ name: "add-to-project", shortcut: "Alt+Shift+H" }]) };
    return local;
  }

  async function projectSectionShown() {
    await loadPopup();
    await vi.waitFor(() => expect(document.getElementById("project-section").hidden).toBe(false));
  }

  const heading = () => document.getElementById("project-heading").textContent;

  it("leads with the project quick add will use: Add to <project>, and teaches the right-click", async () => {
    withProjects({ id: "ws-history", name: "History IA" });
    await projectSectionShown();
    expect(heading()).toBe("Add to History IA");
    expect(document.getElementById("project-select").value).toBe("ws-history");
    expect(document.getElementById("add-current-button").textContent).toBe("Add this tab");
    expect(document.getElementById("add-current-button").disabled).toBe(false);
    await vi.waitFor(() => expect(document.getElementById("quick-add-hint").hidden).toBe(false));
    expect(document.getElementById("quick-add-hint").textContent).toBe("Right-click any tab to add it directly. Alt + Shift + H");
  });

  it("says nothing about a shortcut the person cleared", async () => {
    withProjects({ id: "ws-history", name: "History IA" });
    chrome.commands = { getAll: vi.fn(async () => [{ name: "add-to-project", shortcut: "" }]) };
    await projectSectionShown();
    await vi.waitFor(() => expect(document.getElementById("quick-add-hint").hidden).toBe(false));
    expect(document.getElementById("quick-add-hint").textContent).toBe("Right-click any tab to add it directly.");
  });

  it("follows the project Hubble has open, whichever it is", async () => {
    withProjects({ id: "ws-physics", name: "Physics EE" });
    await projectSectionShown();
    expect(heading()).toBe("Add to Physics EE");
  });

  it("asks for a project when none is open in Hubble yet, and offers nothing to add until there is one", async () => {
    withProjects(undefined);
    await projectSectionShown();
    expect(heading()).toBe("Choose a project to add to");
    expect(document.getElementById("add-current-button").disabled).toBe(true);
    expect(document.getElementById("quick-add-hint").hidden).toBe(true);
  });

  it("still names the project when no Hubble tab is open to ask (Hubble opens to take the tab)", async () => {
    withProjects({ id: "ws-history", name: "History IA" }, { hubbleOpen: false });
    await projectSectionShown();
    expect(heading()).toBe("Add to History IA");
    expect(document.getElementById("project-unavailable").hidden).toBe(true);
  });

  it("with no Hubble tab and no project yet, says to open one in Hubble", async () => {
    withProjects(undefined, { hubbleOpen: false });
    await loadPopup();
    await vi.waitFor(() => expect(document.getElementById("project-unavailable").hidden).toBe(false));
    expect(document.getElementById("project-section").hidden).toBe(true);
    expect(document.getElementById("project-unavailable").textContent).toBe("Open a project in Hubble to add this tab to it.");
  });

  it("Add this tab sends this tab to the project", async () => {
    withProjects({ id: "ws-history", name: "History IA" });
    await projectSectionShown();
    document.getElementById("add-current-button").click();
    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "TABDUMP_ADD_TO_PROJECT",
        payload: { windowId: 5, scope: "current", target: { workspaceId: "ws-history", name: "History IA" } },
      })
    );
    await vi.waitFor(() => expect(document.getElementById("success-project").textContent).toBe("Added 1 source to History IA"));
  });

  it("Add selected tabs sends the selection to the project", async () => {
    const tabs = [
      { id: 1, windowId: 5, url: "https://a.com", title: "A", status: "complete", active: true, highlighted: true },
      { id: 2, windowId: 5, url: "https://b.com", title: "B", status: "complete", active: false, highlighted: true },
      { id: 3, windowId: 5, url: "https://c.com", title: "C", status: "complete", active: false, highlighted: false },
    ];
    withProjects({ id: "ws-history", name: "History IA" }, { tabs });
    await projectSectionShown();
    const button = document.getElementById("add-selected-button");
    expect(button.hidden).toBe(false);
    expect(button.textContent).toBe("Add selected tabs");
    button.click();
    await vi.waitFor(() =>
      expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({
        type: "TABDUMP_ADD_TO_PROJECT",
        payload: { windowId: 5, scope: "selected", target: { workspaceId: "ws-history", name: "History IA" } },
      })
    );
  });

  it("keeps the plain dump, which never names a project", async () => {
    withProjects({ id: "ws-history", name: "History IA" });
    await projectSectionShown();
    document.getElementById("dump-button").click();
    await vi.waitFor(() => expect(chrome.runtime.sendMessage).toHaveBeenCalledWith(expect.objectContaining({ type: "DUMP_TABS" })));
    const dump = chrome.runtime.sendMessage.mock.calls.find(([message]) => message.type === "DUMP_TABS")[0];
    expect(dump.payload.target).toBeUndefined();
  });

  it("never talks about dragging or managing tabs", async () => {
    withProjects({ id: "ws-history", name: "History IA" });
    await projectSectionShown();
    await vi.waitFor(() => expect(document.getElementById("quick-add-hint").hidden).toBe(false));
    expect(document.body.textContent).not.toMatch(/drag|tab manager|manage your tabs|organi[sz]e (your )?tabs/i);
  });

  it("still reads an older popup's bare id", async () => {
    withProjects("ws-physics");
    await projectSectionShown();
    expect(document.getElementById("project-select").value).toBe("ws-physics");
  });

  it("remembers a new choice with its name, so the tab menu can say where tabs go", async () => {
    const local = withProjects(undefined);
    await projectSectionShown();
    const select = document.getElementById("project-select");
    select.value = "ws-physics";
    select.dispatchEvent(new Event("change", { bubbles: true }));
    await vi.waitFor(() => expect(local.hubble_target_project).toEqual({ id: "ws-physics", name: "Physics EE" }));
  });
});

describe("after a quick add", () => {
  it("opens normally instead of replaying a result its own toast already showed", async () => {
    sessionStore.tabdump_dump_state = { status: "done", ok: true, accepted: 1, count: 1, via: "quick-add", target: { workspaceId: "ws", name: "History IA" }, startedAt: Date.now(), finishedAt: Date.now(), focusTabId: 9 };
    await loadPopup();
    expect(document.getElementById("state-success").hidden).toBe(true);
    expect(closed).not.toHaveBeenCalled();
  });

  it("still replays a fresh result from the popup's own run", async () => {
    sessionStore.tabdump_dump_state = { status: "done", ok: true, accepted: 1, count: 1, target: { workspaceId: "ws", name: "History IA" }, startedAt: Date.now(), finishedAt: Date.now() };
    await import("./popup.js");
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));
    expect(document.getElementById("success-project").textContent).toBe("Added 1 source to History IA");
  });
});

describe("adding selected tabs to a project", () => {
  it("does not count a tab already in the project as one that couldn't be read", async () => {
    sessionStore.tabdump_dump_state = { status: "done", ok: true, count: 3, accepted: 2, alreadyInProject: 1, target: { workspaceId: "ws", name: "History IA" }, startedAt: Date.now(), finishedAt: Date.now() };
    await import("./popup.js");
    await vi.waitFor(() => expect(document.getElementById("state-success").hidden).toBe(false));
    expect(document.getElementById("success-project").textContent).toBe("Added 2 sources to History IA");
    expect(document.getElementById("success-detail").textContent).toBe("1 already in the project");
  });
});
