import {
  MSG_DUMP_TABS,
  MSG_CHECK_IMPORTED,
  MSG_FOCUS_TABDUMP,
  DUMP_STATE_KEY,
  DUMP_PHASE,
  DUMP_RUNNING_STALE_MS,
  DUMP_RESULT_FRESH_MS,
} from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";

const els = {
  loading: document.getElementById("state-loading"),
  ready: document.getElementById("state-ready"),
  dumping: document.getElementById("state-dumping"),
  success: document.getElementById("state-success"),
  error: document.getElementById("state-error"),
  tabCount: document.getElementById("tab-count"),
  importStatus: document.getElementById("import-status"),
  dumpingMessage: document.getElementById("dumping-message"),
  successCount: document.getElementById("success-count"),
  successDetail: document.getElementById("success-detail"),
  errorMessage: document.getElementById("error-message"),
  errorDetail: document.getElementById("error-detail"),
  preview: document.getElementById("tab-preview"),
  dumpButton: document.getElementById("dump-button"),
  openButton: document.getElementById("open-button"),
  retryButton: document.getElementById("retry-button"),
};

const ALL_STATES = [els.loading, els.ready, els.dumping, els.success, els.error];
const PREVIEW_LIMIT = 5;

// How long a rendered success stays on screen before the popup focuses the
// TabDump tab and closes itself. Focusing is what actually dismisses the
// popup (Chrome closes an action popup as soon as the foreground tab
// changes), so this is the window in which the user gets to read the result
// — which is exactly what a background-initiated focus used to steal.
const SUCCESS_DWELL_MS = 900;

// The window this popup was opened over. Captured from the very tabs the
// user is being shown a preview of, so the dump can name that exact window
// instead of leaving the background service worker to infer a "current"
// window it does not have one of — see background.js's windowQuery.
let currentWindowId;

// Populated once detectTabs() has learned which candidate urls are already
// in the currently selected workspace (undefined until then, or if that
// couldn't be determined at all — see checkAlreadyImported).
let alreadyImportedUrls;

// Where to send the user once they're done reading a result: set from
// whichever dump outcome this popup ends up rendering, whether that came
// back on this popup's own sendMessage or was recovered from storage after
// an earlier popup closed.
let focusTarget;

function showState(state) {
  for (const el of ALL_STATES) el.hidden = el !== state;
}

function renderPreview(tabs) {
  els.preview.innerHTML = "";

  for (const tab of tabs.slice(0, PREVIEW_LIMIT)) {
    const li = document.createElement("li");
    try {
      li.textContent = new URL(tab.url).hostname;
    } catch {
      li.textContent = tab.url;
    }
    els.preview.appendChild(li);
  }

  if (tabs.length > PREVIEW_LIMIT) {
    const li = document.createElement("li");
    li.textContent = `+${tabs.length - PREVIEW_LIMIT} more`;
    li.className = "popup__preview-more";
    els.preview.appendChild(li);
  }
}

/**
 * Asks the background worker (which relays through an already-open
 * TabDump tab's content script into the page itself) which of these urls
 * are already in the currently selected workspace. Resolves to `undefined`
 * — rather than throwing or guessing — whenever that genuinely can't be
 * determined (no TabDump tab open, or it didn't answer in time), so callers
 * can fall back to the plain "N tabs detected" wording instead of showing a
 * wrong new/existing split.
 */
async function checkAlreadyImported(urls) {
  try {
    const response = await chrome.runtime.sendMessage({ type: MSG_CHECK_IMPORTED, payload: { urls } });
    return response?.ok ? new Set(response.existingUrls) : undefined;
  } catch {
    return undefined;
  }
}

function updateReadyUi(tabs, existingUrls) {
  els.tabCount.textContent = String(tabs.length);
  renderPreview(tabs);

  if (!existingUrls) {
    els.importStatus.hidden = true;
    els.dumpButton.disabled = tabs.length === 0;
    els.dumpButton.textContent = "Dump Tabs →";
    return;
  }

  const newCount = tabs.filter((t) => !existingUrls.has(t.url)).length;
  const existingCount = tabs.length - newCount;

  els.importStatus.hidden = false;
  els.importStatus.textContent =
    existingCount === 0 ? "All new" : `${newCount} new · ${existingCount} already imported`;

  if (tabs.length > 0 && newCount === 0) {
    els.dumpButton.disabled = true;
    els.dumpButton.textContent = `${tabs.length} tab${tabs.length === 1 ? "" : "s"} already imported`;
  } else {
    els.dumpButton.disabled = tabs.length === 0;
    els.dumpButton.textContent = existingCount > 0 ? `Dump ${newCount} new tab${newCount === 1 ? "" : "s"} →` : "Dump Tabs →";
  }
}

