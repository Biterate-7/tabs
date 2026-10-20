// Chrome → Hubble Desktop: the extension's half of the direct import.
//
// Hubble Desktop runs a small bridge on this computer's loopback address
// (src-tauri/src/import_bridge.rs). Nothing here goes near the Hubble website
// or any server: tabs, or one AI conversation, travel from this extension to
// 127.0.0.1 and into the desktop app, where the person picks the project they
// go to.
//
//   findDesktop()        GET  /v1/hello on each bridge port — is Hubble Desktop open?
//   (not open)           open hubble://import (the installer registered it) and ask again
//                        — for tabs only: a conversation's Save then goes to Hubble on the web
//   sendToDesktop()      POST /v1/sessions → { sessionId, token }
//                        POST /v1/sessions/:id/import  Authorization: Bearer <token>
//                        (buildDesktopPayload: tabs; buildDesktopConversation: a conversation)
//   waitForDesktopResult GET  /v1/sessions/:id until the person has answered in Hubble
//
// The bridge only takes things in. Searching a project or building context
// from it ("Use your knowledge here") stays with Hubble on the web: any local
// program can pretend to be this extension, so the bridge never answers with
// anything the person saved.
//
// Everything here is pure apart from the `fetch` and `sleep` it is handed, so
// it is tested without a browser or a desktop app (desktop.test.js).
// background.js does the chrome.* calls. Constants are mirrored in
// src/lib/desktop/import-protocol.ts and the Rust bridge; a test there checks
// that the copies agree.

import { buildImportPayload } from "./tabs.js";

export const DESKTOP_PROTOCOL_VERSION = 1;

// Loopback ports the bridge may be on, tried together. Must match
// BRIDGE_PORTS in import_bridge.rs and manifest.json's host_permissions.
export const DESKTOP_BRIDGE_PORTS = [41517, 41518, 41519];

// The most one batch takes (Hubble's import pipeline takes 200 at a time).
export const DESKTOP_MAX_TABS = 200;

// Opens (or brings forward) Hubble Desktop. Carries no data.
export const DESKTOP_LAUNCH_URL = "hubble://import";

// A running Hubble answers on loopback in a few milliseconds; this only has
// to outlast a busy machine.
export const DESKTOP_PROBE_TIMEOUT_MS = 800;

// After opening hubble://, how long to keep asking. Covers Chrome's own
// "Open Hubble?" prompt and a cold start of the app (1–3 s), and no more.
export const DESKTOP_LAUNCH_WAIT_MS = 15000;
export const DESKTOP_LAUNCH_POLL_MS = 500;

// One request to the bridge. It answers immediately; anything slower is a
// bridge that has stopped responding.
export const DESKTOP_REQUEST_TIMEOUT_MS = 4000;

// While the person chooses a project in Hubble. Slightly longer than the
// bridge keeps a request (REQUEST_TTL, 180 s), so the bridge's "expired"
// answer is what normally ends the wait.
export const DESKTOP_RESULT_POLL_MS = 700;
export const DESKTOP_DECISION_TIMEOUT_MS = 185000;

// One conversation at most what Hubble keeps of one: CONVERSATION_LIMITS in
// src/lib/conversations/types.ts, MAX_CONVERSATION_* in the Rust bridge. A
// longer conversation is cut here, and Hubble says only the first part was
// kept, the same as when it is saved to Hubble on the web.
export const DESKTOP_MAX_TURNS = 4000;
export const DESKTOP_MAX_TURN_CHARS = 100000;
export const DESKTOP_MAX_CONVERSATION_CHARS = 2000000;
// The largest conversation request the bridge takes (MAX_CONVERSATION_BODY_BYTES).
export const DESKTOP_MAX_CONVERSATION_BYTES = 8 * 1024 * 1024;

const MAX_TITLE_CHARS = 500;
const AI_PROVIDERS = new Set(["chatgpt", "claude", "gemini", "perplexity"]);

/** A failure with a stable reason the toast and popup turn into words. */
export class DesktopError extends Error {
  constructor(reason, detail) {
    super(detail ?? reason);
    this.name = "DesktopError";
    this.reason = reason;
  }
}

function isWebAddress(url) {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:";
  } catch {
    return false;
  }
}

