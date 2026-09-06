import {
  TABDUMP_ORIGIN,
  TABDUMP_APP_PATH,
  MSG_DUMP_TABS,
  MSG_TABDUMP_IMPORT,
  MSG_CHECK_IMPORTED,
  MSG_BROWSER_COMMAND,
  MSG_FOCUS_TABDUMP,
  DUMP_STATE_KEY,
  DUMP_PHASE,
  TAB_READY_TIMEOUT_MS,
  SEND_RETRY_DELAYS_MS,
} from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";
import { validateBrowserCommand } from "../src/browser-commands.js";
import { BROWSER_ACTION_HANDLERS } from "../src/browser-actions.js";

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Structured, single-prefixed logging for every stage of the dump pipeline
// (dump started, tab count detected, tabs skipped, messages sent/received,
// completion/error) — so a report of "dumping tabs failed" on some other
// machine can actually be diagnosed from the service worker's console
// (chrome://extensions → TabDump → "service worker" → Inspect) instead of
// guessed at.
//
// Deliberately never logs a tab's url or title: the diagnostic value is in
// the counts, ids and stage names, and a service-worker console that logs a
// user's whole open-tab list is a privacy problem in exchange for nothing.
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

/**
 * A "running" dump record found in storage at service-worker startup can
 * only be an orphan: this module's `activeDump` is null by definition on a
 * fresh worker, so whatever wrote that record belonged to a worker instance
 * that no longer exists (evicted mid-dump, crashed, or reloaded). Left
 * alone, it makes the next popup open sit on "Dumping tabs…" until its
 * staleness deadline expires — waiting on a result nothing will ever write.
 *
 * MV3 gives no event for "you were evicted", so this runs at module scope
 * rather than from onStartup/onInstalled, which cover only browser launch
 * and install/update respectively — neither fires for a plain eviction,
 * which is the common case.
 */
async function reconcileOrphanedDump() {
  const session = chrome.storage?.session;
  if (!session) return;
  try {
    const data = await session.get(DUMP_STATE_KEY);
    const state = data?.[DUMP_STATE_KEY];
    if (state?.status !== "running") return;
    log("orphaned-dump-reconciled", { phase: state.phase, startedAt: state.startedAt });
    await session.set({
      [DUMP_STATE_KEY]: {
        ...state,
        status: "error",
        ok: false,
        reason: "interrupted",
        finishedAt: Date.now(),
      },
    });
  } catch (err) {
    log("orphaned-dump-reconcile-failed", errorMessage(err));
  }
}

reconcileOrphanedDump();

// Renders any caught value into a plain, safe-to-display string. Every
// error surfaced this way originates locally (chrome.* API rejections, or
// this file's own thrown errors) — never a server response — so there's
// nothing secret in it, just something concrete enough to tell "content
// script never attached" apart from "tab failed to open" when a user
// reports "dumping tabs failed" with no other detail to go on.
function errorMessage(err) {
  return err instanceof Error ? err.message : String(err);
}

