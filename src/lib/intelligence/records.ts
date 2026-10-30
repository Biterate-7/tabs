import { isAiProviderId, providerOfUrl } from "@/lib/providers/registry"
import { sourceKey } from "@/lib/resources/url"
import { isSensitiveUrl } from "./sites"
import { ACTIVITY_KINDS, CAPTURE_GAPS, CAPTURE_STATUSES } from "./types"
import type { ActivityKind, ActivityRecord, CaptureInfo, CaptureStatus } from "./types"

/**
 * Activity records as they cross from the extension into Hubble: re-read
 * with a closed shape, re-keyed by Hubble's own source identity, merged when
 * two of the extension's records turn out to be one page.
 *
 * The extension is trusted to have applied the person's choices; this is the
 * second line. A record that should never have been collected (a sensitive
 * page, a non-web address) or that is malformed is dropped here, never kept.
 */

export const MAX_RECORDS = 300
export const MAX_TERMS = 40
const MAX_TITLE = 300
const MAX_URL = 2000
const MAX_DAYS = 14
const DAY = /^\d{4}-\d{2}-\d{2}$/
const TERM = /^[a-z]{3,30}$/

const finite = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0

function readCapture(value: unknown): CaptureInfo {
  const raw = (value && typeof value === "object" ? value : {}) as Record<string, unknown>
  const status = (CAPTURE_STATUSES as readonly unknown[]).includes(raw.status) ? (raw.status as CaptureStatus) : "metadata"
  const capture: CaptureInfo = { status, method: raw.method === "page-read" ? "page-read" : "tab-metadata" }
  if (finite(raw.readAt)) capture.readAt = raw.readAt
  if (finite(raw.attemptedAt)) capture.attemptedAt = raw.attemptedAt
  if ((CAPTURE_GAPS as readonly unknown[]).includes(raw.gap)) capture.gap = raw.gap as CaptureInfo["gap"]
  if (Number.isInteger(raw.turnCount) && (raw.turnCount as number) >= 0) capture.turnCount = raw.turnCount as number
  if (typeof raw.contentHash === "string" && raw.contentHash.length <= 80) capture.contentHash = raw.contentHash
  // "content" means the page's text was read: claimed by anything but a page read, it is only metadata.
  if ((status === "content" || status === "partial") && capture.method !== "page-read") capture.status = "metadata"
  return capture
}

/** One record from the extension (or from storage), checked. Undefined when it must not be kept. */
export function readActivityRecord(value: unknown): ActivityRecord | undefined {
  if (!value || typeof value !== "object") return undefined
  const raw = value as Record<string, unknown>
  const url = typeof raw.url === "string" ? raw.url.trim() : ""
  if (!url || url.length > MAX_URL || isSensitiveUrl(url)) return undefined
  const key = sourceKey(url)
  if (!key) return undefined
  if (!finite(raw.firstSeenAt) || !finite(raw.lastSeenAt)) return undefined
  let domain: string
  try {
    domain = new URL(url).hostname.toLowerCase().replace(/^www\./, "")
  } catch {
    return undefined
  }
  const kind: ActivityKind = (ACTIVITY_KINDS as readonly unknown[]).includes(raw.kind) ? (raw.kind as ActivityKind) : "webpage"
  // The AI app is decided by the address, never by what a record claims.
  const provider = providerOfUrl(url)
  const capture = readCapture(raw.capture)
  const terms = Array.isArray(raw.terms) ? [...new Set(raw.terms.filter((term): term is string => typeof term === "string" && TERM.test(term)))].slice(0, MAX_TERMS) : []
  const title = typeof raw.title === "string" ? raw.title.replace(/\s+/g, " ").trim().slice(0, MAX_TITLE) : ""
  const favicon = typeof raw.favicon === "string" && /^https?:\/\//i.test(raw.favicon) && raw.favicon.length <= 2000 ? raw.favicon : undefined
  const days = Array.isArray(raw.days) ? [...new Set(raw.days.filter((day): day is string => typeof day === "string" && DAY.test(day)))].sort().slice(-MAX_DAYS) : []
  return {
    key,
    url,
    title,
    domain,
    kind: kind === "conversation" && !provider ? "webpage" : kind,
    ...(provider && isAiProviderId(provider) ? { provider } : {}),
    ...(favicon ? { favicon } : {}),
    firstSeenAt: Math.min(raw.firstSeenAt, raw.lastSeenAt),
    lastSeenAt: raw.lastSeenAt,
    visits: Number.isInteger(raw.visits) && (raw.visits as number) > 0 ? Math.min(raw.visits as number, 10000) : 1,
    dwellMs: finite(raw.dwellMs) ? Math.min(raw.dwellMs, 86_400_000) : 0,
    days,
    open: raw.open === true,
    capture: { ...capture, ...(capture.status === "metadata" && !title ? { status: "detected" as const } : {}) },
    ...(terms.length > 0 && (capture.status === "content" || capture.status === "partial") ? { terms } : {}),
  }
}

