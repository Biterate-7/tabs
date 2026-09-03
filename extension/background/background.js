import {
  TABDUMP_ORIGIN,
  MSG_DUMP_TABS,
  MSG_TABDUMP_IMPORT,
  MSG_CHECK_IMPORTED,
  MSG_BROWSER_COMMAND,
  DUMP_STATE_KEY,
} from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";
import { validateBrowserCommand } from "../src/browser-commands.js";
import { BROWSER_ACTION_HANDLERS } from "../src/browser-actions.js";

// A couple of short retries in case the content script hasn't finished
// attaching its listener yet — see waitForTabComplete's comment for why
// this is a backstop rather than the primary mechanism.
const SEND_RETRY_DELAYS_MS = [150, 350];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Structured, single-prefixed logging for every stage of the dump pipeline
// (dump started, tab count detected, tabs skipped, messages sent/received,
// completion/error) — so a report of "dumping tabs failed" on some other
// machine can actually be diagnosed from the service worker's console
// (chrome://extensions → TabDump → "service worker" → Inspect) instead of
// guessed at.
function log(stage, data) {
  console.log(`[TabDump] ${stage}`, data ?? "");
}

// chrome.storage.session may be unavailable (very old Chrome, or a
// restricted profile) — every call through here is best-effort and never
// allowed to fail the dump itself; it only feeds popup.js's recovery path
// (see popup.js's init()/watchForDumpCompletion()), never the primary
// sendResponse result channel.
async function setDumpState(state) {
  const session = chrome.storage?.session;
  if (!session) return;
  try {
    await session.set({ [DUMP_STATE_KEY]: state });
  } catch (err) {
    log("dump-state-persist-failed", errorMessage(err));
  }
}

// Guards against two dumps racing each other — e.g. a duplicate click, or a
// second popup opened while a dump triggered from an earlier (possibly
// already-closed) popup is still in flight. Only one dumpTabs() run is ever
// allowed to be in progress at a time; a second request is told so
// immediately rather than being silently queued or allowed to interleave
// chrome.tabs calls with the first.
let activeDump = null;

// Renders any caught value into a plain, safe-to-display string. Every
// error surfaced this way originates locally (chrome.* API rejections, or
// this file's own thrown errors) — never a server response — so there's
// nothing secret in it, just something concrete enough to tell "content
// script never attached" apart from "tab failed to open" when a user
// reports "dumping tabs failed" with no other detail to go on.
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

// Resolves to `{ delivered, lastError }` rather than a bare boolean so a
// failure after every retry still carries *why* the last attempt failed
// (e.g. Chrome's own "Could not establish connection. Receiving end does
// not exist." — the standard symptom of the content script never having
// matched this tab's URL at all, as opposed to it merely not being ready
// yet) back to dumpTabs(), and from there to the popup's error state.
async function sendImportToTab(tabId, payload) {
  let lastError;
  for (const delay of [0, ...SEND_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      await chrome.tabs.sendMessage(tabId, { type: MSG_TABDUMP_IMPORT, payload });
      return { delivered: true };
    } catch (err) {
      // Receiving end not ready yet (or gone) — try again, or give up and
      // report this after the last attempt.
      lastError = err;
    }
  }
  return { delivered: false, lastError: errorMessage(lastError) };
}

const TAB_READY_TIMEOUT_MS = 8000;

