// What the popup says after Save to Hubble, and how it re-reads what the
// Hubble page sends back. Pure parts of ai-panel.js, then the Save button
// itself with only chrome.runtime/storage mocked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSG_CAPTURE_CONVERSATION, MSG_DESKTOP_STATUS, MSG_MEMORY_REQUEST } from "../src/config.js";
import { captureError, describeCapture, initAiPanel, readHits, readPanelProjects } from "./ai-panel.js";

describe("describeCapture", () => {
  it("says what a save did, in words", () => {
    expect(describeCapture({ outcome: "added", turns: 14 }, "History IA")).toBe("Saved to History IA · 14 turns");
    expect(describeCapture({ outcome: "updated", turns: 1, truncated: true }, "History IA")).toBe("Updated the saved copy in History IA · 1 turn · very long, so only the first part was kept");
    expect(describeCapture({ outcome: "unchanged" }, "History IA")).toBe("Already saved in History IA — nothing new since.");
  });

  it("explains a kept longer copy, and how to save the whole thread", () => {
    expect(describeCapture({ outcome: "kept", turns: 2 }, "History IA")).toMatch(/already has more of this conversation .* kept\. Scroll to the top/);
  });

  it("says when only part of a long chat was on the page, without advice that scrolling would fix it", () => {
    const saved = describeCapture({ outcome: "added", turns: 4, partial: true, olderNotLoaded: true }, "History IA");
    expect(saved).toMatch(/^Saved to History IA · 4 turns\. Only the part of this chat loaded on the page was saved/);
    expect(saved).toMatch(/data export or paste the conversation in Hubble/);
    expect(saved).not.toMatch(/scroll/i);
    expect(describeCapture({ outcome: "kept", partial: true }, "History IA")).not.toMatch(/scroll/i);
  });
});

