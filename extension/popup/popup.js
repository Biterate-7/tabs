import { MSG_DUMP_TABS, MSG_CHECK_IMPORTED } from "../src/config.js";
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
    case "unexpected-error":
      return { message: "Something unexpected went wrong while dumping.", detail: response.detail };
    default:
      return { message: "Couldn't reach TabDump. Is it running?", detail: response?.reason };
  }
}

function showError({ message, detail }) {
  els.errorMessage.textContent = message;
  els.errorDetail.textContent = detail ?? "";
  els.errorDetail.hidden = !detail;
  showState(els.error);
}

async function dumpTabs() {
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
  }
}

els.dumpButton.addEventListener("click", dumpTabs);
els.retryButton.addEventListener("click", detectTabs);

detectTabs();
