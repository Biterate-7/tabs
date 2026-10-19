"use client"

import { BROWSER_MESSAGE_SOURCE, MSG_EXTENSION_PING, MSG_EXTENSION_PONG } from "@/lib/browser/protocol"
import { isDesktop } from "@/lib/platform/detect"
import {
  AI_TRANSFER_PROTOCOL,
  checkTransferRequest,
  MSG_AI_TRANSFER,
  MSG_AI_TRANSFER_HELLO,
  MSG_AI_TRANSFER_HELLO_RESULT,
  MSG_AI_TRANSFER_PROGRESS,
  MSG_AI_TRANSFER_RESULT,
  newOpId,
  readTransferProgress,
  readTransferResult,
} from "./protocol"
import type { TransferRequest, TransferResult, TransferState } from "./protocol"

/**
 * The page's half of Use in AI's transport: ask Hubble for Chrome whether it
 * can transfer, hand it one transfer, and follow its progress.
 *
 * Every failure is a value (`{ ok: false, error }`), never a throw — like
 * src/lib/browser/bridge.ts, which this mirrors. Messages go to and come
 * from this window only (same origin, same window): the content script is
 * the only thing that can answer, and it runs only on Hubble's own origin.
 */

/** How long the content script has to say it is there. It answers on its own, without the background. */
const HELLO_TIMEOUT_MS = 1500
/**
 * Silence that ends a transfer. Longer than the extension's longest quiet
 * step — waiting for the person to answer the permission window (two
 * minutes) — so a slow person is never reported as a failure.
 */
const QUIET_TIMEOUT_MS = 150_000

export type TransferSupport = { available: true } | { available: false; reason: "desktop" | "no-extension" | "extension-outdated" }

function post(type: string, payload: unknown) {
  window.postMessage({ source: BROWSER_MESSAGE_SOURCE, type, payload }, window.location.origin)
}

function fromThisPage(event: MessageEvent): { type?: unknown; payload?: unknown } | undefined {
  if (event.origin !== window.location.origin || event.source !== window) return undefined
  const data = event.data as { source?: unknown; type?: unknown; payload?: unknown } | null
  return data && data.source === BROWSER_MESSAGE_SOURCE ? data : undefined
}

/**
 * Whether Hubble for Chrome is here and new enough to transfer. The
 * extension's ping (which every version answers) tells an older extension
 * apart from none.
 */
export function detectTransferSupport(): Promise<TransferSupport> {
  if (isDesktop()) return Promise.resolve({ available: false, reason: "desktop" })
  const requestId = newOpId()
  let present = false
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      window.removeEventListener("message", onMessage)
      resolve({ available: false, reason: present ? "extension-outdated" : "no-extension" })
    }, HELLO_TIMEOUT_MS)
    function onMessage(event: MessageEvent) {
      const data = fromThisPage(event)
      if (!data) return
      if (data.type === MSG_EXTENSION_PONG) {
        present = true
        return
      }
      if (data.type !== MSG_AI_TRANSFER_HELLO_RESULT) return
      const payload = data.payload as { requestId?: unknown; protocol?: unknown } | undefined
      if (payload?.requestId !== requestId) return
      clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      resolve(payload.protocol === AI_TRANSFER_PROTOCOL ? { available: true } : { available: false, reason: "extension-outdated" })
    }
    window.addEventListener("message", onMessage)
    post(MSG_EXTENSION_PING, { requestId })
    post(MSG_AI_TRANSFER_HELLO, { requestId })
  })
}

/**
 * Hands one transfer to the extension and resolves with its result.
 * `onProgress` hears each state the extension reports, in order.
 */
export function sendTransfer(request: TransferRequest, onProgress?: (state: TransferState) => void): Promise<TransferResult> {
  const checked = checkTransferRequest(request)
  if (!checked) return Promise.resolve({ opId: request.opId, ok: false, error: "invalid" })
  if (isDesktop()) return Promise.resolve({ opId: request.opId, ok: false, error: "no-extension" })
  const { opId } = checked
  return new Promise((resolve) => {
    let timer: ReturnType<typeof setTimeout>
    const quiet = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish({ opId, ok: false, error: "timeout" }), QUIET_TIMEOUT_MS)
    }
    function finish(result: TransferResult) {
      clearTimeout(timer)
      window.removeEventListener("message", onMessage)
      resolve(result)
    }
    function onMessage(event: MessageEvent) {
      const data = fromThisPage(event)
      if (!data) return
      if (data.type === MSG_AI_TRANSFER_PROGRESS) {
        const progress = readTransferProgress(data.payload)
        if (progress?.opId !== opId) return
        quiet()
        onProgress?.(progress.state)
        return
      }
      if (data.type === MSG_AI_TRANSFER_RESULT) {
        const payload = data.payload as { opId?: unknown } | undefined
        if (payload?.opId !== opId) return
        finish(readTransferResult(opId, payload))
      }
    }
    window.addEventListener("message", onMessage)
    quiet()
    post(MSG_AI_TRANSFER, checked)
  })
}

/** Bytes as base64, off the main thread's hot path (the browser encodes it), so a large file doesn't freeze the dialog. */
export function bytesToBase64(bytes: ArrayBuffer | Uint8Array, type = "application/octet-stream"): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(reader.error ?? new Error("read failed"))
    reader.onload = () => {
      const url = String(reader.result ?? "")
      const comma = url.indexOf(",")
      resolve(comma === -1 ? "" : url.slice(comma + 1))
    }
    reader.readAsDataURL(new Blob([bytes as BlobPart], { type }))
  })
}
