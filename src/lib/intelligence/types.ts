import type { AiProviderId } from "@/lib/providers/registry"

/**
 * Context intelligence: Hubble noticing the work a person does in Chrome —
 * AI conversations, research pages, documents — and offering to keep it in
 * the right project, so they spend less time organizing and less time
 * reconstructing where they were.
 *
 *   Detect ─► Understand ─► Connect ─► Suggest ─► Confirm ─► Preserve ─► Resume
 *   extension  features.ts   match.ts   suggest.ts  the person  ingestResources  resume.ts
 *   activity   (topic words) cluster.ts            (review)   + capture queue   + sessions
 *
 * ## Not a second model
 *
 * Nothing here is a project, a source or a session. An activity record is a
 * note that Chrome showed a page; when the person accepts a suggestion its
 * pages go through `ingestResources` like every other add and become ordinary
 * sources, and a conversation's text arrives through the existing Save to
 * Hubble pipeline. Resume opens the project and reuses saved sessions.
 *
 * ## Honest status
 *
 * A record says exactly how much Hubble knows (`CaptureStatus`): an address
 * and title Chrome reported is `metadata`; text is `content` only when the
 * extension read the page with the person's permission, and `partial` when
 * only part of it was on the page. A record never carries the text itself —
 * only topic words derived from it — so a conversation's text is stored in
 * one place: the project it was saved to.
 */

export const CONTEXT_SCHEMA_VERSION = 1

export type ActivityKind = "conversation" | "document" | "article" | "video" | "pdf" | "webpage"
export const ACTIVITY_KINDS: readonly ActivityKind[] = ["conversation", "document", "article", "video", "pdf", "webpage"] as const

/**
 *   detected     an address only (the page never reported a title)
 *   metadata     address and title — what Chrome reports for any tab
 *   content      its text was read, with permission, and described by topic words
 *   partial      text read, but only part of it was on the page
 *   unavailable  a read was tried and did not succeed: still metadata only
 */
export type CaptureStatus = "detected" | "metadata" | "content" | "partial" | "unavailable"
export const CAPTURE_STATUSES: readonly CaptureStatus[] = ["detected", "metadata", "content", "partial", "unavailable"] as const

/** Why a page's text was not read. */
export type CaptureGap =
  /** Chrome has not granted Hubble access to this site. */
  | "no-permission"
  /** Reading this app's conversations is switched off in Settings. */
  | "not-enabled"
  /** The page's layout wasn't recognised. */
  | "layout"
  /** No messages were on the page yet. */
  | "empty"
  /** Reading the page failed. */
  | "read-failed"
  /** Hubble has no way to read this kind of page (a Google Doc). */
  | "not-readable"
export const CAPTURE_GAPS: readonly CaptureGap[] = ["no-permission", "not-enabled", "layout", "empty", "read-failed", "not-readable"] as const

export type CaptureInfo = {
  status: CaptureStatus
  /** How what Hubble knows arrived: what Chrome reports about a tab, or the extension reading the page. */
  method: "tab-metadata" | "page-read"
  /** The last successful read of the page's text. */
  readAt?: number
  /** The last read attempt, successful or not. */
  attemptedAt?: number
  gap?: CaptureGap
  /** A conversation's messages when it was read. */
  turnCount?: number
  /** Over the text that was read: tells a changed conversation from one read again unchanged. */
  contentHash?: string
}

export type ActivityRecord = {
  /** The source identity (`sourceKey`): one record per page, however many times Chrome reports it. */
  key: string
  url: string
  title: string
  domain: string
  kind: ActivityKind
  provider?: AiProviderId
  /** Chrome's icon for the page, http(s) only. */
  favicon?: string
  firstSeenAt: number
  lastSeenAt: number
  /** Separate visits: activations at least `VISIT_GAP_MS` apart. */
  visits: number
  /** Approximate time the tab was in front, capped per visit. */
  dwellMs: number
  /** Local calendar days ("2026-10-28") it was used on, oldest first, bounded. */
  days: string[]
  /** Open in Chrome at the last sync. */
  open: boolean
  capture: CaptureInfo
  /** Topic words read from the page's text — never the text — when it was read. */
  terms?: string[]
}

/** The person put this page in this project: confirmed, never overridden by inference. */
export type Association = { key: string; workspaceId: string; at: number; by: "accepted" | "moved" }