// Newly-created tabs need their content script to have attached before a
// message can land. `status: "complete"` fires around the page's `load`
// event, and a `document_idle` content script (the default `run_at`, used
// here) always attaches before `load` — so waiting for "complete" is a
// reliable, race-free way to know the tab is ready, without polling.
//
// Bounded two ways so this can never hang `dumpTabs()` forever: a timeout
// (the page might never finish loading — blocked request, offline, etc.)
// and an onRemoved listener (the user might close the tab before it loads).
// Either one always cleans up both listeners.
function waitForTabComplete(tabId) {
  return new Promise((resolve) => {
    let settled = false;

    function cleanup() {
      chrome.tabs.onUpdated.removeListener(onUpdated);
      chrome.tabs.onRemoved.removeListener(onRemoved);
      clearTimeout(timer);
    }

    function finish() {
      if (settled) return;
      settled = true;
      cleanup();
      resolve();
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish();
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) finish();
    }

    const timer = setTimeout(finish, TAB_READY_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

// Resolves to `{ tabId, windowId }`. Deliberately never activates the tab
// or focuses its window itself — not even for a freshly created tab.
//
// chrome.tabs.create()'s default `active: true` puts a brand-new tab in the
// foreground *immediately*, which is precisely what was closing the
// extension's own popup before a dump could finish: Chrome dismisses an
// open action-popup the instant the foreground tab changes, and dumpTabs()
// still has real async work left after this point (waiting for the new
// tab's content script to attach, delivering the payload, retrying).
// Whichever popup triggered the dump would already be gone by the time
// sendResponse() ran, so the user only ever saw "Dumping tabs…" and then
// nothing. Reusing an already-open tab had the same latent risk from
// `chrome.tabs.update(existing.id, { active: true })` if that tab happened
// to sit in the same window the popup was opened from.
//
// So both branches now leave activation/focus entirely to the caller, which
// — like the pre-existing chrome.windows.update comment below explains —
// only ever does it *after* the popup already has its result.
async function findOrOpenTabDumpTab() {
  const matches = await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` });
  // When more than one TabDump tab is open, prefer whichever one the user is
  // currently looking at — the same "active wins" rule findMatchingTab
  // applies in tab-matching.js — rather than whichever tab chrome.tabs.query
  // happens to list first (window/tab-index order, unrelated to recency or
  // focus). Without this, dumping could reuse a stale background TabDump tab
  // instead of the one actually in front of the user, which looks exactly
  // like being unexpectedly bounced to a different TabDump page.
  const existing = matches.find((tab) => tab.active) ?? matches[0];
  if (existing) {
    return { tabId: existing.id, windowId: existing.windowId };
  }

  const created = await chrome.tabs.create({ url: TABDUMP_ORIGIN, active: false });
  await waitForTabComplete(created.id);
  return { tabId: created.id, windowId: created.windowId };
}

async function dumpTabs(excludeUrls) {
  const startedAt = Date.now();
  log("dump-started", { excludeCount: excludeUrls?.length ?? 0 });
  await setDumpState({ status: "running", startedAt });

  const chromeTabs = await chrome.tabs.query({ currentWindow: true });
  const payload = buildImportPayload(chromeTabs, excludeUrls);
  log("tabs-detected", {
    totalOpenTabs: chromeTabs.length,
    importable: payload.tabs.length,
    skipped: chromeTabs.length - payload.tabs.length,
  });

  if (payload.tabs.length === 0) {
    const result = { ok: false, reason: "no-importable-tabs", count: 0 };
    await setDumpState({ status: "error", ...result, startedAt, finishedAt: Date.now() });
    return { result };
  }

  let tabId, windowId;
  try {
    ({ tabId, windowId } = await findOrOpenTabDumpTab());
    log("tabdump-tab-resolved", { tabId, windowId });
  } catch (err) {
    // chrome.tabs.query/create itself failed — distinct from a *found* tab
    // simply not answering (see "delivery-failed" below), so this never
    // gets misreported as "TabDump didn't respond".
    const result = { ok: false, reason: "tab-open-failed", count: payload.tabs.length, detail: errorMessage(err) };
    log("tabdump-tab-resolve-failed", result.detail);
    await setDumpState({ status: "error", ...result, startedAt, finishedAt: Date.now() });
    return { result };
  }

  const { delivered, lastError } = await sendImportToTab(tabId, payload);
  log("delivery-attempted", { delivered, error: lastError });

  const result = delivered
    ? { ok: true, count: payload.tabs.length }
    : { ok: false, reason: "delivery-failed", count: payload.tabs.length, detail: lastError };

  await setDumpState({ status: delivered ? "done" : "error", ...result, startedAt, finishedAt: Date.now() });
  log("dump-finished", result);

  return { result, focusTabId: tabId, focusWindowId: windowId };
}

// Calling sendResponse on a message port whose other end (the popup) has
// already closed throws in some Chrome versions — without this guard, that
// throw would propagate out of the .then() below, land in the trailing
// .catch(), and call sendResponse a *second* time with a different payload.
// The dump's real result was already computed either way; a dead port just
// means nobody's listening for it anymore (see setDumpState/DUMP_STATE_KEY
// for how a freshly reopened popup recovers that result instead).
function safeSendResponse(sendResponse, payload) {
  try {
    sendResponse(payload);
  } catch (err) {
    log("send-response-failed", errorMessage(err));
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_DUMP_TABS) return undefined;

  if (activeDump) {
    log("dump-rejected-already-running", {});
    safeSendResponse(sendResponse, { ok: false, reason: "already-running", count: 0 });
    return true;
  }

  const run = dumpTabs(message.payload?.excludeUrls)
    .then(({ result, focusTabId, focusWindowId }) => {
      safeSendResponse(sendResponse, result);
      // Best-effort only, and deliberately after sendResponse: the popup
      // must get to render the dump's outcome before focus can move away
      // from it. Wrapped defensively since a window/tab that's since closed
      // can make this reject or throw depending on the Chrome version —
      // either way, the dump's own result was already delivered above and
      // shouldn't be clobbered by a failure in this purely cosmetic follow-up.
      if (focusWindowId !== undefined) {
        (async () => {
          try {
            if (focusTabId !== undefined) await chrome.tabs.update(focusTabId, { active: true });
            await chrome.windows.update(focusWindowId, { focused: true });
          } catch {
            // Ignored — see comment above.
          }
        })();
      }
    })
    .catch((err) => {
      console.error("TabDump: dumpTabs failed", err);
      const result = { ok: false, reason: "unexpected-error", count: 0, detail: errorMessage(err) };
      safeSendResponse(sendResponse, result);
      setDumpState({ status: "error", ...result, finishedAt: Date.now() });
    })
    .finally(() => {
      activeDump = null;
    });

  activeDump = run;
  return true; // keep the message channel open for the async sendResponse
});

// Answers "which of these urls are already in the currently selected
// workspace?" by relaying to an *already open* TabDump tab's content
// script — deliberately never opens or focuses one just to check, since
// that would be a surprising side effect of simply opening the popup.
// Genuinely unknowable without an open tab (or if the page doesn't answer
// in time), in which case the popup falls back to its plain wording.
async function checkImported(urls) {
  const [existing] = await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` });
  if (!existing) return { ok: false, reason: "no-tabdump-tab" };

  try {
    const response = await chrome.tabs.sendMessage(existing.id, {
      type: MSG_CHECK_IMPORTED,
      payload: { urls },
    });
    return response ?? { ok: false, reason: "no-response" };
  } catch {
    return { ok: false, reason: "delivery-failed" };
  }
}

chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_CHECK_IMPORTED) return undefined;

  checkImported(message.payload?.urls ?? [])
    .then((response) => safeSendResponse(sendResponse, response))
    .catch(() => safeSendResponse(sendResponse, { ok: false, reason: "unexpected-error" }));

  return true; // keep the message channel open for the async sendResponse
});

