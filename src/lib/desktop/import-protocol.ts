/**
 * Chrome → Hubble Desktop: the webview's half of the import protocol.
 *
 * The Hubble Chrome extension sends Hubble Desktop either a batch of tabs or
 * one AI conversation it read from ChatGPT, Claude, Gemini or Perplexity,
 * over a loopback-only bridge that the desktop app itself runs
 * (src-tauri/src/import_bridge.rs). Rust validates the request and holds it;
 * this side takes it, asks the person which project it goes to, saves it the
 * way every other door in does — tabs through the one source pipeline
 * (`handleAddSources` → `ingestResources`), a conversation through the
 * shell's one conversation save (the one Hubble on the web uses for the
 * extension's Save) — and reports back what happened.
 *
 * The bridge only ever carries things *in*. Nothing here answers with a
 * project, a search or saved text: any local program can forge the
 * extension's `Origin`, so a read over the bridge would let data out without
 * the person's say-so.
 *
 * Constants here are mirrored by hand in extension/src/desktop.js (plain JS,
 * no build step) and in the Rust bridge, the same trade-off
 * src/lib/browser/protocol.ts makes; `import-protocol.test.ts` asserts the
 * copies agree.
 *
 * Nothing in this file touches the network or storage.
 */
import { readConversationCapture } from "@/lib/conversations/capture"
import { CONVERSATION_LIMITS, type ConversationInput } from "@/lib/conversations/types"
import { MAX_INGEST_BATCH, type IngestOutcome } from "@/lib/resources/ingest"
import type { ResourceInput } from "@/lib/resources/types"

/** The wire protocol version. Bumped only with a breaking change. */
export const DESKTOP_PROTOCOL_VERSION = 1

/** What the bridge takes (`PAYLOAD_KINDS`); `/v1/hello` lists them for the extension. */
export const DESKTOP_PAYLOAD_KINDS = ["tabs", "conversation"] as const

/** One batch at most — the most the import pipeline takes in one go. */
export const MAX_DESKTOP_IMPORT_TABS = MAX_INGEST_BATCH

/** One conversation at most what Hubble keeps of one (`CONVERSATION_LIMITS`). */
export const MAX_DESKTOP_CONVERSATION_TURNS = CONVERSATION_LIMITS.turns
export const MAX_DESKTOP_TURN_CHARS = CONVERSATION_LIMITS.turnText
export const MAX_DESKTOP_CONVERSATION_CHARS = CONVERSATION_LIMITS.totalChars

/** Rust's event when a request is queued (`REQUESTED_EVENT` in import_bridge.rs). */
export const DESKTOP_IMPORT_REQUESTED_EVENT = "hubble-import:requested"

const MAX_URL_CHARS = 2048
const MAX_TITLE_CHARS = 500
const REQUEST_ID = /^[A-Za-z0-9-]{8,64}$/

/** A batch of tabs waiting for the person, as Rust hands it over (already validated there). */
export type DesktopTabsRequest = {
  kind: "tabs"
  requestId: string
  tabs: ResourceInput[]
  /** Tabs the extension sent, including any Rust refused. */
  received: number
  /** Tabs Rust refused (not a web address). Reported as couldn't-be-added. */
  rejected: number
  /** When Rust stops waiting for an answer, from when this was read. */
  expiresAt: number
}

/** One conversation waiting for the person, re-read the way a capture on the web is. */
export type DesktopConversationRequest = {
  kind: "conversation"
  requestId: string
  conversation: ConversationInput
  /** Very long: the extension or this side kept only the first part. */
  truncated: boolean
  expiresAt: number
}

export type DesktopImportRequest = DesktopTabsRequest | DesktopConversationRequest

/**
 * One entry from Rust, read: a request to put in front of the person, or one
 * with nothing in it worth asking about — answered "failed" at once, never
 * shown as an empty choice.
 */
export type DesktopImportRead = { ok: true; request: DesktopImportRequest } | { ok: false; requestId: string; failed: number }

/** What saving a conversation did (`CaptureSaveResult` in use-extension-memory.ts; `SAVE_OUTCOMES` in Rust). */
export type DesktopConversationSaved = "added" | "updated" | "unchanged" | "kept"

/** The person's answer, as Rust records it (`ImportOutcome` in import_bridge.rs). */
export type DesktopImportOutcome =
  | { status: "done"; project: string; added: number; duplicates: number; failed: number }
  | { status: "done"; project: string; saved: DesktopConversationSaved; turns: number; truncated: boolean }
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

function readTabs(value: Record<string, unknown>, requestId: string, expiresAt: number): DesktopImportRead | undefined {
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
  // Tabs refused here count with the ones Rust refused: every tab sent is accounted for.
  const total = Math.max(received, tabs.length + rejectedByRust)
  if (total === 0) return undefined
  if (tabs.length === 0) return { ok: false, requestId, failed: total }
  return { ok: true, request: { kind: "tabs", requestId, tabs, received: total, rejected: total - tabs.length, expiresAt } }
}

/**
 * A conversation goes through `readConversationCapture`, exactly as one the
 * extension hands Hubble on the web does: the provider comes from the
 * address (never from what the payload claims), an address that isn't one
 * AI-app conversation is refused, turns are a closed shape, and text is
 * cleaned and bounded.
 */
function readConversation(value: Record<string, unknown>, requestId: string, expiresAt: number): DesktopImportRead {
  const capture = readConversationCapture({ url: value.url, title: typeof value.title === "string" ? value.title : undefined, turns: value.turns })
  if (!capture.ok) return { ok: false, requestId, failed: 0 }
  return {
    ok: true,
    request: { kind: "conversation", requestId, conversation: capture.conversation, truncated: capture.truncated || value.truncated === true, expiresAt },
  }
}

/**
 * One request from Rust, re-checked. Rust is the boundary, but the webview
 * does not assume the shape of anything it is handed: a tab that fails here
 * is dropped and counted with Rust's refusals, never imported; a
 * conversation that fails here is answered "failed", never saved.
 */
export function readDesktopImportRequest(raw: unknown, now: number): DesktopImportRead | undefined {
  if (!raw || typeof raw !== "object") return undefined
  const value = raw as Record<string, unknown>
  if (typeof value.requestId !== "string" || !REQUEST_ID.test(value.requestId)) return undefined
  const expiresInMs = typeof value.expiresInMs === "number" && value.expiresInMs > 0 ? value.expiresInMs : 0
  const expiresAt = now + expiresInMs
  if (value.kind === "conversation") return readConversation(value, value.requestId, expiresAt)
  if (value.kind === undefined || value.kind === "tabs") return readTabs(value, value.requestId, expiresAt)
  return undefined
}

/**
 * The answer for a batch that went through the pipeline: the pipeline's own
 * outcomes, plus the tabs that never reached it. "Already a source" is the
 * pipeline's duplicate rule, unchanged — nothing is added twice.
 */
export function outcomeFromIngestion(request: Pick<DesktopTabsRequest, "rejected">, outcomes: readonly IngestOutcome[], project: string): DesktopImportOutcome {
  const added = outcomes.filter((outcome) => outcome.status === "added" || outcome.status === "adopted").length
  const duplicates = outcomes.filter((outcome) => outcome.status === "duplicate").length
  const invalid = outcomes.filter((outcome) => outcome.status === "invalid").length
  return { status: "done", project, added, duplicates, failed: invalid + request.rejected }
}
