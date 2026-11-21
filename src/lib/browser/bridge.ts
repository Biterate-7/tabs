"use client"

import { createId } from "@/lib/id"
import { desktopExtensionLink } from "@/lib/platform/desktop"
import { isDesktop } from "@/lib/platform/detect"
import {
  BROWSER_MESSAGE_SOURCE,
  DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
  DESKTOP_UNREACHABLE,
  MSG_BROWSER_COMMAND,
  MSG_BROWSER_COMMAND_RESULT,
  MSG_EXTENSION_PING,
  MSG_EXTENSION_PONG,
} from "./protocol"
import type { BrowserActionName, BrowserCommandResult } from "./protocol"

/**
 * Hubble's half of the extension messaging bridge.
 *
 * Inside Hubble Desktop (the product) a command travels over the paired link:
 * Rust queues it, the paired Hubble for Chrome collects it, validates it again
 * (extension/src/browser-commands.js) and answers ("Commands from Hubble" in
 * src-tauri/src/extension_link.rs). "Connected" there means "a Hubble for
 * Chrome is paired". A command the person just asked for may wake Chrome; one
 * Hubble sends by itself (`background`) never does.
 *
 * Outside it — the website's own pages that still talk to the extension
 * (/desktop/connect), and jsdom tests — it is the page bridge, which
 * mirrors extension/content/content-script.js's relays exactly. This module never
 * touches `chrome.*` (it can't; only the extension has that access) and
 * never imports anything from src/lib/actions — it is pure transport, kept
 * intentionally dumb so the *typed, validated* meaning of a command lives in
 * exactly one place on each side (src/lib/actions/browser-*.ts here,
 * extension/src/browser-commands.js there).
 *
 * A module-level singleton (not a React hook) on purpose: the pending-request
 * map and connection state must survive independently of whichever component
 * happens to be mounted, and there must only ever be one `message` listener
 * attached, matching the "attach once" idiom already used by
 * useExtensionImport/useExtensionWorkspaceQuery.
 */

const PING_INTERVAL_MS = 4000
/** Longer than PING_INTERVAL_MS so one dropped pong doesn't flap the indicator. */
const STALE_AFTER_MS = 9000

type PendingCommand = {
  resolve: (result: BrowserCommandResult) => void
  timer: ReturnType<typeof setTimeout>
}

const pending = new Map<string, PendingCommand>()
const connectionListeners = new Set<(connected: boolean) => void>()

let connected = false
let lastPongAt = 0
let listenerAttached = false
let pingTimer: ReturnType<typeof setInterval> | null = null
let staleCheckTimer: ReturnType<typeof setInterval> | null = null

function setConnected(next: boolean) {
  if (connected === next) return
  connected = next
  for (const listener of connectionListeners) listener(connected)
}

function handleWindowMessage(event: MessageEvent) {
  if (event.origin !== window.location.origin) return
  if (event.source !== window) return

  const data = event.data as { source?: unknown; type?: unknown; payload?: unknown } | null
  if (!data || data.source !== BROWSER_MESSAGE_SOURCE) return

  if (data.type === MSG_EXTENSION_PONG) {
    lastPongAt = Date.now()
    setConnected(true)
    return
  }

  if (data.type === MSG_BROWSER_COMMAND_RESULT) {
    const result = data.payload as BrowserCommandResult | undefined
    if (!result || typeof result.id !== "string") return
    const entry = pending.get(result.id)
    if (!entry) return
    pending.delete(result.id)
    clearTimeout(entry.timer)
    entry.resolve(result)
  }
}

/** Idempotent — safe to call from every mount of useBrowserConnection. */
function ensureListening() {
  if (listenerAttached) return
  listenerAttached = true
  window.addEventListener("message", handleWindowMessage)
}

function postPing() {
  window.postMessage(
    { source: BROWSER_MESSAGE_SOURCE, type: MSG_EXTENSION_PING, payload: { requestId: createId() } },
    window.location.origin
  )
}

/**
 * Starts (once — later calls are no-ops while already running) the ping
 * loop that both discovers a newly-installed/enabled extension and detects
 * one going away. Returns a stop function; the last caller to stop it tears
 * the interval down, since useBrowserConnection may be mounted more than
 * once (e.g. the indicator and the ask panel both watching connection state).
 */
let watchRefCount = 0
export function startConnectionWatch(): () => void {
  if (isDesktop()) return startDesktopLinkWatch()
  ensureListening()
  watchRefCount += 1

  if (!pingTimer) {
    postPing()
    pingTimer = setInterval(postPing, PING_INTERVAL_MS)
  }
  if (!staleCheckTimer) {
    staleCheckTimer = setInterval(() => {
      if (connected && Date.now() - lastPongAt > STALE_AFTER_MS) setConnected(false)
    }, PING_INTERVAL_MS)
  }

  return () => {
    watchRefCount -= 1
    if (watchRefCount > 0) return
    if (pingTimer) clearInterval(pingTimer)
    if (staleCheckTimer) clearInterval(staleCheckTimer)
    pingTimer = null
    staleCheckTimer = null
  }
}