async function detectTabs() {
  showState(els.loading);
  alreadyImportedUrls = undefined;

  const chromeTabs = await chrome.tabs.query({ currentWindow: true });
  currentWindowId = chromeTabs.find((tab) => Number.isInteger(tab.windowId))?.windowId;
  const payload = buildImportPayload(chromeTabs);

  updateReadyUi(payload.tabs, undefined);
  showState(els.ready);

  if (payload.tabs.length === 0) return;

  const existingUrls = await checkAlreadyImported(payload.tabs.map((t) => t.url));
  // The user may have already clicked Dump by the time this resolves;
  // showState(els.ready) again would be wrong if they've moved on.
  if (els.ready.hidden) return;
  alreadyImportedUrls = existingUrls;
  updateReadyUi(payload.tabs, existingUrls);
}

// What the user sees while a dump is in flight, per background.js's
// persisted phase. Concrete enough that a dump stuck on one of these is
// diagnosable from the popup alone, without opening the service worker's
// console.
const DUMP_PHASE_LABEL = {
  [DUMP_PHASE.QUERYING_TABS]: "Reading your open tabs…",
  [DUMP_PHASE.RESOLVING_TAB]: "Opening TabDump…",
  [DUMP_PHASE.DELIVERING]: "Handing your tabs to TabDump…",
  [DUMP_PHASE.RETRYING_IN_NEW_TAB]: "The open TabDump tab didn't respond — retrying in a new one…",
};

function showDumping(phase) {
  els.dumpingMessage.textContent = DUMP_PHASE_LABEL[phase] ?? "Dumping tabs…";
  showState(els.dumping);
}

// Maps a failed MSG_DUMP_TABS response's `reason` to copy a user can act
// on. Each reason corresponds to a distinct failure point in the pipeline
// (see background.js's dumpTabs) so "it didn't work" reports can actually
// be told apart: a same-origin page that can't mount the app looks nothing
// like the TabDump origin being unreachable, which looks nothing like
// TabDump's own tab-open call failing outright.
function describeDumpFailure(response) {
  switch (response?.reason) {
    case "no-importable-tabs":
      return { message: "No importable tabs in this window." };
    case "tab-query-failed":
      return { message: "Chrome wouldn't let TabDump read this window's tabs.", detail: response.detail };
    case "tab-open-failed":
      return { message: "Couldn't open or find the TabDump tab.", detail: response.detail };
    case "tab-load-timeout":
      return { message: "TabDump didn't finish loading. Check your connection and try again.", detail: response.detail };
    case "delivery-failed":
      return {
        message: "TabDump didn't respond in that tab. Reload the TabDump page and try again.",
        detail: response.detail,
      };
    case "page-not-ready":
    case "no-ack":
      return {
        message: "TabDump opened but never confirmed the import. Reload the TabDump page and try again.",
        detail: response.detail,
      };
    case "nothing-imported":
      return {
        message: "TabDump received the tabs but couldn't import any of them.",
        detail: response.detail,
      };
    case "interrupted":
      return { message: "The previous dump was interrupted before it finished. Please try again." };
    case "already-running":
      return { message: "A dump is already in progress. Please wait for it to finish." };
    case "unexpected-error":
      return { message: "Something unexpected went wrong while dumping.", detail: response.detail };
    default:
      return { message: "Couldn't reach TabDump. Is it running?", detail: response?.reason };
  }
}

// Best-effort read of background.js's persisted dump-state record (see
// config.js's DUMP_STATE_KEY). Used on popup open to recover from the
// previous popup instance having closed mid-dump — e.g. because it lost
// focus — before its chrome.runtime.sendMessage response could arrive.
// Never throws: chrome.storage.session may simply be unavailable, in which
// case the popup falls back to its old behavior of always starting fresh.
async function getPersistedDumpState() {
  const session = chrome.storage?.session;
  if (!session) return undefined;
  try {
    const data = await session.get(DUMP_STATE_KEY);
    return data?.[DUMP_STATE_KEY];
  } catch {
    return undefined;
  }
}

/**
 * Activates the TabDump tab a dump landed in. Sent from here rather than
 * done by background.js at the end of the dump, because focusing a tab is
 * what closes this popup — doing it from the background reliably destroyed
 * the popup before it could render anything, which is exactly what "Dumping
 * tabs…, then the popup vanished" looked like from the user's side.
 *
 * Best-effort: the tab may have been closed in the meantime. The dump
 * already succeeded either way, so a failure here never becomes an error
 * state.
 */
async function focusTabDump() {
  if (!focusTarget || !Number.isInteger(focusTarget.tabId)) return;
  try {
    await chrome.runtime.sendMessage({ type: MSG_FOCUS_TABDUMP, payload: focusTarget });
  } catch {
    // Background worker unreachable (extension reloading). Nothing to do:
    // the user still has the TabDump tab open, just not in front.
  }
}

