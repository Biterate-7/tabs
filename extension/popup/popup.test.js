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

function setPopupDom() {
  document.body.innerHTML = `
    <div id="state-loading"></div>
    <div id="state-ready">
      <span id="tab-count"></span>
      <p id="import-status"></p>
      <ul id="tab-preview"></ul>
      <button id="dump-button"></button>
    </div>
    <div id="state-dumping"></div>
    <div id="state-success"><span id="success-count"></span></div>
    <div id="state-error">
      <p id="error-message"></p>
      <p id="error-detail"></p>
      <button id="retry-button"></button>
    </div>
  `;
}

let sessionStore;
let changeListeners;

function fireStorageChange(newValue) {
  const change = { tabdump_dump_state: { newValue } };
  for (const listener of changeListeners) listener(change, "session");
}

beforeEach(() => {
  setPopupDom();
  sessionStore = {};
  changeListeners = [];
  globalThis.chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://a.com", title: "A", status: "complete" }]),
    },
    runtime: {
      sendMessage: vi.fn(),
    },
    storage: {
      session: {
        get: vi.fn(async (key) => ({ [key]: sessionStore[key] })),
        set: vi.fn(async (items) => Object.assign(sessionStore, items)),
        onChanged: {
          addListener: vi.fn((fn) => changeListeners.push(fn)),
          removeListener: vi.fn((fn) => {
            changeListeners = changeListeners.filter((l) => l !== fn);
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
  // best-effort checkAlreadyImported round trip) settle before a test
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

    expect(document.getElementById("error-message").textContent).toBe("Couldn't open or find the TabDump tab.");
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
      "TabDump didn't respond in that tab. Reload the TabDump page and try again."
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
      "Couldn't reach the TabDump extension's background service."
    );
    expect(document.getElementById("error-detail").textContent).toBe("Extension context invalidated.");
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
      "TabDump didn't respond in that tab. Reload the TabDump page and try again."
    );
  });

  it("treats a stale running record (service worker likely evicted mid-dump) as abandoned rather than waiting forever", async () => {
    sessionStore.tabdump_dump_state = { status: "running", startedAt: Date.now() - 60_000 };
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
      // Advance well past DUMP_RUNNING_STALE_MS (20s) — the popup must not
      // wait forever the way the original bug's "Dumping tabs…" did.
      await vi.advanceTimersByTimeAsync(25_000);

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
