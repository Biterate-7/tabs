import { normalizeUrl } from "./normalize";
import type { Tab } from "./types";

const EXTENSION_MESSAGE_TIMEOUT_MS = 300;

type ExtensionTabInfo = {
  id: number;
  url?: string;
  windowId: number;
  lastAccessed?: number;
};

type MinimalChromeRuntime = {
  sendMessage: (
    extensionId: string,
    message: unknown,
    callback: (response: unknown) => void
  ) => void;
  lastError?: { message?: string };
};

function getExtensionId(): string | undefined {
  return process.env.NEXT_PUBLIC_TABDUMP_EXTENSION_ID;
}

function getChromeRuntime(): MinimalChromeRuntime | undefined {
  return (globalThis as { chrome?: { runtime?: MinimalChromeRuntime } }).chrome?.runtime;
}

/**
 * Sends one message to the TabDump extension and resolves with its response,
 * or `undefined` on any failure (not installed, disabled, timed out, threw,
 * or reported chrome.runtime.lastError) -- every failure mode collapses to
 * the same "extension unavailable" signal so callers have one fallback path.
 */
function sendExtensionMessage<T>(message: unknown): Promise<T | undefined> {
  const extensionId = getExtensionId();
  const runtime = getChromeRuntime();
  if (!extensionId || !runtime || typeof runtime.sendMessage !== "function") {
    return Promise.resolve(undefined);
  }

  return new Promise((resolve) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      resolve(undefined);
    }, EXTENSION_MESSAGE_TIMEOUT_MS);

    try {
      runtime.sendMessage(extensionId, message, (response) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (runtime.lastError) {
          resolve(undefined);
          return;
        }
        resolve(response as T);
      });
    } catch {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(undefined);
    }
  });
}

async function isExtensionAvailable(): Promise<boolean> {
  const response = await sendExtensionMessage<{ ok?: boolean }>({ type: "PING" });
  return response?.ok === true;
}

/**
 * Picks the best of several open-tab matches: highest `lastAccessed` wins;
 * ties (or tabs missing `lastAccessed`) fall back to the highest tab id, a
 * deterministic proxy for "most recently opened."
 */
function pickBestMatch(candidates: ExtensionTabInfo[]): ExtensionTabInfo | null {
  if (candidates.length === 0) return null;
  return candidates.reduce((best, current) => {
    const bestScore = best.lastAccessed ?? -1;
    const currentScore = current.lastAccessed ?? -1;
    if (currentScore !== bestScore) return currentScore > bestScore ? current : best;
    return current.id > best.id ? current : best;
  });
}

async function findOpenTab(normalizedUrl: string): Promise<ExtensionTabInfo | null> {
  const response = await sendExtensionMessage<ExtensionTabInfo[]>({ type: "LIST_TABS" });
  if (!Array.isArray(response)) return null;

  const matches: ExtensionTabInfo[] = [];
  for (const info of response) {
    if (!info || typeof info.url !== "string") continue;
    let parsed: URL;
    try {
      parsed = new URL(info.url);
    } catch {
      continue;
    }
    if (normalizeUrl(parsed) === normalizedUrl) matches.push(info);
  }

  return pickBestMatch(matches);
}

async function focusTab(tab: ExtensionTabInfo): Promise<boolean> {
  const response = await sendExtensionMessage<{ ok?: boolean }>({
    type: "FOCUS_TAB",
    tabId: tab.id,
    windowId: tab.windowId,
  });
  return response?.ok === true;
}

function openNewTab(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

/**
 * Opens a saved tab's URL, reusing an already-open browser tab when one
 * exists rather than creating a duplicate. Every failure path -- extension
 * not installed/disabled/unreachable, no match found, or the matched tab
 * disappearing before it can be focused -- falls back to opening a normal
 * new tab, silently. TabDump never depends on the extension being present.
 */
export async function openOrFocusTab(tab: Tab): Promise<void> {
  const available = await isExtensionAvailable();
  if (!available) {
    openNewTab(tab.url);
    return;
  }

  const match = await findOpenTab(tab.normalizedUrl);
  if (!match) {
    openNewTab(tab.url);
    return;
  }

  const focused = await focusTab(match);
  if (!focused) {
    openNewTab(tab.url);
  }
}