describe("what the popup accepts from the page", () => {
  it("keeps well-formed projects and hits only", () => {
    expect(readPanelProjects([{ id: "a", name: "History IA" }, { id: 3 }, null, { id: "b", name: "" }])).toEqual([
      { id: "a", name: "History IA" },
      { id: "b", name: "Untitled project" },
    ]);
    expect(readHits([{ workspaceId: "a", ref: { kind: "source", tabId: "t" }, title: "T", type: "conversation", provider: "claude", hasText: true }, { ref: { kind: "evil" }, title: "x", workspaceId: "a" }])).toEqual([
      { workspaceId: "a", ref: { kind: "source", tabId: "t" }, title: "T", type: "conversation", provider: "claude", snippet: "", hasText: true },
    ]);
  });

  it("falls back to a generic message for an unknown reason", () => {
    expect(captureError("not-a-conversation")).toMatch(/isn't one/);
    expect(captureError("read-failed")).toMatch(/couldn't read this conversation.*Paste a conversation/);
    expect(captureError("something-new")).toBe("Something went wrong. Try again.");
  });
});

describe("the Save button on a ChatGPT conversation", () => {
  const TAB = { id: 7, url: "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f", active: true };
  let captures;

  /** `desktop`: what background.js says about Hubble Desktop; `hubbleOpen`: whether a Hubble tab answers. */
  function mount(captureAnswer, { desktop, hubbleOpen = true } = {}) {
    // The AI section of popup.html, as the popup has it.
    document.body.innerHTML = `<section id="ai-section" hidden><p id="ai-page"></p><select id="ai-project-select"></select>
      <button id="capture-button" disabled>Save this conversation</button><button id="ai-open-hubble-button" hidden>Open Hubble</button>
      <p id="capture-status" role="status" hidden></p>
      <details id="memory-panel"><input id="memory-query" /><ul id="memory-results"></ul><textarea id="memory-request"></textarea>
      <button id="insert-button" disabled></button><button id="copy-button" disabled></button><p id="memory-status" hidden></p></details></section>`;
    captures = [];
    globalThis.chrome = {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
      runtime: {
        sendMessage: vi.fn(async ({ type, payload }) => {
          if (type === MSG_CAPTURE_CONVERSATION) {
            captures.push(payload);
            await new Promise((resolve) => setTimeout(resolve, 20));
            return typeof captureAnswer === "function" ? captureAnswer(payload) : captureAnswer;
          }
          if (type === MSG_DESKTOP_STATUS) return desktop;
          if (type === MSG_MEMORY_REQUEST && !hubbleOpen) return { ok: false, error: "no-hubble-tab" };
          if (type === MSG_MEMORY_REQUEST && payload.kind === "projects") return { ok: true, result: { projects: [{ id: "phys", name: "Physics" }] } };
          if (type === MSG_MEMORY_REQUEST) return { ok: true, result: { hits: [] } };
          return undefined;
        }),
      },
    };
    return initAiPanel(TAB, document);
  }

  const status = () => document.getElementById("capture-status").textContent;
  const button = () => document.getElementById("capture-button");
  const settle = () => new Promise((resolve) => setTimeout(resolve, 60));

  afterEach(() => {
    delete globalThis.chrome;
    document.body.innerHTML = "";
  });

  it("saves into the chosen project once, however many times it is clicked, and says what it saved", async () => {
    await mount({ ok: true, result: { outcome: "added", turns: 10, olderNotLoaded: true } });
    expect(document.getElementById("ai-project-select").value).toBe("phys");
    button().click();
    button().click();
    expect(button().disabled).toBe(true);
    expect(status()).toBe("Saving…");
    await settle();
    expect(captures).toEqual([{ tabId: 7, workspaceId: "phys" }]);
    expect(status()).toBe("Saved to Physics · 10 turns. Older messages hadn't loaded yet — scroll to the top of the chat and save again to include them.");
    expect(button().disabled).toBe(false);
  });

  it("offers the paste fallback only when the page's messages could not be read", async () => {
    await mount({ ok: false, error: "no-messages" });
    button().click();
    await settle();
    expect(status()).toMatch(/couldn't find the messages .* Add → Paste a conversation/);
  });

  it("says an empty conversation is empty, not unreadable", async () => {
    await mount({ ok: false, error: "empty-conversation" });
    button().click();
    await settle();
    expect(status()).toBe("There are no messages in this conversation yet. If it's still loading, wait a moment and try again.");
  });

  describe("with Hubble Desktop open", () => {
    const DESKTOP = { ok: true, available: true, conversations: true, seen: true };

    it("saves to Hubble Desktop with no project chosen here, and names the project chosen there", async () => {
      await mount({ ok: true, result: { outcome: "added", turns: 4, project: "Biology", desktop: true } }, { desktop: DESKTOP, hubbleOpen: false });
      expect(button().textContent).toBe("Save to Hubble Desktop");
      expect(button().disabled).toBe(false);
      expect(status()).toBe("Hubble Desktop is open. You'll choose the project there.");
      expect(document.getElementById("ai-open-hubble-button").hidden).toBe(true);
      button().click();
      expect(status()).toBe("Choose a project in Hubble Desktop…");
      await settle();
      expect(captures).toEqual([{ tabId: 7 }]);
      expect(status()).toBe("Saved to Biology · 4 turns");
    });

    it("says nothing was saved when the person cancels there", async () => {
      await mount({ ok: false, error: "desktop-cancelled" }, { desktop: DESKTOP });
      button().click();
      await settle();
      expect(status()).toBe("Nothing saved — cancelled in Hubble Desktop.");
    });

    it("goes back to Hubble on the web when Hubble Desktop closed in the meantime", async () => {
      await mount((payload) => (payload.workspaceId ? { ok: true, result: { outcome: "added", turns: 2 } } : { ok: false, error: "no-project" }), { desktop: DESKTOP, hubbleOpen: false });
      button().click();
      await settle();
      expect(button().textContent).toBe("Save this conversation");
      expect(status()).toBe("Hubble Desktop isn't open any more. Choose a project to save to Hubble on the web.");
      expect(button().disabled).toBe(true);
    });

    it("leaves Save to Hubble on the web when Hubble Desktop predates conversations", async () => {
      await mount({ ok: true, result: { outcome: "added", turns: 10 } }, { desktop: { ...DESKTOP, conversations: false } });
      expect(button().textContent).toBe("Save this conversation");
      button().click();
      await settle();
      expect(captures).toEqual([{ tabId: 7, workspaceId: "phys" }]);
    });
  });
});