const RANK: Record<CaptureStatus, number> = { detected: 0, metadata: 1, unavailable: 1, partial: 2, content: 3 }

/** Two records of one page: the earliest first sight, the latest everything else, the best read. */
export function mergeRecords(a: ActivityRecord, b: ActivityRecord): ActivityRecord {
  const [older, newer] = a.lastSeenAt <= b.lastSeenAt ? [a, b] : [b, a]
  const best = RANK[newer.capture.status] >= RANK[older.capture.status] ? newer : older
  return {
    ...newer,
    title: newer.title || older.title,
    ...(newer.favicon || older.favicon ? { favicon: newer.favicon ?? older.favicon } : {}),
    firstSeenAt: Math.min(a.firstSeenAt, b.firstSeenAt),
    visits: Math.max(a.visits, b.visits),
    dwellMs: Math.max(a.dwellMs, b.dwellMs),
    days: [...new Set([...a.days, ...b.days])].sort().slice(-MAX_DAYS),
    open: a.open || b.open,
    capture: best.capture,
    ...(best.terms ? { terms: best.terms } : {}),
  }
}

/**
 * Folds `incoming` into `existing`: same key → merged, new → added; then the
 * size cap, least recently seen first. Returns the same array when nothing
 * changed, so a pull that brought nothing new renders nothing.
 */
export function upsertRecords(existing: readonly ActivityRecord[], incoming: readonly ActivityRecord[], max = MAX_RECORDS): ActivityRecord[] {
  if (incoming.length === 0) return existing as ActivityRecord[]
  const byKey = new Map(existing.map((record) => [record.key, record]))
  for (const record of incoming) {
    const current = byKey.get(record.key)
    byKey.set(record.key, current ? mergeRecords(current, record) : record)
  }
  const merged = [...byKey.values()].sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, max)
  return merged
}

/** What a resource's capture status says, in words the product uses everywhere. */
export function describeCapture(record: Pick<ActivityRecord, "capture" | "kind">): { label: string; detail: string; complete: boolean } {
  const { status, gap, turnCount } = record.capture
  if (status === "content") return { label: "Read", detail: turnCount ? `${turnCount} messages read` : "Text read", complete: true }
  if (status === "partial") return { label: "Partly read", detail: "Only part of it was on the page", complete: false }
  if (status === "detected") return { label: "Address only", detail: "Only its address is known", complete: false }
  const why =
    gap === "no-permission"
      ? "Chrome hasn't given Hubble access to read it"
      : gap === "not-enabled"
        ? "Reading this app's conversations is off"
        : gap === "layout"
          ? "Hubble couldn't recognise this page's layout"
          : gap === "empty"
            ? "No messages were on the page yet"
            : gap === "read-failed"
              ? "Hubble couldn't read the page"
              : gap === "not-readable"
                ? "Hubble can't read this kind of document"
                : record.kind === "conversation"
                  ? "Only its title and address are known"
                  : "Title and address; its text is read once it's saved"
  return { label: status === "unavailable" ? "Couldn't read" : "Title only", detail: why, complete: false }
}

/**
 * Whether accepting a suggestion can save this conversation's text: its tab
 * is open and the extension could read it (so Chrome granted the access).
 * Anything else is saved as a link that asks for its text.
 */
export function willSaveText(record: Pick<ActivityRecord, "kind" | "open" | "capture">): boolean {
  return record.kind === "conversation" && record.open && (record.capture.status === "content" || record.capture.status === "partial")
}
