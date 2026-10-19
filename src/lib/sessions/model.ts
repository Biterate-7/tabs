import { isSafeOpenUrl } from "@/lib/browser/protocol"
import { readPageIcon } from "@/lib/favicon/page-icon"
import { MAX_SAVED_TITLE_CHARS, MAX_SESSION_NAME_CHARS, MAX_SESSION_TABS, MAX_SESSIONS, SESSIONS_SCHEMA_VERSION } from "./types"
import type { CapturedTab, SavedTab, SessionWrite, SessionsState, TabSession } from "./types"

/**
 * The session reducers: pure `(state, args) -> result`, no storage, no clock
 * and no id generator of their own (both are passed in), so every rule here
 * is testable on its own. ./persistence.ts runs them against the stored copy.
 */

export function emptySessionsState(): SessionsState {
  return { version: SESSIONS_SCHEMA_VERSION, sessions: [] }
}

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
}

function cleanText(value: unknown, max: number): string {
  if (typeof value !== "string") return ""
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, max)
}

/** The name a session is stored under, or "" when there is nothing usable. */
export function cleanSessionName(value: unknown): string {
  return cleanText(value, MAX_SESSION_NAME_CHARS)
}

/** Only http(s) icons: an inline one could be kilobytes per tab, and the resolver finds one anyway. */
function cleanFavicon(value: unknown): string | undefined {
  const icon = readPageIcon(value)
  return icon && /^https?:/i.test(icon) ? icon : undefined
}

/** A tab Hubble may keep and reopen, or null: anything that is not an ordinary web address is left out. */
export function readSavedTab(value: unknown, mintId: () => string): SavedTab | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (!isSafeOpenUrl(raw.url)) return null
  const favicon = cleanFavicon(raw.favicon)
  return {
    id: typeof raw.id === "string" && raw.id.length > 0 && raw.id.length <= 100 ? raw.id : mintId(),
    url: raw.url,
    title: cleanText(raw.title, MAX_SAVED_TITLE_CHARS),
    ...(favicon ? { favicon } : {}),
    ...(raw.pinned === true ? { pinned: true } : {}),
  }
}

/** Tabs as they arrive to be saved: unsafe addresses dropped, ids minted, order kept. */
export function toSavedTabs(tabs: readonly CapturedTab[], mintId: () => string): SavedTab[] {
  const out: SavedTab[] = []
  for (const tab of tabs) {
    const saved = readSavedTab({ ...tab, id: undefined }, mintId)
    if (saved) out.push(saved)
  }
  return out
}

function readSession(value: unknown, mintId: () => string): TabSession | null {
  if (!value || typeof value !== "object") return null
  const raw = value as Record<string, unknown>
  if (typeof raw.id !== "string" || raw.id.length === 0 || raw.id.length > 100) return null
  const name = cleanSessionName(raw.name)
  if (!name || !Array.isArray(raw.tabs)) return null
  const seen = new Set<string>()
  const tabs: SavedTab[] = []
  for (const entry of raw.tabs.slice(0, MAX_SESSION_TABS)) {
    const tab = readSavedTab(entry, mintId)
    if (!tab) continue
    // Two tabs sharing an id would make selection and editing ambiguous: the later one gets a new id.
    const unique = seen.has(tab.id) ? { ...tab, id: mintId() } : tab
    seen.add(unique.id)
    tabs.push(unique)
  }
  // A session with nothing left to reopen is not kept.
  if (tabs.length === 0) return null
  const createdAt = finite(raw.createdAt) ? raw.createdAt : finite(raw.updatedAt) ? raw.updatedAt : 0
  if (!createdAt) return null
  const updatedAt = finite(raw.updatedAt) ? Math.max(raw.updatedAt, createdAt) : createdAt
  return {
    id: raw.id,
    name,
    tabs,
    createdAt,
    updatedAt,
    ...(finite(raw.lastRestoredAt) ? { lastRestoredAt: raw.lastRestoredAt } : {}),
    ...(typeof raw.workspaceId === "string" && raw.workspaceId.length > 0 && raw.workspaceId.length <= 200 ? { workspaceId: raw.workspaceId } : {}),
    revision: typeof raw.revision === "number" && Number.isInteger(raw.revision) && raw.revision >= 0 ? raw.revision : 0,
  }
}