function newImportId() {
  return globalThis.crypto?.randomUUID?.() ?? `import-${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

/**
 * Whether this tab is on the route that actually mounts TabDump's app shell.
 * Same-origin routes that don't (the /privacy, /terms and /cookies legal
 * pages) match chrome.tabs.query's url filter identically but can never
 * ingest a dump — handing one the payload used to look exactly like success.
 */
function isAppRouteUrl(url) {
  try {
    return new URL(url).pathname === TABDUMP_APP_PATH;
  } catch {
    return false;
  }
}

/**
 * Delivers `payload` to one specific tab and resolves to what actually
 * happened there.
 *
 * Two failure modes are deliberately kept apart, because they call for
 * opposite responses:
 *
 *  - chrome.tabs.sendMessage *rejecting* means no content script is attached
 *    to that tab yet (Chrome's "Could not establish connection. Receiving end
 *    does not exist."). That's often transient during a page load, so it's
 *    worth a couple of short retries.
 *  - a content script that answers `{ ok: false }` has given a definitive
 *    answer — the page behind it never became able to ingest the batch.
 *    Retrying the same tab would just burn another full ack timeout, so this
 *    returns immediately and lets the caller try a different tab instead.
 */
async function deliverImportToTab(tabId, importId, payload) {
  let lastError;
  for (const delay of [0, ...SEND_RETRY_DELAYS_MS]) {
    if (delay) await sleep(delay);
    try {
      const response = await chrome.tabs.sendMessage(tabId, {
        type: MSG_TABDUMP_IMPORT,
        importId,
        payload,
      });

      // A content script from a build predating the ack handshake answers
      // `undefined`. Treat that as unproven rather than as success — the
      // whole point of the handshake is that "the message was accepted by
      // *something*" is not evidence the app ingested it.
      if (!response) return { delivered: false, reason: "no-ack", detail: "The TabDump page did not confirm the import." };
      if (response.ok) return { delivered: true, accepted: Number(response.accepted) || 0 };
      return {
        delivered: false,
        reason: response.reason === "page-not-ready" ? "page-not-ready" : "no-ack",
        detail: `TabDump page reported "${response.reason}".`,
      };
    } catch (err) {
      // Receiving end not ready yet (or gone) — try again, or give up and
      // report this after the last attempt.
      lastError = err;
    }
  }
  return { delivered: false, reason: "delivery-failed", detail: errorMessage(lastError) };
}

// Newly-created tabs need their content script to have attached before a
// message can land. `status: "complete"` fires around the page's `load`
// event, and a `document_idle` content script (the default `run_at`, used
// here) always attaches before `load` — so waiting for "complete" is a
// reliable, race-free way to know the *content script* is ready.
//
// It says nothing about the React app behind it, which demonstrably attaches
// its own listener AFTER `load` — that gap is closed by the ack handshake in
// content-script.js, not here.
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

    function finish(outcome) {
      if (settled) return;
      settled = true;
      cleanup();
      resolve(outcome);
    }

    function onUpdated(updatedTabId, changeInfo) {
      if (updatedTabId === tabId && changeInfo.status === "complete") finish("complete");
    }

    function onRemoved(removedTabId) {
      if (removedTabId === tabId) finish("removed");
    }

    const timer = setTimeout(() => finish("timeout"), TAB_READY_TIMEOUT_MS);

    chrome.tabs.onUpdated.addListener(onUpdated);
    chrome.tabs.onRemoved.addListener(onRemoved);
  });
}

/**
 * Opens a brand-new TabDump tab and waits for it to finish loading.
 * Resolves to `{ tabId, windowId }`.
 *
 * Deliberately never activates the tab or focuses its window.
 * chrome.tabs.create()'s default `active: true` puts a brand-new tab in the
 * foreground *immediately*, and Chrome dismisses an open action-popup the
 * instant the foreground tab changes — which would kill the popup before
 * dumpTabs() has finished its remaining async work. Activation is the
 * popup's own call, once it has rendered a result (see MSG_FOCUS_TABDUMP).
 */
async function openTabDumpTab() {
  const created = await chrome.tabs.create({ url: TABDUMP_ORIGIN, active: false });
  const outcome = await waitForTabComplete(created.id);
  if (outcome === "removed") throw new Error("The TabDump tab was closed before it finished loading.");
  return { tabId: created.id, windowId: created.windowId, loadOutcome: outcome };
}

/**
 * Picks the already-open TabDump tab most likely to be able to ingest a
 * dump, or `undefined` when there isn't one.
 *
 * Ordering, most to least preferred:
 *   1. the app route, currently active — the tab the user is actually looking at
 *   2. the app route, in the background
 * A same-origin tab that isn't on the app route (a legal page) is never
 * chosen: it can't mount the app shell, so handing it the payload would
 * always end in a wasted ack timeout followed by the fresh-tab fallback.
 * Opening a usable tab straight away is both faster and less confusing.
 */
function pickIngestibleTab(matches) {
  const appRoute = matches.filter((tab) => typeof tab.url === "string" && isAppRouteUrl(tab.url));
  return appRoute.find((tab) => tab.active) ?? appRoute[0];
}

/**
 * The tabs to dump. `windowId` comes from the popup, which knows exactly
 * which window it was opened over and has already shown the user a preview
 * of that window's tabs.
 *
 * Falling back to `currentWindow: true` here is a genuinely different query:
 * a service worker has no window of its own, so Chrome resolves "current"
 * to the last-focused window. That is *usually* the popup's window, but it
 * is an inference about browser state rather than a fact — and when it is
 * wrong (several windows, focus moved between the popup opening and the
 * click landing) the user gets a silent wrong answer: a confident "Dumped 31
 * tabs" listing some other window's tabs entirely. Passing the id makes the
 * common path exact and leaves the inference only for a caller that has none.
 */
function windowQuery(windowId) {
  return Number.isInteger(windowId) ? { windowId } : { currentWindow: true };
}

async function dumpTabs(excludeUrls, windowId) {
  const startedAt = Date.now();
  const importId = newImportId();
  log("dump-started", { excludeCount: excludeUrls?.length ?? 0, importId });

  async function persist(patch) {
    await setDumpState({ startedAt, importId, ...patch });
  }

  await persist({ status: "running", phase: DUMP_PHASE.QUERYING_TABS });

  let chromeTabs;
  try {
    chromeTabs = await chrome.tabs.query(windowQuery(windowId));
  } catch (err) {
    const result = { ok: false, status: "error", reason: "tab-query-failed", count: 0, detail: errorMessage(err) };
    log("tab-query-failed", result.detail);
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    return { result };
  }

  const payload = buildImportPayload(chromeTabs, excludeUrls);
  const counts = {
    count: payload.tabs.length,
    skippedRestricted: payload.skippedRestricted,
    skippedAlreadyImported: payload.skippedAlreadyImported,
  };
  log("tabs-detected", { totalOpenTabs: chromeTabs.length, ...counts });

  if (payload.tabs.length === 0) {
    const result = { ok: false, status: "error", reason: "no-importable-tabs", ...counts };
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    return { result };
  }

  const wire = { tabs: payload.tabs };

  // Attempt 1: an already-open, app-route TabDump tab, when there is one.
  await persist({ status: "running", phase: DUMP_PHASE.RESOLVING_TAB, ...counts });

  let existing;
  try {
    existing = pickIngestibleTab(await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` }));
  } catch (err) {
    // Not fatal on its own: we can still open a fresh tab below. Recorded so
    // a profile where the url-filtered query is unexpectedly failing is
    // diagnosable rather than merely looking like "no TabDump tab open".
    log("tabdump-tab-lookup-failed", errorMessage(err));
  }

  if (existing?.id !== undefined) {
    log("tabdump-tab-reused", { tabId: existing.id, windowId: existing.windowId });
    await persist({ status: "running", phase: DUMP_PHASE.DELIVERING, ...counts });

    const attempt = await deliverImportToTab(existing.id, importId, wire);
    log("delivery-attempted", { tabId: existing.id, ...attempt });
    if (attempt.delivered) {
      return finishDelivered(attempt, existing.id, existing.windowId);
    }
    log("reused-tab-unusable", { tabId: existing.id, reason: attempt.reason });
  }

  // Attempt 2: a fresh tab. Reached either because no usable TabDump tab was
  // open, or because the one that was open turned out not to be able to
  // ingest (stale service-worker-less page, a crashed renderer, a build
  // mid-deploy). Retrying in a known-good tab is the difference between a
  // recoverable hiccup and a dump that silently vanishes.
  await persist({
    status: "running",
    phase: existing ? DUMP_PHASE.RETRYING_IN_NEW_TAB : DUMP_PHASE.RESOLVING_TAB,
    ...counts,
  });

  let opened;
  try {
    opened = await openTabDumpTab();
    log("tabdump-tab-opened", { tabId: opened.tabId, windowId: opened.windowId, loadOutcome: opened.loadOutcome });
  } catch (err) {
    // chrome.tabs.create itself failed — distinct from a *found* tab simply
    // not answering, so this never gets misreported as "TabDump didn't
    // respond".
    const result = {
      ok: false,
      status: "error",
      reason: "tab-open-failed",
      ...counts,
      detail: errorMessage(err),
    };
    log("tabdump-tab-open-failed", result.detail);
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    return { result };
  }

  await persist({ status: "running", phase: DUMP_PHASE.DELIVERING, ...counts });
  const attempt = await deliverImportToTab(opened.tabId, importId, wire);
  log("delivery-attempted", { tabId: opened.tabId, ...attempt });

  if (attempt.delivered) {
    return finishDelivered(attempt, opened.tabId, opened.windowId);
  }

  // A tab that never reached `status: "complete"` is a materially different
  // diagnosis from one that loaded and then didn't answer: it means the
  // TabDump origin itself couldn't be reached (offline, DNS, a captive
  // portal, a deployment that's down), which no amount of retrying in-page
  // will fix. Reporting the load timeout instead of the downstream "no
  // content script answered" is the difference between an actionable error
  // and a misleading one.
  const timedOutLoading = opened.loadOutcome === "timeout";
  const result = {
    ok: false,
    status: "error",
    reason: timedOutLoading ? "tab-load-timeout" : attempt.reason,
    ...counts,
    detail: timedOutLoading
      ? `${TABDUMP_ORIGIN} did not finish loading within ${TAB_READY_TIMEOUT_MS}ms.`
      : attempt.detail,
    focusTabId: opened.tabId,
    focusWindowId: opened.windowId,
  };
  await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
  log("dump-finished", result);
  return { result };

  async function finishDelivered(attempt, tabId, windowId) {
    // Acked, but with nothing taken: the app received the batch and parsed
    // zero usable tabs out of it. That is a failure, not a success with a
    // zero — reporting it as "Dumped 0 tabs" is exactly the kind of
    // false-positive this whole handshake exists to eliminate.
    const nothingImported = attempt.accepted === 0;
    const partial = !nothingImported && attempt.accepted < payload.tabs.length;

    const result = {
      ok: !nothingImported,
      status: nothingImported ? "error" : partial ? "partial" : "done",
      ...counts,
      accepted: attempt.accepted,
      ...(nothingImported ? { reason: "nothing-imported" } : {}),
      focusTabId: tabId,
      focusWindowId: windowId,
    };
    await persist({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    log("dump-finished", result);
    return { result };
  }
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
    safeSendResponse(sendResponse, { ok: false, status: "error", reason: "already-running", count: 0 });
    return true;
  }

  const run = dumpTabs(message.payload?.excludeUrls, message.payload?.windowId)
    .then(({ result }) => {
      // Nothing else happens after this. Activating or focusing the TabDump
      // tab from here would close the popup the instant Chrome noticed the
      // foreground tab change — routinely before the popup had rendered this
      // very result, which is what made a working dump look like "Dumping
      // tabs…, then the popup vanished and nothing happened". Focus is now
      // the popup's own call, once it has something on screen; see
      // MSG_FOCUS_TABDUMP below and popup.js's finishWithSuccess.
      safeSendResponse(sendResponse, result);
    })
    .catch((err) => {
      console.error("TabDump: dumpTabs failed", err);
      const result = { ok: false, status: "error", reason: "unexpected-error", count: 0, detail: errorMessage(err) };
      safeSendResponse(sendResponse, result);
      setDumpState({ ...result, phase: DUMP_PHASE.FINISHED, finishedAt: Date.now() });
    })
    .finally(() => {
      activeDump = null;
    });

  activeDump = run;
  return true; // keep the message channel open for the async sendResponse
});

