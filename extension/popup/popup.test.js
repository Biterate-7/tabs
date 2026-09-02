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

beforeEach(() => {
  setPopupDom();
  globalThis.chrome = {
    tabs: {
      query: vi.fn().mockResolvedValue([{ id: 1, url: "https://a.com", title: "A", status: "complete" }]),
    },
    runtime: {
      sendMessage: vi.fn(),
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
