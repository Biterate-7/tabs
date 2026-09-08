// The content script is where the cross-machine dump failure was actually
// fixable: it is the only component that exists in the page's document AND
// can hold a message channel open back to the service worker, so it is where
// "a payload arrived before the app could take it" has to be absorbed.
//
// Exercised against jsdom's real window/postMessage rather than a mock, with
// only chrome.* stubbed — postMessage's asynchronous, task-queued delivery is
// central to every ordering these tests cover, and faking it would fake away
// the bug.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as CONFIG from "../src/config.js";
import { IMPORT_ACK_TIMEOUT_MS } from "../src/config.js";

const MESSAGE_SOURCE = "tabdump-extension";
const MSG_TABDUMP_IMPORT = "TABDUMP_IMPORT";
const MSG_TABDUMP_IMPORT_ACK = "TABDUMP_IMPORT_ACK";
const MSG_TABDUMP_PAGE_READY = "TABDUMP_PAGE_READY";

let onMessageListeners;

beforeEach(() => {
  onMessageListeners = [];
  // Each test is a fresh page. The content script marks its isolated world
  // once so that a chrome.scripting re-injection into a tab that already has
  // a copy registers nothing (see `alreadyRegistered` in content-script.js) —
  // but jsdom reuses one window across this whole file, so without clearing
  // the mark every test after the first would load an intentionally inert
  // copy. Deleting it here models a new tab, not a second injection; the
  // second-injection behavior is asserted deliberately further down.
  delete window.__tabdumpBridgeRegistered;
  globalThis.chrome = {
    runtime: {
      onMessage: { addListener: vi.fn((fn) => onMessageListeners.push(fn)) },
      sendMessage: vi.fn().mockResolvedValue(undefined),
    },
  };
});

afterEach(() => {
  delete globalThis.chrome;
  vi.resetModules();
  vi.useRealTimers();
});

async function loadContentScript() {
  await import("./content-script.js");
}

/** Delivers a background→content-script TABDUMP_IMPORT; resolves with the eventual response. */
function deliverImport(importId, tabs) {
  return new Promise((resolve) => {
    let answered = false;
    for (const listener of onMessageListeners) {
      const keepOpen = listener(
        { type: MSG_TABDUMP_IMPORT, importId, payload: { tabs } },
        {},
        (response) => {
          answered = true;
          resolve(response);
        }
      );
      // The import listener must keep the channel open — answering
      // synchronously is precisely the false "delivered" this replaced.
      if (keepOpen === true) return;
    }
    if (!answered) resolve(undefined);
  });
}

/** Waits for the next TABDUMP_IMPORT the content script posts into the page. */
function nextImportPostedToPage() {
  return new Promise((resolve) => {
    function onMessage(event) {
      const data = event.data;
      if (data?.source === MESSAGE_SOURCE && data.type === MSG_TABDUMP_IMPORT) {
        window.removeEventListener("message", onMessage);
        resolve(data.payload);
      }
    }
    window.addEventListener("message", onMessage);
  });
}

function pagePosts(type, payload) {
  window.postMessage({ source: MESSAGE_SOURCE, type, payload }, window.location.origin);
}

const TABS = [{ url: "https://a.example" }, { url: "https://b.example" }];

