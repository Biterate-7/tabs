// The popup's AI panel, kept current while it is open: the project list
// follows what Hubble reports (made, renamed, deleted), and a save shows what
// actually happened to it — reading, saving, waiting to try again, saved,
// failed — never "Saved" for a save that is only on its way.
import { afterEach, describe, expect, it, vi } from "vitest";
import { CAPTURE_JOBS_KEY, MSG_CAPTURE_CONVERSATION, MSG_CAPTURE_RETRY, MSG_CAPTURE_STATUS, MSG_DESKTOP_STATUS, MSG_MEMORY_REQUEST, PROJECTS_SNAPSHOT_KEY } from "../src/config.js";
import { describeCaptureJob, initAiPanel } from "./ai-panel.js";

const TAB = { id: 7, windowId: 1, url: "https://chatgpt.com/c/6ad062bc-2bcc-83e8-9305-06038d74964f", title: "Integration by parts - ChatGPT", active: true };
const KEY = "chatgpt:chat:6ad062bc-2bcc-83e8-9305-06038d74964f";
const PHYSICS = { id: "phys", name: "Physics" };
const MATHS = { id: "maths", name: "Maths" };

let storageListeners;
let local;
let sent;

/**
 * `answers[type]`: what background.js answers each message with (a function of its payload, or a value).
 * `hubbleOpen`: whether a Hubble tab answers "projects" live.
 */
function mount({ answers = {}, hubbleOpen = false, stored = {} } = {}) {
  document.body.innerHTML = `<section id="ai-section" hidden><p id="ai-page"></p><p id="ai-saved" hidden></p><select id="ai-project-select"></select>
    <button id="capture-button" disabled>Save this conversation</button><button id="capture-retry-button" hidden>Try again</button><button id="ai-open-hubble-button" hidden>Open Hubble</button>
    <p id="capture-status" role="status" hidden></p>
    <details id="memory-panel"><input id="memory-query" /><ul id="memory-results"></ul><textarea id="memory-request"></textarea>
    <button id="insert-button" disabled></button><button id="copy-button" disabled></button><p id="memory-status" hidden></p></details></section>`;
  storageListeners = [];
  local = { ...stored };
  sent = [];
  globalThis.chrome = {
    storage: {
      local: { get: vi.fn(async (key) => (key in local ? { [key]: local[key] } : {})), set: vi.fn(async () => {}) },
      onChanged: { addListener: (listener) => storageListeners.push(listener) },
    },
    tabs: { onUpdated: { addListener: () => {} }, onActivated: { addListener: () => {} }, get: vi.fn(async () => undefined) },
    runtime: {
      sendMessage: vi.fn(async ({ type, payload }) => {
        sent.push({ type, payload });
        if (type === MSG_DESKTOP_STATUS) return { ok: true, available: false };
        if (type === MSG_MEMORY_REQUEST && payload.kind === "projects") return hubbleOpen ? { ok: true, result: { projects: [PHYSICS] } } : { ok: false, error: "no-hubble-tab" };
        if (type === MSG_MEMORY_REQUEST) return { ok: false, error: "no-hubble-tab" };
        const answer = answers[type];
        return typeof answer === "function" ? answer(payload) : answer;
      }),
    },
  };
  return initAiPanel(TAB, document);
}

/** chrome.storage.onChanged, as the background's write would fire it. */
function storageChanged(key, newValue) {
  for (const listener of storageListeners) listener({ [key]: { newValue } }, "local");
}

const select = () => document.getElementById("ai-project-select");
const options = () => [...select().options].map((option) => option.textContent);
const status = () => document.getElementById("capture-status").textContent;
const retry = () => document.getElementById("capture-retry-button");
const save = () => document.getElementById("capture-button");
const settle = () => new Promise((resolve) => setTimeout(resolve, 30));

afterEach(() => {
  delete globalThis.chrome;
  document.body.innerHTML = "";
});