// Renders a finished dump-state record exactly like a direct MSG_DUMP_TABS
// response would — used both by dumpTabs() below (the popup that actually
// triggered the dump, when it survives to see the response) and by
// watchForDumpCompletion() (a freshly reopened popup picking up a dump that
// finished after its predecessor had already closed).
function renderDumpOutcome(state) {
  if (state.focusTabId !== undefined) {
    focusTarget = { tabId: state.focusTabId, windowId: state.focusWindowId };
  }

  if (state.ok) {
    finishWithSuccess(state);
  } else {
    showError(describeDumpFailure(state));
  }
}

/**
 * Reports how many tabs actually landed, plus anything that didn't — a
 * partial import and a clean one must never look identical, and neither may
 * quietly hide the browser pages Chrome wouldn't let the extension read.
 */
function successDetail(state) {
  const notes = [];
  const attempted = state.count ?? 0;
  const accepted = state.accepted ?? attempted;
  if (accepted < attempted) notes.push(`${attempted - accepted} couldn't be read as a link`);
  if (state.skippedRestricted) notes.push(`${state.skippedRestricted} browser page${state.skippedRestricted === 1 ? "" : "s"} skipped`);
  if (state.skippedAlreadyImported) notes.push(`${state.skippedAlreadyImported} already imported`);
  return notes.join(" · ");
}

function finishWithSuccess(state) {
  els.successCount.textContent = String(state.accepted ?? state.count ?? 0);
  const detail = successDetail(state);
  els.successDetail.textContent = detail;
  els.successDetail.hidden = !detail;
  showState(els.success);
  setTimeout(() => {
    focusTabDump().finally(() => window.close());
  }, SUCCESS_DWELL_MS);
}

/**
 * Subscribes to changes to background.js's persisted dump record, calling
 * `handler(state)` with each new value. Returns a detach function, or
 * `undefined` when the API isn't available at all.
 *
 * Deliberately the TOP-LEVEL `chrome.storage.onChanged`, not
 * `chrome.storage.session.onChanged`. A StorageArea's own onChanged passes
 * its listener a single `changes` argument and no `areaName` (see MDN's
 * storage.StorageArea.onChanged) — so a listener written against the
 * two-argument `(changes, areaName)` signature sees `areaName === undefined`,
 * filters out every event it is handed, and never fires at all in a real
 * browser. It looks perfectly healthy under a test double that supplies the
 * second argument anyway, which is exactly how this shipped: the popup's
 * whole "reopen me to see how the dump ended" recovery path was inert, and a
 * popup that Chrome closed mid-dump had no way back to the result. The
 * top-level event genuinely does carry `areaName`, so filtering on it here
 * is real.
 */
function onDumpStateChange(handler) {
  const onChanged = chrome.storage?.onChanged;
  if (!onChanged) return undefined;

  function listener(changes, areaName) {
    if (areaName !== "session") return;
    const next = changes?.[DUMP_STATE_KEY]?.newValue;
    if (next) handler(next);
  }

  onChanged.addListener(listener);
  return () => onChanged.removeListener(listener);
}

// Watches for background.js to finish (or fail) a dump that was already
// running when this popup opened, so the user isn't left staring at
// "Dumping tabs…" forever just because the popup that started it is gone.
//
// `referenceStartedAt` anchors the abandonment deadline below — pass the
// dump's actual persisted `startedAt` when known (recovering an in-flight
// dump on popup open), or omit it to mean "starting now" (attaching to a
// dump that was only just reported as already running via a direct
// MSG_DUMP_TABS response, e.g. from a double-click racing background.js's
// own concurrency guard).
function watchForDumpCompletion(referenceStartedAt) {
  let settled = false;

  const detach = onDumpStateChange((state) => {
    // Still running: keep waiting, but reflect whichever phase it just moved
    // into so the user can see progress rather than a frozen message.
    if (state.status === "running") {
      showDumping(state.phase);
      return;
    }
    finish(state);
  });

  if (!detach) {
    // No storage.onChanged support to lean on — the dump is still running
    // in the background either way, but this popup instance has no way to
    // learn when it finishes. Reflect that rather than hanging silently.
    showError({ message: "A dump is already in progress. Reopen TabDump in a moment to see the result." });
    return;
  }

  function finish(state) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    detach();
    renderDumpOutcome(state);
  }

  // Close the narrow race where the dump already finished (and wrote its
  // result) in the gap between this popup's earlier storage read and the
  // subscription just above — onChanged only fires for changes made *after*
  // a listener is registered, so a completion landing in that gap would
  // otherwise never be observed by this popup instance, leaving it stuck on
  // "Dumping tabs…" even though the result is sitting right there in
  // storage.
  getPersistedDumpState().then((current) => {
    if (current && current.status !== "running") finish(current);
  });

  // Never wait indefinitely: if background.js's service worker was evicted
  // or crashed mid-dump, nothing will ever write a terminal state, and
  // onChanged would otherwise never fire — leaving the popup stuck exactly
  // like the original bug this whole recovery path exists to fix. Bounded
  // by the same staleness budget init() uses to judge a *persisted* running
  // record abandoned, anchored to when the dump actually started.
  const deadline = (referenceStartedAt ?? Date.now()) + DUMP_RUNNING_STALE_MS;
  const timer = setTimeout(() => {
    if (settled) return;
    settled = true;
    detach();
    showError({ message: "The previous dump didn't finish. Please try again." });
  }, Math.max(0, deadline - Date.now()));
}