export function newRequestId() {
  return globalThis.crypto?.randomUUID?.() ?? `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/**
 * The batch Hubble Desktop takes, from raw `chrome.tabs.Tab`s: the address,
 * the title Chrome shows and the favicon — in window and tab-strip order.
 * Chrome-only fields (tab and window ids, pinned, active) stay here.
 *
 * Chrome's own pages are skipped (buildImportPayload), and anything past
 * DESKTOP_MAX_TABS is counted rather than silently cut.
 */
export function buildDesktopPayload(chromeTabs, requestId = newRequestId()) {
  const ordered = [...(chromeTabs ?? [])].sort((a, b) => (a?.windowId ?? 0) - (b?.windowId ?? 0) || (a?.index ?? 0) - (b?.index ?? 0));
  const { tabs, skippedRestricted } = buildImportPayload(ordered);
  const favicons = new Map(ordered.filter((tab) => tab?.url && isWebAddress(tab.favIconUrl)).map((tab) => [tab.id, tab.favIconUrl]));
  const sendable = tabs.slice(0, DESKTOP_MAX_TABS);
  return {
    payload: {
      version: DESKTOP_PROTOCOL_VERSION,
      requestId,
      source: "chrome-extension",
      tabs: sendable.map((tab) => ({
        url: tab.url,
        ...(tab.title ? { title: tab.title.slice(0, MAX_TITLE_CHARS) } : {}),
        ...(favicons.has(tab.tabId) ? { favicon: favicons.get(tab.tabId) } : {}),
      })),
    },
    skippedRestricted,
    overLimit: tabs.length - sendable.length,
  };
}

// A lone half of a surrogate pair is not valid JSON text to the bridge's
// parser: whatever the page held, or a cut made here, it becomes U+FFFD.
const LONE_SURROGATE = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/g;

function wellFormed(text) {
  return text.replace(LONE_SURROGATE, "\uFFFD");
}

/** At most `max` UTF-16 units, never ending on half a character. */
function cut(text, max) {
  if (text.length <= max) return text;
  const end = /[\uD800-\uDBFF]/.test(text[max - 1]) ? max - 1 : max;
  return text.slice(0, end);
}

const encoder = new TextEncoder();

/**
 * One conversation the person asked to save, as Hubble Desktop takes it:
 * the app it came from, its address, its title and its turns — role and
 * text, nothing else the page had. `capture` is what checkPageRead
 * (ai-pages.js) let through.
 *
 * Cut to DESKTOP_MAX_* here rather than refused there, and `truncated` says
 * so. Text is counted in UTF-16 units, which is never fewer than the
 * characters the bridge counts.
 */
export function buildDesktopConversation(capture, requestId = newRequestId()) {
  const provider = AI_PROVIDERS.has(capture?.provider) ? capture.provider : undefined;
  let truncated = capture?.truncated === true;
  const raw = Array.isArray(capture?.turns) ? capture.turns : [];
  if (raw.length > DESKTOP_MAX_TURNS) truncated = true;

  const turns = [];
  let left = DESKTOP_MAX_CONVERSATION_CHARS;
  for (const turn of raw.slice(0, DESKTOP_MAX_TURNS)) {
    if (!turn || (turn.role !== "user" && turn.role !== "assistant") || typeof turn.text !== "string" || !turn.text.trim()) continue;
    if (left <= 0) {
      truncated = true;
      break;
    }
    const room = Math.min(DESKTOP_MAX_TURN_CHARS, left);
    if (turn.text.length > room) truncated = true;
    const text = wellFormed(cut(turn.text, room));
    turns.push({ role: turn.role, text });
    left -= text.length;
  }

  const title = typeof capture?.title === "string" ? wellFormed(cut(capture.title.trim(), MAX_TITLE_CHARS)) : "";
  const build = () => ({
    version: DESKTOP_PROTOCOL_VERSION,
    requestId,
    source: "chrome-extension",
    kind: "conversation",
    conversation: { ...(provider ? { provider } : {}), url: capture?.url, ...(title ? { title } : {}), turns, truncated },
  });
  // Text that is mostly escapes or wide characters can still be too many bytes: the latest turns go first.
  let payload = build();
  while (turns.length > 1 && encoder.encode(JSON.stringify(payload)).length > DESKTOP_MAX_CONVERSATION_BYTES) {
    turns.splice(Math.max(1, Math.floor(turns.length * 0.9)));
    truncated = true;
    payload = build();
  }
  return { payload, turns: turns.length, truncated };
}

function bridgeUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

/** fetch with a deadline. Rejects with a DesktopError naming why. */
async function request(fetchFn, url, init = {}, timeoutMs = DESKTOP_REQUEST_TIMEOUT_MS) {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetchFn(url, { ...init, cache: "no-store", credentials: "omit", ...(controller ? { signal: controller.signal } : {}) });
    let body;
    try {
      body = await response.json();
    } catch {
      body = undefined;
    }
    return { status: response.status, ok: response.ok, body };
  } catch (err) {
    throw new DesktopError("desktop-not-responding", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Asks every bridge port at once whether Hubble Desktop is there. Resolves
 * `{ port, ready, conversations }` — `ready` once its window has loaded,
 * `conversations` when it is new enough to take one — or undefined.
 * Something else answering on one of the ports is not Hubble and is ignored.
 */
export async function findDesktop({ fetch: fetchFn = globalThis.fetch, timeoutMs = DESKTOP_PROBE_TIMEOUT_MS } = {}) {
  const answers = await Promise.all(
    DESKTOP_BRIDGE_PORTS.map(async (port) => {
      try {
        const { ok, body } = await request(fetchFn, bridgeUrl(port, "/v1/hello"), { method: "GET" }, timeoutMs);
        if (ok && body?.app === "hubble-desktop" && body.protocol === DESKTOP_PROTOCOL_VERSION) {
          return { port, ready: body.ready === true, conversations: Array.isArray(body.kinds) && body.kinds.includes("conversation") };
        }
      } catch {
        // Nothing on this port.
      }
      return undefined;
    })
  );
  return answers.find(Boolean);
}

/**
 * Keeps asking until Hubble Desktop answers or `waitMs` runs out — used
 * right after opening hubble://, while the app starts. `onTick` lets the
 * caller keep its service worker busy (and its toast current).
 */
export async function waitForDesktop({ fetch: fetchFn = globalThis.fetch, sleep, now = Date.now, waitMs = DESKTOP_LAUNCH_WAIT_MS, pollMs = DESKTOP_LAUNCH_POLL_MS, onTick } = {}) {
  const deadline = now() + waitMs;
  for (;;) {
    const found = await findDesktop({ fetch: fetchFn });
    if (found) return found;
    if (now() >= deadline) return undefined;
    await onTick?.();
    await sleep(pollMs);
  }
}

/** Why the bridge refused, as the reason the toast words. */
function refusalReason(status, body) {
  if (status === 400 || status === 413) return "invalid-payload";
  if (status === 429) return "desktop-busy";
  if (status === 401 || status === 404 || status === 410) return "desktop-session-lost";
  return body?.reason === "busy" ? "desktop-busy" : "desktop-not-responding";
}

/**
 * Opens a session and hands the batch over. Resolves the session (needed to
 * collect the answer) once Hubble Desktop has validated and queued the batch.
 */
export async function sendToDesktop({ port, payload, fetch: fetchFn = globalThis.fetch }) {
  const opened = await request(fetchFn, bridgeUrl(port, "/v1/sessions"), { method: "POST" });
  if (!opened.ok || typeof opened.body?.sessionId !== "string" || typeof opened.body?.token !== "string") {
    throw new DesktopError(refusalReason(opened.status, opened.body), `Session refused (${opened.status}).`);
  }
  const session = { port, sessionId: opened.body.sessionId, token: opened.body.token };
  const sent = await request(fetchFn, bridgeUrl(port, `/v1/sessions/${encodeURIComponent(session.sessionId)}/import`), {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.token}` },
    body: JSON.stringify(payload),
  });
  if (!sent.ok) throw new DesktopError(refusalReason(sent.status, sent.body), `Request refused (${sent.status}: ${sent.body?.reason ?? "no reason"}).`);
  return { ...session, requestId: payload.requestId, accepted: Number(sent.body?.accepted) || 0, rejected: Number(sent.body?.rejected) || 0 };
}