/**
 * The person said a suggestion was wrong.
 *   a project id    — not this project
 *   "new-project"   — not a project of its own
 *   "any"           — not relevant to anything: never suggested again
 */
export type Rejection = {
  key: string
  target: string
  at: number
  /** The page's strongest topic words when it was rejected, so similar pages are trusted less for that target too. */
  terms?: string[]
}
export const REJECT_NEW_PROJECT = "new-project"
export const REJECT_ANY = "any"

export type SuggestionKind = "save-to-project" | "create-project"
export type SuggestionStatus = "open" | "accepted" | "dismissed" | "snoozed" | "expired"

export type SuggestionDestination = { kind: "project"; workspaceId: string } | { kind: "new-project"; name: string }

export type ConfidenceBand = "strong" | "review"

/** What a suggestion rests on — only ever facts about the pages and the project. */
export type Evidence = {
  /** Topic words the pages share with each other or with the project, display spellings, strongest first. */
  sharedTerms: string[]
  /** Words of the project's own name the pages use. */
  nameTerms: string[]
  /** Distinct days the pages were used on. */
  days: number
  /** Whether any page's text (not just its title) contributed. */
  fromContent: boolean
  /** 0..1, each. */
  semantic: number
  temporal: number
  /** How much the person's earlier corrections lowered it (0 = none). */
  feedbackPenalty: number
}

export type Suggestion = {
  id: string
  /** One open suggestion per destination: new pages for the same project join it. */
  dedupeKey: string
  kind: SuggestionKind
  recordKeys: string[]
  destination: SuggestionDestination
  /** Other projects that also fit, when the best one does not clearly win. */
  alternatives: string[]
  /** 0..1 */
  confidence: number
  band: ConfidenceBand
  evidence: Evidence
  createdAt: number
  updatedAt: number
  expiresAt: number
  status: SuggestionStatus
  snoozedUntil?: number
  decidedAt?: number
  /** First shown on a surface: a suggestion is never announced twice. */
  surfacedAt?: number
}

/** What the project looked like the last time the person picked it up. */
export type Checkpoint = {
  workspaceId: string
  at: number
  itemCount: number
  /** Activity in the project after this counts as new. */
  keys: string[]
}

export type ResumeMemory = {
  /** The person said "not now" to resuming this project at this time. */
  dismissed?: { workspaceId: string; at: number }
}

export type ContextState = {
  version: typeof CONTEXT_SCHEMA_VERSION
  records: ActivityRecord[]
  /** Where the last pull from the extension ended: records changed after it come next. */
  cursor?: { epoch: string; seq: number }
  associations: Association[]
  rejections: Rejection[]
  suggestions: Suggestion[]
  checkpoints: Checkpoint[]
  resume: ResumeMemory
  preference: SuggestionPreference
  /** "Later" on the first-run choice: asked again after a while, never on every visit. */
  onboardingDeferredAt?: number
}

// ---------------------------------------------------------------- settings

/**
 *   off    manual: nothing is detected, every manual flow works as before
 *   auto   any ordinary site, except sensitive ones and the person's exclusions
 *   sites  only the kinds of site the person chose
 */
export type DetectionMode = "off" | "auto" | "sites"
export const DETECTION_MODES: readonly DetectionMode[] = ["off", "auto", "sites"] as const

export type SiteCategory = "ai" | "docs" | "research" | "video"
export const SITE_CATEGORIES: readonly SiteCategory[] = ["ai", "docs", "research", "video"] as const

export type RetentionDays = 7 | 30 | 90
export const RETENTION_CHOICES: readonly RetentionDays[] = [7, 30, 90] as const

/**
 * The person's choices about detection. The extension holds them and is the
 * one that enforces them (it decides what is collected); Hubble reads and
 * writes them through the extension.
 */
export type ContextSettings = {
  version: 1
  mode: DetectionMode
  /** When the person chose a mode: before this, Hubble asks. */
  decidedAt?: number
  categories: SiteCategory[]
  /** Hosts never detected, whatever the mode. */
  excludedHosts: string[]
  paused: boolean
  /** A pause that ends by itself. */
  pausedUntil?: number
  /** AI apps whose conversations the extension may read in the background. Effective only with Chrome's permission too. */
  readConversations: AiProviderId[]
  retentionDays: RetentionDays
}

/** How often Hubble suggests. Page-side only: it never changes what is collected. */
export type SuggestionPreference = "all" | "strong" | "off"