describe("the project list", () => {
  it("shows a project made in Hubble a moment ago even when no Hubble tab answers", async () => {
    await mount({ stored: { [PROJECTS_SNAPSHOT_KEY]: { revision: 5, projects: [PHYSICS, MATHS], currentId: "maths", receivedAt: 1 } } });
    expect(options()).toEqual(["Choose a project…", "Physics", "Maths"]);
    expect(select().value).toBe("maths");
    expect(save().disabled).toBe(false);
  });

  it("follows Hubble while the popup is open: a new project appears, a rename keeps the choice", async () => {
    await mount({ hubbleOpen: true });
    expect(select().value).toBe("phys");
    storageChanged(PROJECTS_SNAPSHOT_KEY, { revision: 9, projects: [PHYSICS, MATHS], receivedAt: 2 });
    expect(options()).toEqual(["Choose a project…", "Physics", "Maths"]);
    storageChanged(PROJECTS_SNAPSHOT_KEY, { revision: 10, projects: [{ id: "phys", name: "Physics HL" }, MATHS], receivedAt: 3 });
    expect(options()).toEqual(["Choose a project…", "Physics HL", "Maths"]);
    expect(select().value).toBe("phys");
  });

  it("clears the chosen project when it is deleted in Hubble, says so, and saves nowhere", async () => {
    await mount({ hubbleOpen: true });
    storageChanged(PROJECTS_SNAPSHOT_KEY, { revision: 9, projects: [MATHS], receivedAt: 2 });
    expect(select().value).toBe("");
    expect(status()).toBe("“Physics” was deleted in Hubble. Choose another project.");
    expect(save().disabled).toBe(true);
  });
});

describe("a save's state", () => {
  const job = (over) => ({ id: "cap-1", key: KEY, workspaceId: "phys", projectName: "Physics", attempts: 1, updatedAt: 1, ...over });

  it("never says Saved for a save that is waiting to try again — it says why, and offers Try again", async () => {
    const queued = job({ status: "queued", error: "timeout", nextAttemptAt: Date.now() + 5000 });
    await mount({ hubbleOpen: true, answers: { [MSG_CAPTURE_CONVERSATION]: { ok: false, error: "timeout", queued: true, job: queued } } });
    save().click();
    expect(status()).toBe("Reading the conversation…");
    await settle();
    expect(status()).toMatch(/^Not saved yet — Hubble didn't answer in time\. Hubble for Chrome will try again in \d s\.$/);
    expect(status()).not.toMatch(/Saved to/);
    expect(retry().hidden).toBe(false);
  });

  it("Try again delivers that same save and says Saved only on Hubble's answer", async () => {
    const queued = job({ status: "queued", error: "no-response", nextAttemptAt: Date.now() + 2000 });
    const saved = job({ status: "saved", attempts: 1, result: { outcome: "added", turns: 4, project: "Physics" } });
    await mount({
      hubbleOpen: true,
      answers: {
        [MSG_CAPTURE_CONVERSATION]: { ok: false, error: "no-response", queued: true, job: queued },
        [MSG_CAPTURE_RETRY]: { ok: true, result: saved.result, job: saved },
      },
    });
    save().click();
    await settle();
    retry().click();
    expect(status()).toBe("Saving to Physics…");
    await settle();
    expect(sent.filter((message) => message.type === MSG_CAPTURE_RETRY)).toEqual([{ type: MSG_CAPTURE_RETRY, payload: { id: "cap-1" } }]);
    expect(status()).toBe("Saved to Physics · 4 turns");
    expect(retry().hidden).toBe(true);
  });

  it("follows the job as the background delivers it, after the popup was reopened", async () => {
    await mount({ hubbleOpen: true, answers: { [MSG_CAPTURE_STATUS]: { ok: true, job: job({ status: "queued", error: "no-hubble-tab" }) } } });
    await settle();
    expect(status()).toBe("Not saved yet — Hubble isn't open. Hubble for Chrome will try again when Hubble is open.");
    storageChanged(CAPTURE_JOBS_KEY, [{ ...job({ status: "saving", attempts: 2, updatedAt: 2 }), capture: { turns: [] } }]);
    expect(status()).toBe("Saving to Physics…");
    storageChanged(CAPTURE_JOBS_KEY, [job({ status: "saved", attempts: 2, updatedAt: 3, result: { outcome: "added", turns: 2, project: "Physics" } })]);
    expect(status()).toBe("Saved to Physics · 2 turns");
  });

  it("says a failure in words, and offers Try again only when trying again can help", () => {
    expect(describeCaptureJob(job({ status: "failed", error: "storage-failed", retryable: true }))).toMatch(/couldn't keep the conversation/);
    expect(describeCaptureJob(job({ status: "failed", error: "project-missing" }))).toBe("That project isn't in Hubble any more. Choose another one.");
  });
});