const SAVE_OUTCOMES = new Set(["added", "updated", "unchanged", "kept"]);

/**
 * A result as the bridge reported it, re-checked: known status, whole-number
 * counts, a short project name — and for a conversation, a known save
 * outcome, its turns and whether it was cut.
 */
export function readDesktopResult(raw, fallbackRequestId) {
  const status = ["done", "cancelled", "expired", "failed"].includes(raw?.status) ? raw.status : undefined;
  if (!status) return undefined;
  const result = raw.result ?? {};
  const count = (value) => (Number.isInteger(value) && value >= 0 ? value : 0);
  const common = {
    status,
    requestId: typeof result.requestId === "string" ? result.requestId : fallbackRequestId,
    success: result.success === true,
    ...(typeof result.project === "string" && result.project ? { project: result.project.slice(0, 120) } : {}),
  };
  if (result.kind === "conversation") {
    return {
      ...common,
      kind: "conversation",
      ...(SAVE_OUTCOMES.has(result.saved) ? { saved: result.saved } : {}),
      turns: count(result.turns),
      truncated: result.truncated === true,
    };
  }
  return { ...common, received: count(result.received), added: count(result.added), duplicates: count(result.duplicates), failed: count(result.failed) };
}

/**
 * Waits for the person to answer in Hubble Desktop (choose a project and add,
 * or cancel). Resolves the result; `onTick` runs on each poll.
 */
