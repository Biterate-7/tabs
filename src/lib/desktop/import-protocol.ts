/**
 * Chrome → Hubble Desktop: the webview's half of the import protocol.
 *
 * The Hubble Chrome extension sends a batch of tabs to Hubble Desktop over a
 * loopback-only bridge that the desktop app itself runs
 * (src-tauri/src/import_bridge.rs). Rust validates the batch and holds it;
 * this side takes it, asks the person which project it goes to, runs it
 * through the one source pipeline every other way in uses
 * (`handleAddSources` → `ingestResources`), and reports back what happened.
 *
 * Constants here are mirrored by hand in extension/src/desktop.js (plain JS,
 * no build step) and in the Rust bridge, the same trade-off
 * src/lib/browser/protocol.ts makes; `import-protocol.test.ts` asserts the
 * copies agree.
 *
 * Nothing in this file touches the network or storage.
 */
import { MAX_INGEST_BATCH, type IngestOutcome } from "@/lib/resources/ingest"
import type { ResourceInput } from "@/lib/resources/types"

/** The wire protocol version. Bumped only with a breaking change. */
export const DESKTOP_PROTOCOL_VERSION = 1

/** One batch at most — the most the import pipeline takes in one go. */
export const MAX_DESKTOP_IMPORT_TABS = MAX_INGEST_BATCH

/** Rust's event when a batch is queued (`REQUESTED_EVENT` in import_bridge.rs). */
export const DESKTOP_IMPORT_REQUESTED_EVENT = "hubble-import:requested"

const MAX_URL_CHARS = 2048
const MAX_TITLE_CHARS = 500

/** A batch waiting for the person, as Rust hands it over (already validated there). */
export type DesktopImportRequest = {
  requestId: string
  tabs: ResourceInput[]
  /** Tabs the extension sent, including any Rust refused. */
  received: number
  /** Tabs Rust refused (not a web address). Reported as couldn't-be-added. */
  rejected: number
  /** When Rust stops waiting for an answer, from when this was read. */
  expiresAt: number
}

/** The person's answer, as Rust records it (`ImportOutcome` in import_bridge.rs). */
export type DesktopImportOutcome =
  | { status: "done"; project: string; added: number; duplicates: number; failed: number }
  | { status: "cancelled"; added: 0; duplicates: 0; failed: 0 }
  | { status: "failed"; added: 0; duplicates: 0; failed: number }

function isWebAddress(raw: unknown): raw is string {
  if (typeof raw !== "string" || raw.length === 0 || raw.length > MAX_URL_CHARS) return false
  try {
    const url = new URL(raw)
    return (url.protocol === "http:" || url.protocol === "https:") && url.hostname.length > 0
  } catch {
    return false
  }
}

/**
 * One request from Rust, re-checked. Rust is the boundary, but the webview
 * does not assume the shape of anything it is handed: a tab that fails here
 * is dropped and counted with Rust's refusals, never imported.
 */
export function readDesktopImportRequest(raw: unknown, now: number): DesktopImportRequest | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== "string" || !/^[A-Za-z0-9-]{8,64}$/.test(value.requestId)) return undefined
  if (!Array.isArray(value.tabs)) return undefined
  const received = Number.isInteger(value.received) ? (value.received as number) : value.tabs.length
  const rejectedByRust = Number.isInteger(value.rejected) ? (value.rejected as number) : 0

  const tabs: ResourceInput[] = []
  for (const entry of value.tabs.slice(0, MAX_DESKTOP_IMPORT_TABS)) {
    const tab = entry as Record<string, unknown> | null
    if (!tab || !isWebAddress(tab.url)) continue
    const title = typeof tab.title === "string" ? tab.title.trim().slice(0, MAX_TITLE_CHARS) : ""
    tabs.push({
      url: tab.url,
      ...(title ? { title } : {}),
      ...(isWebAddress(tab.favicon) ? { favicon: tab.favicon } : {}),
    })
  }
  const expiresInMs = typeof value.expiresInMs === "number" && value.expiresInMs > 0 ? value.expiresInMs : 0
  // Tabs refused here count with the ones Rust refused: every tab sent is accounted for.
  const total = Math.max(received, tabs.length + rejectedByRust)
  if (total === 0) return undefined
  return { requestId: value.requestId, tabs, received: total, rejected: total - tabs.length, expiresAt: now + expiresInMs }
}

/**
 * The answer for a batch that went through the pipeline: the pipeline's own
 * outcomes, plus the tabs that never reached it. "Already a source" is the
 * pipeline's duplicate rule, unchanged — nothing is added twice.
 */
export function outcomeFromIngestion(request: Pick<DesktopImportRequest, "rejected">, outcomes: readonly IngestOutcome[], project: string): DesktopImportOutcome {
  const added = outcomes.filter((outcome) => outcome.status === "added" || outcome.status === "adopted").length
  const duplicates = outcomes.filter((outcome) => outcome.status === "duplicate").length
  const invalid = outcomes.filter((outcome) => outcome.status === "invalid").length
  return { status: "done", project, added, duplicates, failed: invalid + request.rejected }
}