/**
 * Stored sessions, re-read: storage is untrusted (an old build, a hand edit,
 * another extension). Malformed sessions and tabs are dropped, a duplicate
 * session id keeps its first occurrence, and nothing is invented.
 */
export function readSessionsState(value: unknown, mintId: () => string): SessionsState {
  if (!value || typeof value !== "object") return emptySessionsState()
  const raw = value as Record<string, unknown>
  if (!Array.isArray(raw.sessions)) return emptySessionsState()
  const seen = new Set<string>()
  const sessions: TabSession[] = []
  for (const entry of raw.sessions) {
    const session = readSession(entry, mintId)
    if (!session || seen.has(session.id)) continue
    seen.add(session.id)
    sessions.push(session)
    if (sessions.length >= MAX_SESSIONS) break
  }
  return { version: SESSIONS_SCHEMA_VERSION, sessions }
}

function ok<T>(state: SessionsState, value: T): SessionWrite<T> {
  return { ok: true, state, value }
}

function replaceSession(state: SessionsState, next: TabSession): SessionsState {
  return { ...state, sessions: state.sessions.map((session) => (session.id === next.id ? next : session)) }
}

export function createSession(
  state: SessionsState,
  input: { name: string; tabs: readonly CapturedTab[]; workspaceId?: string },
  ctx: { now: number; mintId: () => string }
): SessionWrite<TabSession> {
  if (state.sessions.length >= MAX_SESSIONS) return { ok: false, error: "too-many-sessions" }
  if (input.tabs.length > MAX_SESSION_TABS) return { ok: false, error: "too-many-tabs" }
  const tabs = toSavedTabs(input.tabs, ctx.mintId)
  if (tabs.length === 0) return { ok: false, error: "empty" }
  const session: TabSession = {
    id: ctx.mintId(),
    name: cleanSessionName(input.name) || "Session",
    tabs,
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    revision: 0,
  }
  // Newest first, so a list read straight from storage is already in a sensible order.
  return ok({ ...state, sessions: [session, ...state.sessions] }, session)
}

export function renameSession(state: SessionsState, id: string, name: string): SessionWrite<TabSession> {
  const session = state.sessions.find((entry) => entry.id === id)
  if (!session) return { ok: false, error: "missing" }
  const clean = cleanSessionName(name)
  if (!clean) return { ok: false, error: "empty" }
  // The tabs, their times and the project are untouched: a rename is not a new snapshot.
  const next = { ...session, name: clean, revision: session.revision + 1 }
  return ok(replaceSession(state, next), next)
}

/** "History essay (copy)", then "(copy 2)" — never a name already in use. */
export function copyName(name: string, taken: ReadonlySet<string>): string {
  const base = name.replace(/ \(copy(?: \d+)?\)$/, "")
  for (let n = 1; ; n += 1) {
    const candidate = cleanSessionName(`${base} (copy${n === 1 ? "" : ` ${n}`})`)
    if (!taken.has(candidate)) return candidate
  }
}

export function duplicateSession(state: SessionsState, id: string, ctx: { now: number; mintId: () => string }): SessionWrite<TabSession> {
  const source = state.sessions.find((entry) => entry.id === id)
  if (!source) return { ok: false, error: "missing" }
  if (state.sessions.length >= MAX_SESSIONS) return { ok: false, error: "too-many-sessions" }
  const copy: TabSession = {
    id: ctx.mintId(),
    name: copyName(source.name, new Set(state.sessions.map((entry) => entry.name))),
    // New tab ids too: the copy shares nothing with its source.
    tabs: source.tabs.map((tab) => ({ ...tab, id: ctx.mintId() })),
    createdAt: ctx.now,
    updatedAt: ctx.now,
    ...(source.workspaceId ? { workspaceId: source.workspaceId } : {}),
    revision: 0,
  }
  const index = state.sessions.findIndex((entry) => entry.id === id)
  const sessions = [...state.sessions]
  sessions.splice(index, 0, copy)
  return ok({ ...state, sessions }, copy)
}