export async function waitForDesktopResult({ session, fetch: fetchFn = globalThis.fetch, sleep, now = Date.now, timeoutMs = DESKTOP_DECISION_TIMEOUT_MS, pollMs = DESKTOP_RESULT_POLL_MS, onTick }) {
  const deadline = now() + timeoutMs;
  let failures = 0;
  for (;;) {
    let answer;
    try {
      answer = await request(fetchFn, bridgeUrl(session.port, `/v1/sessions/${encodeURIComponent(session.sessionId)}`), {
        method: "GET",
        headers: { Authorization: `Bearer ${session.token}` },
      });
      failures = 0;
    } catch (err) {
      // One missed poll is a busy machine; several in a row is Hubble gone.
      if (++failures >= 3) throw err;
    }
    if (answer && !answer.ok) throw new DesktopError(refusalReason(answer.status, answer.body), `Status refused (${answer.status}).`);
    const result = answer ? readDesktopResult(answer.body, session.requestId) : undefined;
    if (result) return result;
    if (now() >= deadline) return { status: "expired", requestId: session.requestId, success: false, received: 0, added: 0, duplicates: 0, failed: 0 };
    await onTick?.();
    await sleep(pollMs);
  }
}

function plural(count, one, many = `${one}s`) {
  return `${count} ${count === 1 ? one : many}`;
}

/**
 * The words for a finished desktop add — the toast in Chrome and the popup
 * both use them, in the same words quick add uses for Hubble on the web.
 * `actions` names the follow-ups the person can take ("retry", "web");
 * background.js wires them up.
 *
 *   ✓ Added 9 sources to Research     8 of 10 added to Research      Hubble Desktop wasn't found
 *     3 already there                   2 couldn't be added            Open Hubble Web instead?
 */
export function describeDesktopResult(outcome) {
  const notSent = (outcome?.overLimit ?? 0) + (outcome?.skippedRestricted ?? 0);
  if (outcome?.status === "done") {
    const project = outcome.project || "your project";
    const failed = (outcome.failed ?? 0) + (outcome.overLimit ?? 0);
    const added = outcome.added ?? 0;
    const duplicates = outcome.duplicates ?? 0;
    const notes = [];
    if (added > 0 && duplicates > 0) notes.push(`${duplicates} already there`);
    if (failed > 0) notes.push(`${failed} couldn't be added`);
    if (outcome.skippedRestricted > 0) notes.push(`${plural(outcome.skippedRestricted, "Chrome page")} skipped`);
    if (added === 0 && duplicates > 0) {
      const which = duplicates > 1 ? "These sources are" : "This source is";
      return { tone: "same", title: `Already in ${project}`, detail: [`${which} already in the project.`, ...notes].join(" · ") };
    }
    if (added === 0) {
      return { tone: "error", title: `Couldn't add to ${project}`, detail: "Only web pages, PDFs and videos with a web address can be added.", actions: ["retry"] };
    }
    const total = added + duplicates + failed;
    const title = failed > 0 ? `${added} of ${total} added to ${project}` : added === 1 ? `Added to ${project}` : `Added ${added} sources to ${project}`;
    return { tone: "done", title, detail: notes.join(" · ") || undefined };
  }
  switch (outcome?.status ?? outcome?.reason) {
    case "cancelled":
      return { tone: "same", title: "Nothing added", detail: "Cancelled in Hubble Desktop." };
    case "expired":
      return { tone: "error", title: "Nothing added", detail: "No project was chosen in Hubble Desktop in time.", actions: ["retry"] };
    case "failed":
      return { tone: "error", title: "Couldn't import these tabs", detail: "Please try again.", actions: ["retry"] };
    case "no-importable-tabs":
      return {
        tone: "error",
        title: "Nothing to add",
        detail: outcome.blankOnly ? "A blank tab has nothing to add. Open a page in it first." : notSent > 0 ? "Chrome's own pages can't be added. Web pages, PDFs and videos can." : "There are no tabs to add.",
      };
    case "desktop-not-found":
      return { tone: "error", title: "Hubble Desktop wasn't found", detail: "Open Hubble Web instead?", actions: ["web", "retry"] };
    case "desktop-busy":
      return { tone: "error", title: "Hubble Desktop is busy", detail: "Finish adding the last tabs in Hubble Desktop, then try again.", actions: ["retry"] };
    case "invalid-payload":
      return { tone: "error", title: "Couldn't import these tabs", detail: "Please try again.", actions: ["retry"] };
    case "already-running":
      return { tone: "error", title: "Still adding the last tabs", detail: "Choose a project in Hubble Desktop first." };
    case "desktop-not-responding":
    case "desktop-session-lost":
    default:
      return { tone: "error", title: "Hubble Desktop isn't responding", detail: "Try again, or use Hubble Web instead.", actions: ["retry", "web"] };
  }
}