/**
 * Popup-driven activation of the TabDump tab, sent once the popup has
 * rendered a dump's outcome and is about to close itself. Validated rather
 * than trusted: the ids come back through the popup, so they're re-checked
 * for shape here before reaching chrome.tabs/chrome.windows.
 */
chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
  if (message?.type !== MSG_FOCUS_TABDUMP) return undefined;

  const { tabId, windowId } = message.payload ?? {};
  if (!Number.isInteger(tabId)) {
    safeSendResponse(sendResponse, { ok: false, reason: "invalid-tab-id" });
    return undefined;
  }

  (async () => {
    try {
      await chrome.tabs.update(tabId, { active: true });
      if (Number.isInteger(windowId)) await chrome.windows.update(windowId, { focused: true });
      safeSendResponse(sendResponse, { ok: true });
    } catch (err) {
      // The tab or window has been closed since the dump finished. Reported
      // rather than swallowed, though the popup treats it as non-fatal — the
      // dump itself already succeeded and its result is what matters.
      log("focus-failed", errorMessage(err));
      safeSendResponse(sendResponse, { ok: false, reason: "focus-failed", detail: errorMessage(err) });
    }
  })();

  return true; // keep the message channel open for the async sendResponse
});

// Answers "which of these urls are already in the currently selected
// workspace?" by relaying to an *already open* TabDump tab's content
// script — deliberately never opens or focuses one just to check, since
// that would be a surprising side effect of simply opening the popup.
// Genuinely unknowable without an open tab (or if the page doesn't answer
// in time), in which case the popup falls back to its plain wording.
async function checkImported(urls) {
  const existing = pickIngestibleTab(await chrome.tabs.query({ url: `${TABDUMP_ORIGIN}/*` }));
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
