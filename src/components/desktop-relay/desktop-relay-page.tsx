"use client"

import { useEffect, useRef, useState, type ReactNode } from "react"
import { BrandMark } from "@/components/brand-mark"
import { Button } from "@/components/ui/button"
import { sendBrowserCommand } from "@/lib/browser/bridge"
import { DECLINED_MESSAGE } from "@/lib/browser/desktop-relay"
import type { BrowserTabInfo, BrowserWindowInfo, HistoryVisitItem } from "@/lib/browser/protocol"
import { EXTENSION_DOWNLOAD_URL } from "@/lib/extension-config"

/**
 * `/desktop/relay` — Hubble Desktop asking Chrome something, answered here
 * (src-tauri/src/import_bridge.rs, "The relay").
 *
 * The app opened this page with a one-time id and secret in the fragment,
 * which never reaches a server. The page says exactly what is asked; only
 * when the person presses Send does it read Chrome — through Hubble for
 * Chrome's existing read commands, as Hubble on the web does — and hand the
 * answer to the app with the extension's `deliver_to_desktop`. Don't send
 * tells the app no, and reads nothing.
 */

const PORTS = [41517, 41518, 41519]
type Action = "browser_tabs" | "history"
type Relay = { id: string; secret: string; port: number; action: Action; history?: { startTime: number; endTime?: number; maxResults?: number } }
type Phase = { kind: "asking" } | { kind: "sending" } | { kind: "sent" } | { kind: "declined" } | { kind: "failed"; message: string; update?: boolean }

function base64urlJson(value: string): unknown {
  try {
    const padded = value.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((value.length + 3) % 4)
    return JSON.parse(atob(padded))
  } catch {
    return null
  }
}