/**
 * Ask Tabs browser control: the single dispatch point for every
 * TABDUMP_BROWSER_COMMAND relayed up from content-script.js. Two checks
 * happen before any chrome.* API is touched, in order: (1) is `action` one
 * of the allowlisted names in BROWSER_ACTION_HANDLERS at all, and (2) does
 * `args` pass that action's own validator. A content script (or, further
 * back, the web page) is never trusted just because the message arrived
 * through the expected channel — see AGENTS.md section 14.
 */
async function handleBrowserCommand({ id, action, args }, senderTabId) {
  const validated = validateBrowserCommand(action, args);
  if (!validated.ok) {
    return { id, ok: false, error: validated.error };
  }

  const handler = BROWSER_ACTION_HANDLERS[action];
  if (!handler) {
    // Unreachable in practice (validateBrowserCommand's allowlist and this
    // handler map are drawn from the same action names), but a defensive
    // fallback beats ever assuming a validated name is dispatchable.
    return { id, ok: false, error: `No handler registered for "${action}".` };
  }

  try {
    // senderTabId is only meaningful to openUrl's reuseCurrentTab handling
    // (see browser-actions.js) — every other handler ignores this second arg.
    const result = await handler(validated.args, { senderTabId });
    return { id, ok: true, result };
  } catch (err) {
    return { id, ok: false, error: err instanceof Error ? err.message : "Browser command failed." };
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message?.type !== MSG_BROWSER_COMMAND) return undefined;

  const payload = message.payload ?? {};
  if (typeof payload.id !== "string" || typeof payload.action !== "string") {
    safeSendResponse(sendResponse, {
      id: typeof payload.id === "string" ? payload.id : "",
      ok: false,
      error: "Malformed browser command.",
    });
    return undefined;
  }

  handleBrowserCommand(payload, sender.tab?.id)
    .then((response) => safeSendResponse(sendResponse, response))
    .catch(() => safeSendResponse(sendResponse, { id: payload.id, ok: false, error: "Unexpected error running browser command." }));

  return true; // keep the message channel open for the async sendResponse
});