describe("import handshake", () => {
  it("holds the payload open until the page acks, then reports how many were accepted", async () => {
    await loadContentScript();

    const posted = nextImportPostedToPage();
    const responsePromise = deliverImport("imp-1", TABS);

    const payload = await posted;
    expect(payload.tabs).toEqual(TABS);
    expect(payload.importId).toBe("imp-1");

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-1", accepted: 2 });

    expect(await responsePromise).toEqual({ ok: true, accepted: 2 });
  });

  // THE regression this whole change exists for. The extension delivers the
  // moment Chrome reports the tab `complete`; the React app's `message`
  // listener demonstrably attaches after the load event, not before
  // (measured at 1–105ms later on a production build over localhost). The
  // first post therefore lands in a document with nothing listening — and
  // must not be lost.
  it("re-delivers a payload that arrived before the page was listening, once the page announces it is ready", async () => {
    await loadContentScript();

    // Nothing is listening for TABDUMP_IMPORT yet — exactly the state a
    // still-hydrating React app is in.
    const responsePromise = deliverImport("imp-2", TABS);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // The app finishes hydrating: it attaches its listener and announces
    // readiness in the same effect.
    const redelivered = nextImportPostedToPage();
    pagePosts(MSG_TABDUMP_PAGE_READY, {});

    const payload = await redelivered;
    expect(payload.tabs).toEqual(TABS);
    expect(payload.importId).toBe("imp-2");

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-2", accepted: 2 });
    expect(await responsePromise).toEqual({ ok: true, accepted: 2 });
  });

  it("ignores an ack for a different import than the one in flight", async () => {
    await loadContentScript();

    const responsePromise = deliverImport("imp-3", TABS);
    await nextImportPostedToPage();

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "some-other-import", accepted: 99 });
    await new Promise((resolve) => setTimeout(resolve, 5));

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-3", accepted: 2 });
    expect(await responsePromise).toEqual({ ok: true, accepted: 2 });
  });

  it("ignores an ack posted from another origin", async () => {
    await loadContentScript();

    const responsePromise = deliverImport("imp-4", TABS);
    await nextImportPostedToPage();

    window.dispatchEvent(
      new MessageEvent("message", {
        data: { source: MESSAGE_SOURCE, type: MSG_TABDUMP_IMPORT_ACK, payload: { importId: "imp-4", accepted: 7 } },
        origin: "https://evil.example",
        source: window,
      })
    );
    await new Promise((resolve) => setTimeout(resolve, 5));

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-4", accepted: 2 });
    expect(await responsePromise).toEqual({ ok: true, accepted: 2 });
  });

  it("reports page-not-ready — never silence, never success — when the page never becomes ready", async () => {
    vi.useFakeTimers();
    await loadContentScript();

    const responsePromise = deliverImport("imp-5", TABS);
    await vi.advanceTimersByTimeAsync(IMPORT_ACK_TIMEOUT_MS + 100);

    expect(await responsePromise).toEqual({ ok: false, reason: "page-not-ready" });
  });

  it("distinguishes a page that was ready but never acked from one that never became ready at all", async () => {
    await loadContentScript();

    // Let the readiness announcement actually be delivered before switching
    // to fake timers for the ack deadline.
    pagePosts(MSG_TABDUMP_PAGE_READY, {});
    await new Promise((resolve) => setTimeout(resolve, 5));

    vi.useFakeTimers();
    const responsePromise = deliverImport("imp-6", TABS);
    await vi.advanceTimersByTimeAsync(IMPORT_ACK_TIMEOUT_MS + 100);

    expect(await responsePromise).toEqual({ ok: false, reason: "no-ack" });
  });

  it("answers a superseded import rather than leaving the background waiting on a dead channel", async () => {
    await loadContentScript();

    const firstResponse = deliverImport("imp-7", TABS);
    await nextImportPostedToPage();

    const secondResponse = deliverImport("imp-8", TABS);
    expect(await firstResponse).toEqual({ ok: false, reason: "superseded" });

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-8", accepted: 2 });
    expect(await secondResponse).toEqual({ ok: true, accepted: 2 });
  });

  it("reports an accepted count of zero honestly instead of rounding it up to success", async () => {
    await loadContentScript();

    const responsePromise = deliverImport("imp-9", TABS);
    await nextImportPostedToPage();
    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-9", accepted: 0 });

    expect(await responsePromise).toEqual({ ok: true, accepted: 0 });
  });

  it("does not blow up when the background's message port has already gone away", async () => {
    vi.useFakeTimers();
    await loadContentScript();

    const deadPort = vi.fn(() => {
      throw new Error("Attempting to use a disconnected port object");
    });
    for (const listener of onMessageListeners) {
      const keepOpen = listener({ type: MSG_TABDUMP_IMPORT, importId: "imp-10", payload: { tabs: TABS } }, {}, deadPort);
      if (keepOpen === true) break;
    }

    // The ack deadline firing against a dead port must not produce an
    // unhandled rejection or stop the timer callback from completing.
    await vi.advanceTimersByTimeAsync(IMPORT_ACK_TIMEOUT_MS + 100);
    expect(deadPort).toHaveBeenCalledTimes(1);
  });
});

/**
 * The handshake's message names exist in four separate copies, by design:
 * extension/src/config.js (background + popup), content-script.js (which
 * can't import, because a manifest content script is a classic script),
 * src/lib/browser/protocol.ts (the web app), and the timeout budget shared
 * between the first two.
 *
 * A typo in any one copy doesn't produce an error anywhere — it produces a
 * message nobody answers, i.e. exactly the silent, cross-boundary failure
 * this whole change set exists to eliminate. So the duplication is pinned
 * here rather than trusted to a comment asking people to keep it in sync.
 */