function showError({ message, detail }) {
  els.errorMessage.textContent = message;
  els.errorDetail.textContent = detail ?? "";
  els.errorDetail.hidden = !detail;
  showState(els.error);
}

// Guards against a genuine double-click (two `click` events dispatched in
// quick succession against the same button, before the first handler's
// showDumping() has actually taken it off-screen) sending two
// MSG_DUMP_TABS requests. background.js's own concurrency guard would
// reject the second one regardless, but without this, that rejection would
// flip this popup from "Dumping tabs…" to a dead-end error — even though
// the real (first) dump is still proceeding fine in the background.
let dumpInFlight = false;

async function dumpTabs() {
  if (dumpInFlight) return;
  dumpInFlight = true;
  showDumping(DUMP_PHASE.QUERYING_TABS);
  // Phase updates for the dump this popup started arrive the same way they
  // do for one it merely inherited: through the persisted record. Attaching
  // here means the "Opening TabDump…" / "Handing your tabs over…" progress
  // is visible in the common case too, not only after a popup reopen.
  const detachPhaseWatch = watchDumpPhase();
  try {
    // Re-collects fresh tabs at click time (rather than reusing the popup's
    // initial snapshot) in case anything changed while the popup was open.
    // excludeUrls carries forward whatever "already imported" set detectTabs
    // learned, so a dump never re-sends tabs already in the workspace.
    const response = await chrome.runtime.sendMessage({
      type: MSG_DUMP_TABS,
      payload: {
        windowId: currentWindowId,
        excludeUrls: alreadyImportedUrls ? Array.from(alreadyImportedUrls) : undefined,
      },
    });
    detachPhaseWatch();
    if (response?.reason === "already-running") {
      // A dump is genuinely already in flight — most likely a narrow race
      // this popup can't otherwise prevent. Attach to its real outcome
      // instead of dead-ending on an error the user has no useful action
      // for; renderDumpOutcome() takes it from here once it resolves.
      watchForDumpCompletion(Date.now());
    } else {
      renderDumpOutcome(response ?? {});
    }
  } catch (err) {
    detachPhaseWatch();
    // chrome.runtime.sendMessage itself rejected/threw — the background
    // service worker never answered at all (distinct from it answering with
    // an error result, handled above), e.g. right after an extension
    // reload/update invalidates this popup's connection. The dump may still
    // be running, so point at the recovery path rather than implying it died.
    showError({
      message: "Lost contact with the TabDump extension. Reopen this popup to see how the dump ended.",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    dumpInFlight = false;
  }
}

/** Mirrors background.js's persisted phase into the dumping state. Returns a detach function. */
function watchDumpPhase() {
  const detach = onDumpStateChange((state) => {
    if (state.status === "running") showDumping(state.phase);
  });
  return detach ?? (() => {});
}

els.dumpButton.addEventListener("click", dumpTabs);
els.retryButton.addEventListener("click", detectTabs);
els.openButton.addEventListener("click", () => {
  focusTabDump().finally(() => window.close());
});

// Runs once on every popup open, before the normal detectTabs() flow, to
// recover from a dump that's still running (or that already finished)
// somewhere this popup instance didn't witness — most commonly because the
// popup that started it closed before background.js's response could
// arrive. Without this, reopening the popup would silently show "ready" as
// if nothing had happened, inviting a duplicate dump.
async function init() {
  const state = await getPersistedDumpState();

  if (state?.status === "running") {
    if (Date.now() - state.startedAt < DUMP_RUNNING_STALE_MS) {
      showDumping(state.phase);
      watchForDumpCompletion(state.startedAt);
      return;
    }
    // Older than any real dump should take — the service worker that was
    // running it was most likely evicted or crashed mid-dump. Let the user
    // retry instead of waiting on a result that will never arrive.
    showError({ message: "The previous dump didn't finish. Please try again." });
    return;
  }

  if (state?.finishedAt !== undefined && Date.now() - state.finishedAt < DUMP_RESULT_FRESH_MS) {
    renderDumpOutcome(state);
    return;
  }

  detectTabs();
}

init();
