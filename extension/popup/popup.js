import {
  MSG_DUMP_TABS,
  MSG_CHECK_IMPORTED,
  DUMP_STATE_KEY,
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
  successCount: document.getElementById("success-count"),
  errorMessage: document.getElementById("error-message"),
  errorDetail: document.getElementById("error-detail"),
  preview: document.getElementById("tab-preview"),
  dumpButton: document.getElementById("dump-button"),
  retryButton: document.getElementById("retry-button"),
};

const ALL_STATES = [els.loading, els.ready, els.dumping, els.success, els.error];
const PREVIEW_LIMIT = 5;

// Populated once detectTabs() has learned which candidate urls are already
// in the currently selected workspace (undefined until then, or if that
// couldn't be determined at all — see checkAlreadyImported).
let alreadyImportedUrls;

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

// Maps a failed MSG_DUMP_TABS response's `reason` to copy a user can act
// on. Each reason corresponds to a distinct failure point in the pipeline
// (see background.js's dumpTabs) so "it didn't work" reports can actually
// be told apart: a stale/wrong TabDump tab that never got a content script
// attached looks nothing like TabDump's own tab-open call failing outright.
function describeDumpFailure(response) {
  switch (response?.reason) {
    case "no-importable-tabs":
      return { message: "No importable tabs in this window." };
    case "tab-open-failed":
      return { message: "Couldn't open or find the TabDump tab.", detail: response.detail };
    case "delivery-failed":
      return {
        message: "TabDump didn't respond in that tab. Reload the TabDump page and try again.",
        detail: response.detail,
      };
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

// Renders a finished (done/error) dump-state record exactly like a direct
// MSG_DUMP_TABS response would — used both by dumpTabs() below (the popup
// that actually triggered the dump, when it survives to see the response)
// and by watchForDumpCompletion() (a freshly reopened popup picking up a
// dump that finished after its predecessor had already closed).
function renderDumpOutcome(state) {
  if (state.status === "done") {
    els.successCount.textContent = String(state.count ?? 0);
    showState(els.success);
    setTimeout(() => window.close(), 900);
  } else {
    showError(describeDumpFailure(state));
  }
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
  const session = chrome.storage?.session;
  if (!session?.onChanged) {
    // No storage.onChanged support to lean on — the dump is still running
    // in the background either way, but this popup instance has no way to
    // learn when it finishes. Reflect that rather than hanging silently.
    showError({ message: "A dump is already in progress. Reopen TabDump in a moment to see the result." });
    return;
  }

  let settled = false;

  function finish(state) {
    if (settled) return;
    settled = true;
    clearTimeout(timer);
    session.onChanged.removeListener(onChanged);
    renderDumpOutcome(state);
  }

  function onChanged(changes, areaName) {
    if (areaName !== "session") return;
    const change = changes[DUMP_STATE_KEY];
    if (!change?.newValue || change.newValue.status === "running") return;
    finish(change.newValue);
  }

  session.onChanged.addListener(onChanged);

  // Close the narrow race where the dump already finished (and wrote its
  // result) in the gap between this popup's earlier storage read and the
  // addListener call just above — onChanged only fires for changes made
  // *after* a listener is registered, so a completion landing in that gap
  // would otherwise never be observed by this popup instance, leaving it
  // stuck on "Dumping tabs…" even though the result is sitting right there
  // in storage.
  session.get(DUMP_STATE_KEY).then((data) => {
    const current = data?.[DUMP_STATE_KEY];
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
    session.onChanged.removeListener(onChanged);
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
// showState(els.dumping) has actually taken it off-screen) sending two
// MSG_DUMP_TABS requests. background.js's own concurrency guard would
// reject the second one regardless, but without this, that rejection would
// flip this popup from "Dumping tabs…" to a dead-end error — even though
// the real (first) dump is still proceeding fine in the background.
let dumpInFlight = false;

async function dumpTabs() {
  if (dumpInFlight) return;
  dumpInFlight = true;
  showState(els.dumping);
  try {
    // Re-collects fresh tabs at click time (rather than reusing the popup's
    // initial snapshot) in case anything changed while the popup was open.
    // excludeUrls carries forward whatever "already imported" set detectTabs
    // learned, so a dump never re-sends tabs already in the workspace.
    const response = await chrome.runtime.sendMessage({
      type: MSG_DUMP_TABS,
      payload: { excludeUrls: alreadyImportedUrls ? Array.from(alreadyImportedUrls) : undefined },
    });
    if (response?.ok) {
      els.successCount.textContent = String(response.count);
      showState(els.success);
      setTimeout(() => window.close(), 900);
    } else if (response?.reason === "already-running") {
      // A dump is genuinely already in flight — most likely a narrow race
      // this popup can't otherwise prevent. Attach to its real outcome
      // instead of dead-ending on an error the user has no useful action
      // for; renderDumpOutcome() takes it from here once it resolves.
      watchForDumpCompletion(Date.now());
    } else {
      showError(describeDumpFailure(response));
    }
  } catch (err) {
    // chrome.runtime.sendMessage itself rejected/threw — the background
    // service worker never answered at all (distinct from it answering with
    // an error result, handled above), e.g. right after an extension
    // reload/update invalidates this popup's connection.
    showError({
      message: "Couldn't reach the TabDump extension's background service.",
      detail: err instanceof Error ? err.message : String(err),
    });
  } finally {
    dumpInFlight = false;
  }
}

els.dumpButton.addEventListener("click", dumpTabs);
els.retryButton.addEventListener("click", detectTabs);

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
      showState(els.dumping);
      watchForDumpCompletion(state.startedAt);
      return;
    }
    // Older than any real dump should take — the service worker that was
    // running it was most likely evicted or crashed mid-dump. Let the user
    // retry instead of waiting on a result that will never arrive.
    showError({ message: "The previous dump didn't finish. Please try again." });
    return;
  }

  if ((state?.status === "done" || state?.status === "error") && Date.now() - state.finishedAt < DUMP_RESULT_FRESH_MS) {
    renderDumpOutcome(state);
    return;
  }

  detectTabs();
}

init();