/** How often Hubble Desktop re-reads whether an extension is paired (pairing and Disconnect happen in this window, or in Chrome). */
const DESKTOP_LINK_POLL_MS = 5000
let desktopWatchRefCount = 0
let desktopWatchTimer: ReturnType<typeof setInterval> | null = null

function checkDesktopLink() {
  desktopExtensionLink
    .paired()
    .then((paired) => setConnected(paired))
    .catch(() => setConnected(false))
}

function startDesktopLinkWatch(): () => void {
  desktopWatchRefCount += 1
  if (!desktopWatchTimer) {
    checkDesktopLink()
    desktopWatchTimer = setInterval(checkDesktopLink, DESKTOP_LINK_POLL_MS)
  }
  return () => {
    desktopWatchRefCount -= 1
    if (desktopWatchRefCount > 0) return
    if (desktopWatchTimer) clearInterval(desktopWatchTimer)
    desktopWatchTimer = null
  }
}

/** The link's answers that mean "no Hubble for Chrome answered": callers fall back exactly as when the extension isn't there. */
const DESKTOP_NO_EXTENSION = new Set(["not-paired", "extension-unreachable"])
/** Waking Chrome may start the extension's worker first: a command the person asked for gets at least this long. */
const DESKTOP_WAKE_MIN_TIMEOUT_MS = 12000
/** A background command waits briefly by default: an awake extension collects at once, an asleep one is not woken. */
const DESKTOP_BACKGROUND_TIMEOUT_MS = 3000

async function sendDesktopCommand<Data>(id: string, action: BrowserActionName, args: unknown, opts?: BrowserCommandOptions): Promise<BrowserCommandResult<Data>> {
  const background = opts?.background === true
  const timeoutMs = background
    ? (opts?.timeoutMs ?? DESKTOP_BACKGROUND_TIMEOUT_MS)
    : Math.max(opts?.timeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS, DESKTOP_WAKE_MIN_TIMEOUT_MS)
  const answer = await desktopExtensionLink.command(action, args ?? {}, { timeoutMs, wake: !background })
  if (answer.ok) return { id, ok: true, result: answer.result as Data }
  if (DESKTOP_NO_EXTENSION.has(answer.error)) return { id, ok: false, error: DESKTOP_UNREACHABLE }
  if (answer.error === "timed-out") return { id, ok: false, error: "Timed out waiting for the browser extension to respond." }
  return { id, ok: false, error: answer.error }
}

export type BrowserCommandOptions = {
  timeoutMs?: number
  /**
   * Hubble is asking by itself (title lookup, context detection's pull), not
   * because the person just did something. In Hubble Desktop such a command
   * never wakes Chrome: it is answered only if the extension is awake.
   */
  background?: boolean
}

export function subscribeConnection(listener: (connected: boolean) => void): () => void {
  connectionListeners.add(listener)
  return () => connectionListeners.delete(listener)
}

export function isBrowserConnected(): boolean {
  return connected
}

/**
 * Sends one typed command to the extension and resolves with its typed
 * result — this never rejects/throws (matching askQuestion's "every failure
 * is a value" convention): a missing extension, a malformed response, or a
 * timeout all come back as `{ ok: false, error }` with the same `id` so
 * callers don't need a separate try/catch path for "the bridge itself
 * failed" vs. "the command failed."
 */
export function sendBrowserCommand<Args, Data>(
  action: BrowserActionName,
  args: Args,
  opts?: BrowserCommandOptions
): Promise<BrowserCommandResult<Data>> {
  const id = createId()
  if (isDesktop()) return sendDesktopCommand<Data>(id, action, args, opts)
  ensureListening()
  const timeoutMs = opts?.timeoutMs ?? DEFAULT_BROWSER_COMMAND_TIMEOUT_MS

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id)
      resolve({ id, ok: false, error: "Timed out waiting for the browser extension to respond." })
    }, timeoutMs)

    pending.set(id, { resolve: resolve as (result: BrowserCommandResult) => void, timer })

    window.postMessage(
      { source: BROWSER_MESSAGE_SOURCE, type: MSG_BROWSER_COMMAND, payload: { id, action, args } },
      window.location.origin
    )
  })
}

/** Test-only escape hatch — resets the module singleton between test files. */
export function __resetBrowserBridgeForTests(): void {
  for (const entry of pending.values()) clearTimeout(entry.timer)
  pending.clear()
  connectionListeners.clear()
  connected = false
  lastPongAt = 0
  if (pingTimer) clearInterval(pingTimer)
  if (staleCheckTimer) clearInterval(staleCheckTimer)
  pingTimer = null
  staleCheckTimer = null
  watchRefCount = 0
  if (desktopWatchTimer) clearInterval(desktopWatchTimer)
  desktopWatchTimer = null
  desktopWatchRefCount = 0
  if (listenerAttached) {
    window.removeEventListener("message", handleWindowMessage)
    listenerAttached = false
  }
}
