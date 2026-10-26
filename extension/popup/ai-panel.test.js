// What the popup says after Save to Hubble, and how it re-reads what the
// Hubble page sends back. Pure parts of ai-panel.js, then the Save button
// itself with only chrome.runtime/storage mocked.
import { afterEach, describe, expect, it, vi } from "vitest";
import { MSG_CAPTURE_CONVERSATION, MSG_DESKTOP_STATUS, MSG_MEMORY_REQUEST } from "../src/config.js";
import { captureError, conversationTitleOf, describeCapture, describeSavedState, initAiPanel, readHits, readPanelProjects, readSavedPlaces } from "./ai-panel.js";

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
    expect(saved).toMatch(/data export in Hubble: Add → Import AI chats/);
    expect(saved).not.toMatch(/scroll/i);
    expect(describeCapture({ outcome: "kept", partial: true }, "History IA")).not.toMatch(/scroll/i);
  });
});

describe("describeSavedState", () => {
  it("says where this conversation is saved, and nothing when it is in no project or that is unknown", () => {
    expect(describeSavedState([])).toBe("");
    expect(describeSavedState(undefined)).toBe("");
    expect(describeSavedState([{ projectName: "Mathematics AA HL", title: "Integration by parts", hasText: true }])).toBe(
      "Already saved in Mathematics AA HL as “Integration by parts”. Saving again updates that copy."
    );
    expect(describeSavedState([{ projectName: "Maths", title: "", hasText: true }, { projectName: "Physics", title: "", hasText: true }])).toBe("Already saved in Maths and Physics. Saving again updates that copy.");
    expect(describeSavedState([{ projectName: "Maths", title: "Limits", hasText: false }])).toBe("In Maths as “Limits” as a link only. Save it to keep the conversation itself.");
  });

  it("re-reads the page's answer, keeping only well-formed places", () => {
    expect(readSavedPlaces([{ workspaceId: "w", tabId: "t", projectName: "Maths", title: "T", hasText: true, extra: "x" }, { workspaceId: 3 }, null])).toEqual([
      { workspaceId: "w", tabId: "t", projectName: "Maths", title: "T", hasText: true },
    ]);
    expect(readSavedPlaces("nope")).toEqual([]);
  });

  it("names the chat from the tab's title, never with the app's own name", () => {
    expect(conversationTitleOf({ title: "Integration by parts - ChatGPT" }, "ChatGPT")).toBe("Integration by parts");
    expect(conversationTitleOf({ title: "Thesis feedback - Claude" }, "Claude")).toBe("Thesis feedback");
    expect(conversationTitleOf({ title: "ChatGPT" }, "ChatGPT")).toBe("");
    expect(conversationTitleOf({ title: "New chat" }, "Claude")).toBe("");
    expect(conversationTitleOf({ title: "ChatGPT: free AI chat" }, "ChatGPT")).toBe("");
    expect(conversationTitleOf({}, "Gemini")).toBe("");
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
    expect(captureError("read-failed")).toMatch(/couldn't read this conversation.*Import AI chats/);
    expect(captureError("something-new")).toBe("Something went wrong. Try again.");
  });
});

describe("the Save button on a ChatGPT conversation", () => {
  const TAB = { id: 7, windowId: 1, url: "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f", title: "Integration by parts - ChatGPT", active: true };
  const KEY = "chatgpt:chat:6ad062bc-2bcc-83e8-9305-06038d74964f";
  let captures;
  let lookups;
  let tabListeners;

  /**
   * `desktop`: what background.js says about Hubble Desktop; `hubbleOpen`: whether a Hubble tab answers;
   * `saved`: the page's "saved" answer for an address (default: in no project).
   */
  function mount(captureAnswer, { desktop, hubbleOpen = true, saved = () => [] } = {}) {
    // The AI section of popup.html, as the popup has it.
    document.body.innerHTML = `<section id="ai-section" hidden><p id="ai-page"></p><p id="ai-saved" hidden></p><select id="ai-project-select"></select>
      <button id="capture-button" disabled>Save this conversation</button><button id="ai-open-hubble-button" hidden>Open Hubble</button>
      <p id="capture-status" role="status" hidden></p>
      <details id="memory-panel"><input id="memory-query" /><ul id="memory-results"></ul><textarea id="memory-request"></textarea>
      <button id="insert-button" disabled></button><button id="copy-button" disabled></button><p id="memory-status" hidden></p></details></section>`;
    captures = [];
    lookups = [];
    tabListeners = { updated: [], activated: [] };
    globalThis.chrome = {
      storage: { local: { get: vi.fn(async () => ({})), set: vi.fn(async () => {}) } },
      tabs: {
        onUpdated: { addListener: (listener) => tabListeners.updated.push(listener) },
        onActivated: { addListener: (listener) => tabListeners.activated.push(listener) },
        get: vi.fn(async () => undefined),
      },
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
          if (type === MSG_MEMORY_REQUEST && payload.kind === "saved") {
            lookups.push(payload.args.url);
            const places = saved(payload.args.url);
            return { ok: true, result: { conversation: places !== undefined, saved: places ?? [] } };
          }
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
    // Capturing: the read comes first; "Saved" only on Hubble's answer.
    expect(status()).toBe("Reading the conversation…");
    await settle();
    expect(captures).toEqual([{ tabId: 7, expectedKey: KEY, workspaceId: "phys" }]);
    expect(status()).toBe("Saved to Physics · 10 turns. Older messages hadn't loaded yet — scroll to the top of the chat and save again to include them.");
    expect(button().disabled).toBe(false);
  });

  it("offers the export fallback when the page's messages could not be read", async () => {
    await mount({ ok: false, error: "no-messages" });
    button().click();
    await settle();
    expect(status()).toMatch(/couldn't find the messages .* Add → Import AI chats/);
    expect(status()).not.toMatch(/paste/i);
  });

  it("says an empty conversation is empty, not unreadable", async () => {
    await mount({ ok: false, error: "empty-conversation" });
    button().click();
    await settle();
    expect(status()).toBe("There are no messages in this conversation yet. If it's still loading, wait a moment and try again.");
  });

  describe("always about the conversation on screen (regression: a second chat from the same app looked saved)", () => {
    const B = "https://chatgpt.com/c/68f0c3d4-aaaa-bbbb-cccc-ddddeeeeffff";
    const KEY_B = "chatgpt:chat:68f0c3d4-aaaa-bbbb-cccc-ddddeeeeffff";
    const savedA = (url) => (url === TAB.url ? [{ workspaceId: "phys", tabId: "t1", projectName: "Physics", title: "Integration by parts", hasText: true }] : url.includes("/c/") ? [] : undefined);
    const saved = () => document.getElementById("ai-saved");
    /** The tab moves to another address, as chrome.tabs.onUpdated reports it. */
    const navigate = (url, title = "") => {
      for (const listener of tabListeners.updated) listener(TAB.id, { url }, { ...TAB, url, title });
    };

    it("names the conversation on screen, and says where it is already saved — without disabling Save", async () => {
      await mount({ ok: true, result: { outcome: "unchanged" } }, { saved: savedA });
      await settle();
      expect(document.getElementById("ai-page").textContent).toBe("ChatGPT · Integration by parts");
      expect(lookups).toEqual([TAB.url]);
      expect(saved().textContent).toBe("Already saved in Physics as “Integration by parts”. Saving again updates that copy.");
      expect(saved().hidden).toBe(false);
      expect(button().disabled).toBe(false);
    });

    it("starts over when the tab opens another chat from the same app: not saved, and saveable", async () => {
      await mount({ ok: true, result: { outcome: "added", turns: 2 } }, { saved: savedA });
      await settle();
      expect(saved().hidden).toBe(false);

      navigate(B, "Integration by substitution - ChatGPT");
      await settle();
      expect(document.getElementById("ai-page").textContent).toBe("ChatGPT · Integration by substitution");
      expect(lookups).toEqual([TAB.url, B]);
      expect(saved().hidden).toBe(true);
      expect(button().disabled).toBe(false);
      button().click();
      await settle();
      expect(captures).toEqual([{ tabId: 7, expectedKey: KEY_B, workspaceId: "phys" }]);
      expect(status()).toBe("Saved to Physics · 2 turns");
    });

    it("never lets a save still running for one chat disable saving the next, or report against it", async () => {
      let finishA;
      await mount((payload) => (payload.expectedKey === KEY ? new Promise((resolve) => (finishA = () => resolve({ ok: true, result: { outcome: "added", turns: 9 } }))) : { ok: true, result: { outcome: "added", turns: 2 } }));
      button().click();
      expect(button().disabled).toBe(true);

      navigate(B);
      await settle();
      expect(button().disabled).toBe(false);
      expect(status()).toBe("");
      button().click();
      await settle();
      expect(status()).toBe("Saved to Physics · 2 turns");

      finishA();
      await settle();
      // A's answer arrives after the tab moved on: B's state stays.
      expect(status()).toBe("Saved to Physics · 2 turns");
      expect(captures.map((capture) => capture.expectedKey)).toEqual([KEY, KEY_B]);
    });

    it("comes back to A's saved state on back, and treats a harmless address change as the same chat", async () => {
      await mount({ ok: true, result: { outcome: "added" } }, { saved: savedA });
      await settle();
      navigate(B);
      await settle();
      expect(saved().hidden).toBe(true);
      navigate(TAB.url);
      await settle();
      expect(saved().textContent).toMatch(/^Already saved in Physics/);
      const before = lookups.length;
      navigate(`${TAB.url}?model=gpt-4o`);
      await settle();
      expect(lookups).toHaveLength(before);
      expect(saved().textContent).toMatch(/^Already saved in Physics/);
    });

    it("on the app's home page, offers nothing to save and claims nothing is saved", async () => {
      await mount({ ok: true, result: { outcome: "added" } }, { saved: savedA });
      navigate("https://chatgpt.com/");
      await settle();
      expect(document.getElementById("ai-page").textContent).toBe("ChatGPT · open a conversation to save it");
      expect(button().disabled).toBe(true);
      expect(saved().hidden).toBe(true);
    });

    it("keeps a failed save recoverable: says why, claims nothing, and Save works again", async () => {
      let attempt = 0;
      await mount(() => (++attempt === 1 ? { ok: false, error: "storage-failed" } : { ok: true, result: { outcome: "added", turns: 2 } }));
      button().click();
      await settle();
      expect(status()).toBe("Hubble couldn't keep the conversation on this device, so nothing was saved. Try again.");
      expect(saved().hidden).toBe(true);
      expect(button().disabled).toBe(false);
      button().click();
      await settle();
      expect(status()).toBe("Saved to Physics · 2 turns");
    });

    it("says so when the tab moved to another chat before the save could read it", async () => {
      await mount({ ok: false, error: "tab-changed" });
      button().click();
      await settle();
      expect(status()).toMatch(/^This tab moved to another conversation, so nothing was saved/);
    });
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
      expect(captures).toEqual([{ tabId: 7, expectedKey: KEY }]);
      expect(status()).toBe("Saved to Biology · 4 turns");
    });

    it("claims nothing about where the conversation is saved: Hubble on the web can't say what Hubble Desktop holds", async () => {
      await mount({ ok: true, result: { outcome: "added", turns: 4, project: "Biology", desktop: true } }, { desktop: DESKTOP, saved: () => [{ workspaceId: "phys", tabId: "t1", projectName: "Physics", title: "x", hasText: true }] });
      await settle();
      expect(lookups).toEqual([]);
      expect(document.getElementById("ai-saved").hidden).toBe(true);
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
      expect(captures).toEqual([{ tabId: 7, expectedKey: KEY, workspaceId: "phys" }]);
    });
  });
});