/**
 * The words for a finished "Save this conversation" into Hubble Desktop —
 * the toast in the AI app's page. The popup says the same in its own words
 * (popup/ai-panel.js), when it is still open to say it.
 */
export function describeDesktopSave(outcome) {
  if (outcome?.status === "done" && outcome.saved) {
    const project = outcome.project || "your project";
    const turns = outcome.turns > 0 ? plural(outcome.turns, "turn") : undefined;
    const cutNote = outcome.truncated ? "very long, so only the first part was kept" : undefined;
    const detail = [turns, cutNote].filter(Boolean).join(" · ") || undefined;
    switch (outcome.saved) {
      case "updated":
        return { tone: "done", title: `Updated in ${project}`, detail };
      case "unchanged":
        return { tone: "same", title: `Already saved in ${project}`, detail: "Nothing new since." };
      case "kept":
        return { tone: "same", title: `Kept the longer copy in ${project}`, detail: "Scroll to the top to load the whole conversation, then save again." };
      default:
        return { tone: "done", title: `Saved to ${project}`, detail };
    }
  }
  switch (outcome?.status ?? outcome?.reason) {
    case "cancelled":
      return { tone: "same", title: "Nothing saved", detail: "Cancelled in Hubble Desktop." };
    case "expired":
      return { tone: "error", title: "Nothing saved", detail: "No project was chosen in Hubble Desktop in time." };
    case "done":
    case "failed":
      return { tone: "error", title: "Couldn't save the conversation", detail: "Hubble Desktop couldn't keep it. Try again." };
    case "desktop-busy":
      return { tone: "error", title: "Hubble Desktop is busy", detail: "Finish what's open in Hubble Desktop, then try again." };
    case "already-running":
      return { tone: "error", title: "Already saving this conversation", detail: "Choose a project for it in Hubble Desktop first." };
    case "invalid-payload":
      return { tone: "error", title: "Couldn't save the conversation", detail: "Hubble Desktop couldn't take it. Reload the page and try again." };
    case "desktop-not-responding":
    case "desktop-session-lost":
    default:
      return { tone: "error", title: "Hubble Desktop isn't responding", detail: "Try again, or close Hubble Desktop to save to Hubble on the web." };
  }
}

/** The toast while a conversation is on its way to Hubble Desktop. */
export function describeDesktopSavePhase(phase) {
  return phase === "waiting"
    ? { tone: "working", title: "Save to Hubble", detail: "Choose a project in Hubble Desktop." }
    : { tone: "working", title: "Connecting to Hubble Desktop…" };
}

/** The toast while a desktop add is on its way, per phase. */
export function describeDesktopPhase(phase, count) {
  const tabs = plural(count ?? 0, "tab");
  switch (phase) {
    case "launching":
      return { tone: "working", title: "Opening Hubble Desktop…", detail: "If Chrome asks, choose Open Hubble." };
    case "waiting":
      return { tone: "working", title: `Add ${tabs} to Hubble`, detail: "Choose a project in Hubble Desktop." };
    default:
      return { tone: "working", title: "Connecting to Hubble Desktop…", detail: tabs };
  }
}
