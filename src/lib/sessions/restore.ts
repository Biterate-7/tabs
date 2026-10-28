"use client"

import { sendBrowserCommand } from "@/lib/browser/bridge"
import { DESKTOP_UNREACHABLE, isSafeOpenUrl } from "@/lib/browser/protocol"
import { createId } from "@/lib/id"
import { openExternal } from "@/lib/platform"
import { MAX_SESSION_TABS } from "./types"

/**
 * Opening saved tabs in Chrome, through Hubble for Chrome — or, in Hubble
 * Desktop, which Hubble for Chrome can't be asked to do anything from, in the
 * default browser (openInDefaultBrowser below).
 *
 * Through the extension, always into a NEW window: the person's current tabs
 * are never closed, moved or replaced. Tabs open in their saved order.
 *
 * One launch at a time per page, and each launch carries a request id the
 * extension remembers, so a double click, a retried message or a second
 * Hubble tab asking twice cannot open the same tabs twice.
 */

export type RestoreTab = { url: string; pinned?: boolean }

export type RestoreOutcome =
  /**
   * Chrome answered: `opened` tabs are open; `failed` are the ones it refused.
   * `inBrowser`: Hubble Desktop handed them to the default browser one by one
   * instead, so there is no new window to speak of.
   */
  | { kind: "opened"; opened: number; failed: { url: string; error: string }[]; inBrowser?: true }
  /** Nothing to open (every address was invalid). Nothing was sent. */
  | { kind: "empty" }
  /** Another launch from this page is still running. Nothing was sent. */
  | { kind: "busy" }
  /** Hubble for Chrome isn't installed, enabled or answering. */
  | { kind: "no-extension" }
  /** The installed extension predates `open_session` and the launch is too big for the older command. */
  | { kind: "outdated" }
  /** Chrome was asked but hasn't confirmed: tabs may still be opening. */
  | { kind: "timeout" }
  | { kind: "failed"; message: string }

/** What the older `open_tabs` command accepts in one call (extension/src/browser-commands.js). */
const LEGACY_MAX_URLS = 50
const NO_EXTENSION_TIMEOUT_MS = 3000
const BASE_TIMEOUT_MS = 15_000
const PER_TAB_TIMEOUT_MS = 150

type OpenSessionResult = { windowId?: number; opened: number; failed: { index: number; url: string; error: string }[]; duplicate?: boolean }
type OpenTabsResult = { opened: unknown[]; failed: { url: string; error: string }[] }

let inFlight = false

function isTimeout(error: string): boolean {
  return /timed out/i.test(error)
}

function isUnknownAction(error: string): boolean {
  return /unknown or disallowed browser action/i.test(error)
}

/**
 * Opens `tabs` in a new Chrome window and says exactly what happened. Never
 * throws. `connected` is the bridge's current view of the extension: when it
 * has not answered a ping, the request waits only briefly before saying so.
 */
export async function restoreTabs(tabs: readonly RestoreTab[], options: { connected: boolean }): Promise<RestoreOutcome> {
  const safe = tabs.filter((tab) => isSafeOpenUrl(tab.url)).slice(0, MAX_SESSION_TABS)
  if (safe.length === 0) return { kind: "empty" }
  if (inFlight) return { kind: "busy" }
  inFlight = true
  try {
    const requestId = createId()
    const timeoutMs = options.connected ? BASE_TIMEOUT_MS + PER_TAB_TIMEOUT_MS * safe.length : NO_EXTENSION_TIMEOUT_MS
    const result = await sendBrowserCommand<{ requestId: string; tabs: RestoreTab[] }, OpenSessionResult>(
      "open_session",
      { requestId, tabs: safe.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })) },
      { timeoutMs }
    )
    if (result.ok) {
      return {
        kind: "opened",
        opened: result.result.opened,
        failed: (result.result.failed ?? []).map(({ url, error }) => ({ url, error })),
      }
    }
    if (result.error === DESKTOP_UNREACHABLE) return openInDefaultBrowser(safe)
    if (isTimeout(result.error)) return options.connected ? { kind: "timeout" } : { kind: "no-extension" }
    if (result.error === "extension-unreachable") return { kind: "no-extension" }
    if (isUnknownAction(result.error)) return legacyOpen(safe)
    return { kind: "failed", message: result.error }
  } finally {
    inFlight = false
  }
}

/**
 * Hubble for Chrome 0.8 and older: `open_tabs` with a new window, which they
 * have always had. Refused before anything opens, so this never runs after
 * tabs were already opened by the newer command.
 */
async function legacyOpen(tabs: readonly RestoreTab[]): Promise<RestoreOutcome> {
  if (tabs.length > LEGACY_MAX_URLS) return { kind: "outdated" }
  const result = await sendBrowserCommand<{ urls: string[]; newWindow: boolean }, OpenTabsResult>(
    "open_tabs",
    { urls: tabs.map((tab) => tab.url), newWindow: true },
    { timeoutMs: BASE_TIMEOUT_MS + PER_TAB_TIMEOUT_MS * tabs.length }
  )
  if (result.ok) return { kind: "opened", opened: result.result.opened.length, failed: result.result.failed ?? [] }
  if (isTimeout(result.error)) return { kind: "timeout" }
  return { kind: "failed", message: result.error }
}

/**
 * Hubble Desktop can't reach Hubble for Chrome (the extension talks to the
 * app, never the other way), but it can open a web page in the default
 * browser — the same validated `open_external` a saved tab uses. So the
 * session's tabs go there, in their saved order, one at a time. No window is
 * created or closed by Hubble; the browser decides where each tab lands.
 */
async function openInDefaultBrowser(tabs: readonly RestoreTab[]): Promise<RestoreOutcome> {
  let opened = 0
  const failed: { url: string; error: string }[] = []
  for (const tab of tabs) {
    try {
      await openExternal(tab.url)
      opened += 1
    } catch (error) {
      failed.push({ url: tab.url, error: error instanceof Error ? error.message : String(error) })
    }
  }
  return { kind: "opened", opened, failed, inBrowser: true }
}

/** Test-only: forget a launch left running by a test. */
export function __resetRestoreForTests(): void {
  inFlight = false
}