/** The relay in the fragment, or null when it isn't one Hubble Desktop made. */
export function readRelay(hash: string): Relay | null {
  const params = new URLSearchParams(hash.replace(/^#/, ""))
  const id = params.get("id") ?? ""
  const secret = params.get("secret") ?? ""
  const port = Number(params.get("port"))
  const action = params.get("action")
  if (!/^[0-9a-f]{32}$/.test(id) || !/^[0-9a-f]{64}$/.test(secret) || !PORTS.includes(port)) return null
  if (action === "browser_tabs") return { id, secret, port, action }
  if (action !== "history") return null
  const args = base64urlJson(params.get("args") ?? "") as Record<string, unknown> | null
  const startTime = args?.startTime
  const endTime = args?.endTime
  const maxResults = args?.maxResults
  if (typeof startTime !== "number" || !Number.isFinite(startTime) || startTime < 0) return null
  if (endTime !== undefined && (typeof endTime !== "number" || endTime < startTime)) return null
  if (maxResults !== undefined && (typeof maxResults !== "number" || !Number.isInteger(maxResults) || maxResults < 1)) return null
  return {
    id,
    secret,
    port,
    action,
    history: { startTime, ...(typeof endTime === "number" ? { endTime } : {}), ...(typeof maxResults === "number" ? { maxResults } : {}) },
  }
}

function describe(relay: Relay): { title: string; detail: string } {
  if (relay.action === "browser_tabs") {
    return {
      title: "Send your open tabs to Hubble Desktop?",
      detail: "Hubble Desktop is asking for the tabs open in Chrome: each tab's title and address. Private windows are never included.",
    }
  }
  const fmt = (ms: number) => new Date(ms).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" })
  const range = relay.history!
  return {
    title: "Send your Chrome history to Hubble Desktop?",
    detail: `Hubble Desktop is asking for the pages you visited from ${fmt(range.startTime)} to ${fmt(range.endTime ?? Date.now())}: their titles and addresses. You choose what to keep in the app.`,
  }
}

/** Hubble's own tabs (this one included) are left out, as Save current session does on the web. */
async function readChrome(relay: Relay): Promise<{ ok: true; result: Record<string, unknown> } | { ok: false; error: string }> {
  if (relay.action === "browser_tabs") {
    const [tabs, windows] = await Promise.all([
      sendBrowserCommand<Record<string, never>, { tabs: BrowserTabInfo[] }>("list_browser_tabs", {}, { timeoutMs: 5000 }),
      sendBrowserCommand<Record<string, never>, { windows: BrowserWindowInfo[] }>("list_browser_windows", {}, { timeoutMs: 5000 }),
    ])
    if (!tabs.ok) return { ok: false, error: tabs.error }
    if (!windows.ok) return { ok: false, error: windows.error }
    return { ok: true, result: { tabs: tabs.result.tabs, windows: windows.result.windows, origin: window.location.origin } }
  }
  const history = await sendBrowserCommand<NonNullable<Relay["history"]>, { items: HistoryVisitItem[] }>("get_history", relay.history!, { timeoutMs: 20000 })
  return history.ok ? { ok: true, result: { items: history.result.items } } : { ok: false, error: history.error }
}

async function deliver(relay: Relay, answer: { ok: true; result: Record<string, unknown> } | { ok: false; error: string }) {
  return sendBrowserCommand("deliver_to_desktop", { port: relay.port, id: relay.id, secret: relay.secret, action: relay.action, ...answer }, { timeoutMs: 20000 })
}

function explain(error: string): { message: string; update?: boolean } {
  if (/unknown or disallowed browser action/i.test(error)) return { message: "Update Hubble for Chrome to answer Hubble Desktop.", update: true }
  if (/extension-unreachable|timed out/i.test(error)) return { message: "Hubble for Chrome isn't installed or turned on in this browser.", update: true }
  return { message: error }
}

export function DesktopRelayPage() {
  const [relay, setRelay] = useState<Relay | null | undefined>(undefined)
  const [phase, setPhase] = useState<Phase>({ kind: "asking" })
  // Read once: the fragment is cleared right after, and an effect can run twice.
  const read = useRef<Relay | null | undefined>(undefined)

  useEffect(() => {
    if (read.current === undefined) {
      read.current = readRelay(window.location.hash)
      // The secret has done its job once read: keep it out of the address bar and history.
      window.history.replaceState(null, "", window.location.pathname)
    }
    // eslint-disable-next-line react-hooks/set-state-in-effect -- the fragment is only readable in the browser
    setRelay(read.current)
  }, [])

  async function send() {
    if (!relay) return
    setPhase({ kind: "sending" })
    const answer = await readChrome(relay)
    const delivered = await deliver(relay, answer)
    if (!delivered.ok) {
      setPhase({ kind: "failed", ...explain(delivered.error) })
      return
    }
    if (!answer.ok) {
      setPhase({ kind: "failed", ...explain(answer.error) })
      return
    }
    setPhase({ kind: "sent" })
  }

  async function decline() {
    if (!relay) return
    setPhase({ kind: "sending" })
    await deliver(relay, { ok: false, error: DECLINED_MESSAGE })
    setPhase({ kind: "declined" })
  }

  return (
    <main className="flex min-h-screen items-center justify-center bg-background px-4 py-16">
      <div className="w-full max-w-md rounded-lg border border-border bg-card px-6 py-6">
        <span className="flex items-center gap-2 text-foreground">
          <BrandMark />
          <span className="text-body font-medium tracking-tight">Hubble</span>
        </span>
        {relay === undefined ? null : relay === null ? (
          <Body title="This link isn't complete">Ask again from Hubble Desktop.</Body>
        ) : phase.kind === "sent" ? (
          <Body title="Sent to Hubble Desktop">Switch back to the app. You can close this tab.</Body>
        ) : phase.kind === "declined" ? (
          <Body title="Nothing was sent">You can close this tab.</Body>
        ) : (
          <Body title={describe(relay).title}>
            <span className="block">{describe(relay).detail}</span>
            {phase.kind === "failed" && (
              <span role="alert" className="mt-3 block text-body-sm text-destructive">
                {phase.message}{" "}
                {phase.update && (
                  <a className="text-link underline-offset-4 hover:underline" href={EXTENSION_DOWNLOAD_URL} download>
                    Get Hubble for Chrome
                  </a>
                )}
              </span>
            )}
            <span className="mt-5 flex justify-end gap-2">
              <Button type="button" variant="ghost" disabled={phase.kind === "sending"} onClick={() => void decline()}>
                Don&rsquo;t send
              </Button>
              <Button type="button" disabled={phase.kind === "sending"} onClick={() => void send()}>
                {phase.kind === "sending" ? "Sending…" : "Send to Hubble Desktop"}
              </Button>
            </span>
          </Body>
        )}
      </div>
    </main>
  )
}

function Body({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="mt-5">
      <h1 className="text-h1 text-foreground">{title}</h1>
      <div className="mt-2 text-body text-muted-foreground">{children}</div>
    </div>
  )
}
