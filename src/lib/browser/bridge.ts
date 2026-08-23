"use client"

import { createId } from "@/lib/id"
import {
  BROWSER_MESSAGE_SOURCE,
  DEFAULT_BROWSER_COMMAND_TIMEOUT_MS,
  MSG_BROWSER_COMMAND,
  MSG_BROWSER_COMMAND_RESULT,
  MSG_EXTENSION_PING,
  MSG_EXTENSION_PONG,
} from "./protocol"
import type { BrowserActionName, BrowserCommandResult } from "./protocol"

/**
 * The web app's half of the extension messaging bridge — mirrors
 * extension/content/content-script.js's relays exactly. This module never
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
    { source: BROWSER_MESSAGE_SOURCE, type: MSG_EXTENSION_PING, payload: { requestId: createId("ping") } },
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
  opts?: { timeoutMs?: number }
): Promise<BrowserCommandResult<Data>> {
  ensureListening()
  const id = createId("cmd")
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
  if (listenerAttached) {
    window.removeEventListener("message", handleWindowMessage)
    listenerAttached = false
  }
}
