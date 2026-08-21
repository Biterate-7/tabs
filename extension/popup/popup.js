import { MSG_DUMP_TABS } from "../src/config.js";
import { buildImportPayload } from "../src/tabs.js";

const els = {
  loading: document.getElementById("state-loading"),
  ready: document.getElementById("state-ready"),
  dumping: document.getElementById("state-dumping"),
  success: document.getElementById("state-success"),
  error: document.getElementById("state-error"),
  tabCount: document.getElementById("tab-count"),
  successCount: document.getElementById("success-count"),
  errorMessage: document.getElementById("error-message"),
  preview: document.getElementById("tab-preview"),
  dumpButton: document.getElementById("dump-button"),
  retryButton: document.getElementById("retry-button"),
};

const ALL_STATES = [els.loading, els.ready, els.dumping, els.success, els.error];
const PREVIEW_LIMIT = 5;

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

async function detectTabs() {
  showState(els.loading);
  const chromeTabs = await chrome.tabs.query({ currentWindow: true });
  const payload = buildImportPayload(chromeTabs);

  els.tabCount.textContent = String(payload.tabs.length);
  renderPreview(payload.tabs);
  els.dumpButton.disabled = payload.tabs.length === 0;
  showState(els.ready);
}

async function dumpTabs() {
  showState(els.dumping);
  try {
    // Re-collects fresh tabs at click time (rather than reusing the popup's
    // initial snapshot) in case anything changed while the popup was open.
    const response = await chrome.runtime.sendMessage({ type: MSG_DUMP_TABS });
    if (response?.ok) {
      els.successCount.textContent = String(response.count);
      showState(els.success);
      setTimeout(() => window.close(), 900);
    } else {
      els.errorMessage.textContent =
        response?.reason === "no-importable-tabs"
          ? "No importable tabs in this window."
          : "Couldn't reach TabDump. Is it running?";
      showState(els.error);
    }
  } catch {
    els.errorMessage.textContent = "Couldn't reach TabDump. Is it running?";
    showState(els.error);
  }
}

els.dumpButton.addEventListener("click", dumpTabs);
els.retryButton.addEventListener("click", detectTabs);

detectTabs();