describe("duplicated protocol constants stay in sync", () => {
  const here = path.dirname(fileURLToPath(import.meta.url));
  const contentScript = readFileSync(path.join(here, "content-script.js"), "utf8");
  const webProtocol = readFileSync(path.join(here, "..", "..", "src", "lib", "browser", "protocol.ts"), "utf8");

  const SHARED = [
    ["MESSAGE_SOURCE", CONFIG.MESSAGE_SOURCE],
    ["MSG_TABDUMP_IMPORT", CONFIG.MSG_TABDUMP_IMPORT],
    ["MSG_TABDUMP_IMPORT_ACK", CONFIG.MSG_TABDUMP_IMPORT_ACK],
    ["MSG_TABDUMP_PAGE_READY", CONFIG.MSG_TABDUMP_PAGE_READY],
    ["MSG_CHECK_IMPORTED", CONFIG.MSG_CHECK_IMPORTED],
    ["MSG_CHECK_IMPORTED_RESULT", CONFIG.MSG_CHECK_IMPORTED_RESULT],
    ["MSG_BROWSER_COMMAND", CONFIG.MSG_BROWSER_COMMAND],
    ["MSG_BROWSER_COMMAND_RESULT", CONFIG.MSG_BROWSER_COMMAND_RESULT],
    ["MSG_EXTENSION_PING", CONFIG.MSG_EXTENSION_PING],
    ["MSG_EXTENSION_PONG", CONFIG.MSG_EXTENSION_PONG],
  ];

  it.each(SHARED)("content-script.js declares %s with the same value as config.js", (name, value) => {
    expect(contentScript).toContain(`const ${name} = ${JSON.stringify(value)};`);
  });

  it("the web app's protocol.ts agrees on every value that crosses into the page", () => {
    for (const value of [
      CONFIG.MESSAGE_SOURCE,
      CONFIG.MSG_TABDUMP_IMPORT,
      CONFIG.MSG_TABDUMP_IMPORT_ACK,
      CONFIG.MSG_TABDUMP_PAGE_READY,
      CONFIG.MSG_BROWSER_COMMAND,
      CONFIG.MSG_BROWSER_COMMAND_RESULT,
      CONFIG.MSG_EXTENSION_PING,
      CONFIG.MSG_EXTENSION_PONG,
    ]) {
      expect(webProtocol).toContain(JSON.stringify(value));
    }
  });

  it("content-script.js's ack deadline matches the canonical budget it mirrors", () => {
    expect(contentScript).toContain(`const IMPORT_ACK_TIMEOUT_MS = ${CONFIG.IMPORT_ACK_TIMEOUT_MS};`);
  });

  // The popup's abandonment threshold has to sit above the pipeline's real
  // worst case, or a healthy dump gets declared dead mid-flight.
  it("the popup's staleness budget stays above a dump's worst-case duration", () => {
    expect(CONFIG.DUMP_RUNNING_STALE_MS).toBeGreaterThan(CONFIG.DUMP_WORST_CASE_MS);
    expect(CONFIG.DUMP_WORST_CASE_MS).toBeGreaterThanOrEqual(
      CONFIG.TAB_READY_TIMEOUT_MS + CONFIG.IMPORT_ACK_TIMEOUT_MS
    );
  });
});

// background.js repairs a tab with no receiver by injecting this same file
// with chrome.scripting.executeScript. That injection shares the isolated
// world with any manifest-declared copy, and the two can race: a
// document_start injection can land between the background's probe and its
// repair. A second live listener set would mean two independent
// `pendingImport` slots answering background.js on the same port, so which
// answer wins would be a race rather than a fact.
describe("a second injected copy in a tab that already has one", () => {
  /** Re-runs the file against the same window, as a repair injection does. */
  async function injectAgain() {
    vi.resetModules();
    await import("./content-script.js");
  }

  it("registers no additional listeners", async () => {
    await loadContentScript();
    const runtimeListeners = onMessageListeners.length;
    expect(runtimeListeners).toBeGreaterThan(0);

    await injectAgain();

    expect(onMessageListeners.length).toBe(runtimeListeners);
  });

  it("delivers a payload to the page exactly once, and acks it exactly once", async () => {
    await loadContentScript();
    await injectAgain();

    const seen = [];
    window.addEventListener("message", (event) => {
      if (event.data?.source === MESSAGE_SOURCE && event.data.type === MSG_TABDUMP_IMPORT) {
        seen.push(event.data.payload);
      }
    });

    const responsePromise = deliverImport("imp-dup", TABS);
    await new Promise((resolve) => setTimeout(resolve, 5));

    // One copy owns the bridge, so the page sees one import, not two.
    expect(seen).toHaveLength(1);
    expect(seen[0].importId).toBe("imp-dup");

    pagePosts(MSG_TABDUMP_IMPORT_ACK, { importId: "imp-dup", accepted: 2 });
    expect(await responsePromise).toEqual({ ok: true, accepted: 2 });
  });
});