export function deleteSession(state: SessionsState, id: string): SessionWrite<TabSession> {
  const session = state.sessions.find((entry) => entry.id === id)
  if (!session) return { ok: false, error: "missing" }
  return ok({ ...state, sessions: state.sessions.filter((entry) => entry.id !== id) }, session)
}

/**
 * Replaces a session's tabs — an edit (tabs removed or reordered) or a new
 * snapshot of what is open now. Refused when the session changed since the
 * caller read it (`expectedRevision`), so an edit dialog left open in one tab
 * cannot silently undo a save made in another.
 */
export function replaceSessionTabs(
  state: SessionsState,
  id: string,
  tabs: readonly (CapturedTab | SavedTab)[],
  ctx: { now: number; mintId: () => string; expectedRevision: number }
): SessionWrite<TabSession> {
  const session = state.sessions.find((entry) => entry.id === id)
  if (!session) return { ok: false, error: "missing" }
  if (session.revision !== ctx.expectedRevision) return { ok: false, error: "conflict" }
  if (tabs.length > MAX_SESSION_TABS) return { ok: false, error: "too-many-tabs" }
  // Kept tabs keep their ids; new ones get one.
  const seen = new Set<string>()
  const next: SavedTab[] = []
  for (const tab of tabs) {
    const saved = readSavedTab(tab, ctx.mintId)
    if (!saved) continue
    const unique = seen.has(saved.id) ? { ...saved, id: ctx.mintId() } : saved
    seen.add(unique.id)
    next.push(unique)
  }
  if (next.length === 0) return { ok: false, error: "empty" }
  const updated = { ...session, tabs: next, updatedAt: Math.max(ctx.now, session.createdAt), revision: session.revision + 1 }
  return ok(replaceSession(state, updated), updated)
}

/** Records that a session's tabs were opened. Missing (deleted meanwhile) is not an error: there is nothing to record. */
export function markSessionRestored(state: SessionsState, id: string, now: number): SessionWrite<TabSession | undefined> {
  const session = state.sessions.find((entry) => entry.id === id)
  if (!session) return ok(state, undefined)
  const next = { ...session, lastRestoredAt: now, revision: session.revision + 1 }
  return ok(replaceSession(state, next), next)
}

/** When the person last did something with this session: saved or edited its tabs, or opened them. */
export function lastActivityAt(session: TabSession): number {
  return Math.max(session.updatedAt, session.lastRestoredAt ?? 0)
}

/** Most recently used first; ties go to the newer session. */
export function sortByActivity(sessions: readonly TabSession[]): TabSession[] {
  return [...sessions].sort((a, b) => lastActivityAt(b) - lastActivityAt(a) || b.createdAt - a.createdAt)
}

/**
 * The session "Pick up where you left off" offers: the one most recently
 * saved, edited or opened. One rule, used everywhere a "latest" is shown.
 */
export function mostRecentSession(sessions: readonly TabSession[]): TabSession | undefined {
  return sortByActivity(sessions)[0]
}

/** "docs.google.com" — the part of an address a list can show instead of the whole thing. */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname.replace(/^www\./, "")
  } catch {
    return ""
  }
}

/** What a saved tab is called in a list: its saved title, or where it points when it had none. */
export function tabLabel(tab: Pick<SavedTab, "title" | "url">): string {
  if (tab.title) return tab.title
  try {
    const url = new URL(tab.url)
    const path = url.pathname === "/" ? "" : url.pathname
    return `${url.hostname.replace(/^www\./, "")}${path}`
  } catch {
    return tab.url
  }
}
