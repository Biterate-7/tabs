import { FOCUS_LIMITS } from "@/lib/agents/session-context/focus"
import { isTerminalSession } from "./presentation"
import { EMPTY_SELECTION } from "./context-selection"
import type { ContextSelection } from "./context-selection"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { RuntimeSessionView } from "@/lib/agents/runtime/protocol"
import type { Collection } from "@/lib/collections/types"
import type { TabDependency } from "@/lib/dependencies/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * The working context: what an agent session is pointed at inside Hubble.
 *
 * ## One workspace, ids only
 *
 * A working context names a workspace and, optionally, some of its tabs and
 * collections. It holds nothing else — no titles, no URLs, no counts — so it
 * can never disagree with the workspace it describes: every name the UI shows
 * is looked up in live Hubble state by `describeWorkingContext`, and anything
 * deleted since simply drops out. There is no second copy of workspace data.
 *
 * ## Scope is derived, not stored
 *
 * "Whole workspace", "Tab", "Selection", "Collection", "Custom" are read off
 * the shape — no ids is the workspace, one tab is a tab, and so on — so a
 * scope label can never claim something the ids do not say.
 *
 * ## What each scope gives the agent
 *
 *   - **Whole workspace**: nothing is attached. A session bound to the
 *     workspace reads it on request through its own MCP server; nothing is
 *     pasted into a prompt.
 *   - **Anything narrower**: the tabs and collections are resolved by the
 *     Phase E bridge (bounded, redacted), attached to the session, and sent
 *     with the next message; the runtime records them as the session's focus
 *     and the agent can read that focus back through its MCP server.
 *
 * Provider-neutral throughout: nothing here knows which agent will read it.
 */

export type WorkingContext = {
  workspaceId: string
  tabIds: readonly string[]
  collectionIds: readonly string[]
}

export type ContextScope = "workspace" | "resource" | "selection" | "collection" | "custom"

/** The bounds the runtime holds a focus to — the same numbers, so nothing is cut twice. */
export const WORKING_CONTEXT_LIMITS = FOCUS_LIMITS

function unique(ids: readonly string[], max: number): string[] {
  return [...new Set(ids.filter((id) => typeof id === "string" && id.length > 0))].slice(0, max)
}

function make(workspaceId: string, tabIds: readonly string[], collectionIds: readonly string[]): WorkingContext {
  return {
    workspaceId,
    tabIds: unique(tabIds, WORKING_CONTEXT_LIMITS.tabs),
    collectionIds: unique(collectionIds, WORKING_CONTEXT_LIMITS.collections),
  }
}

export function workspaceContext(workspaceId: string): WorkingContext {
  return make(workspaceId, [], [])
}

export function tabsContext(workspaceId: string, tabIds: readonly string[]): WorkingContext {
  return make(workspaceId, tabIds, [])
}

export function collectionContext(workspaceId: string, collectionId: string): WorkingContext {
  return make(workspaceId, [], [collectionId])
}

export function scopeOf(context: WorkingContext): ContextScope {
  const tabs = context.tabIds.length
  const collections = context.collectionIds.length
  if (tabs === 0 && collections === 0) return "workspace"
  if (collections === 0) return tabs === 1 ? "resource" : "selection"
  if (tabs === 0 && collections === 1) return "collection"
  return "custom"
}

export const CONTEXT_SCOPE_LABEL: Record<ContextScope, string> = {
  workspace: "Whole workspace",
  resource: "One tab",
  selection: "Selected tabs",
  collection: "Collection",
  custom: "Custom",
}

export function isWholeWorkspace(context: WorkingContext): boolean {
  return scopeOf(context) === "workspace"
}

export function sameContext(a: WorkingContext | null | undefined, b: WorkingContext | null | undefined): boolean {
  if (!a || !b) return a === b
  const same = (x: readonly string[], y: readonly string[]) =>
    x.length === y.length && [...x].sort().join("\u0000") === [...y].sort().join("\u0000")
  return a.workspaceId === b.workspaceId && same(a.tabIds, b.tabIds) && same(a.collectionIds, b.collectionIds)
}

/**
 * Adds one context to another. `undefined` when they are in different
 * workspaces: an agent works in one, and context never crosses.
 */
export function addToContext(current: WorkingContext, addition: WorkingContext): WorkingContext | undefined {
  if (current.workspaceId !== addition.workspaceId) return undefined
  return make(current.workspaceId, [...current.tabIds, ...addition.tabIds], [...current.collectionIds, ...addition.collectionIds])
}

export function removeFromContext(
  context: WorkingContext,
  entry: { tabId: string } | { collectionId: string }
): WorkingContext {
  return "tabId" in entry
    ? make(context.workspaceId, context.tabIds.filter((id) => id !== entry.tabId), context.collectionIds)
    : make(context.workspaceId, context.tabIds, context.collectionIds.filter((id) => id !== entry.collectionId))
}

type ContextWorld = {
  workspaces: readonly Workspace[]
  collections: readonly Collection[]
  dependencies: readonly TabDependency[]
}

/**
 * The context with anything not in its workspace removed — a tab that moved
 * or was deleted, another workspace's collection. The Command Centre runs
 * every context through this before it is resolved, so a stale id is dropped
 * here rather than refused by the runtime.
 */
export function withinWorkspace(context: WorkingContext, world: ContextWorld): { context: WorkingContext; dropped: number } {
  const workspace = world.workspaces.find((entry) => entry.id === context.workspaceId)
  if (!workspace) return { context: workspaceContext(context.workspaceId), dropped: context.tabIds.length + context.collectionIds.length }
  const tabs = new Set(workspace.tabs.map((tab) => tab.id))
  const collections = new Set(world.collections.filter((entry) => entry.workspaceId === workspace.id).map((entry) => entry.id))
  const tabIds = context.tabIds.filter((id) => tabs.has(id))
  const collectionIds = context.collectionIds.filter((id) => collections.has(id))
  return {
    context: make(workspace.id, tabIds, collectionIds),
    dropped: context.tabIds.length - tabIds.length + context.collectionIds.length - collectionIds.length,
  }
}

/* ------------------------------------------------------------------ *
 * Describing it — always from live Hubble state
 * ------------------------------------------------------------------ */

export type WorkingContextView = {
  /** `null` when the workspace no longer exists. */
  workspace: { id: string; name: string } | null
  scope: ContextScope
  tabs: { id: string; title: string; domain: string }[]
  collections: { id: string; name: string; tabCount: number }[]
  /** Relationships between the tabs named, so "how do these relate" has an answer on screen. */
  relationships: { id: string; from: string; to: string }[]
  /** References that no longer resolve. */
  missing: number
}

const MAX_RELATIONSHIPS_SHOWN = 8

export function describeWorkingContext(context: WorkingContext, world: ContextWorld): WorkingContextView {
  const workspace = world.workspaces.find((entry) => entry.id === context.workspaceId) ?? null
  const byTab = new Map((workspace?.tabs ?? []).map((tab) => [tab.id, tab]))
  const tabs = context.tabIds.flatMap((id) => {
    const tab = byTab.get(id)
    return tab ? [{ id, title: tab.title?.trim() || tab.domain || tab.url, domain: tab.domain }] : []
  })
  const collections = context.collectionIds.flatMap((id) => {
    const collection = world.collections.find((entry) => entry.id === id && entry.workspaceId === context.workspaceId)
    return collection ? [{ id, name: collection.name, tabCount: collection.tabIds.filter((tabId) => byTab.has(tabId)).length }] : []
  })
  const named = new Set(tabs.map((tab) => tab.id))
  const titleOf = (id: string) => tabs.find((tab) => tab.id === id)?.title ?? id
  const relationships = world.dependencies
    .filter((dependency) => named.has(dependency.parentTabId) && named.has(dependency.childTabId))
    .slice(0, MAX_RELATIONSHIPS_SHOWN)
    .map((dependency) => ({ id: dependency.id, from: titleOf(dependency.parentTabId), to: titleOf(dependency.childTabId) }))

  return {
    workspace: workspace ? { id: workspace.id, name: workspace.name } : null,
    scope: scopeOf(make(context.workspaceId, tabs.map((tab) => tab.id), collections.map((entry) => entry.id))),
    tabs,
    collections,
    relationships,
    missing: context.tabIds.length - tabs.length + context.collectionIds.length - collections.length,
  }
}

const count = (value: number, one: string, many: string) => `${value} ${value === 1 ? one : many}`

/**
 * One line for a chip: "Physics collection · 3 tabs", "relativity-notes",
 * "Whole workspace". Every part is a count or a name the user gave.
 */
export function summarizeWorkingContext(view: Pick<WorkingContextView, "tabs" | "collections">): string {
  const parts: string[] = []
  if (view.collections.length === 1) parts.push(`${view.collections[0]!.name} collection`)
  else if (view.collections.length > 1) parts.push(count(view.collections.length, "collection", "collections"))
  if (view.tabs.length === 1 && view.collections.length === 0) parts.push(view.tabs[0]!.title)
  else if (view.tabs.length > 0) parts.push(count(view.tabs.length, "tab", "tabs"))
  return parts.length > 0 ? parts.join(" · ") : CONTEXT_SCOPE_LABEL.workspace
}

/* ------------------------------------------------------------------ *
 * Into the Phase E bridge
 * ------------------------------------------------------------------ */

/**
 * The bridge selection for a context — `null` for the whole workspace, which
 * attaches nothing (the session reads its workspace through its own server).
 * Relationships between the named tabs ride along, so "how do these relate"
 * is answered from what was attached.
 */
export function toContextSelection(context: WorkingContext, options: { includeNotes?: boolean } = {}): ContextSelection | null {
  if (isWholeWorkspace(context)) return null
  return {
    ...EMPTY_SELECTION,
    tabIds: [...context.tabIds],
    collectionIds: [...context.collectionIds],
    relationships: context.tabIds.length > 1,
    includeNotes: options.includeNotes === true,
  }
}

/* ------------------------------------------------------------------ *
 * A session's context, as the runtime reports it
 * ------------------------------------------------------------------ */

/** The workspace a session works in: fixed when it started, never the one on screen now. */
export function workspaceIdOf(view: RuntimeSessionView): string | undefined {
  return view.context?.workspaceId ?? view.workspaceId
}

/**
 * What the runtime says a session is pointed at. `null` for a session that
 * belongs to no workspace — it has no Hubble context to show.
 */
export function contextOfSession(view: RuntimeSessionView): WorkingContext | null {
  const workspaceId = workspaceIdOf(view)
  if (!workspaceId) return null
  return make(workspaceId, view.focus?.tabIds ?? [], view.focus?.collectionIds ?? [])
}

/* ------------------------------------------------------------------ *
 * From the workspace into the Command Centre
 * ------------------------------------------------------------------ */

/** What the user asked for when they sent something to an agent. Wording for the composer only. */
export type AgentIntent = "ask" | "explain" | "summarize" | "compare" | "analyze" | "organize"

export type AgentHandoff = {
  /** Distinct per request, so the same selection sent twice is two requests. */
  id: string
  context: WorkingContext
  /** `ask` points the session at this context; `add` adds to what it has. */
  mode: "ask" | "add"
  intent: AgentIntent
  provider?: AgentProviderId
}

/**
 * The words a request starts with in the composer — a suggestion the user
 * edits or sends, never sent on their behalf. `undefined` for a plain "ask".
 */
export function intentPrompt(intent: AgentIntent, view: Pick<WorkingContextView, "tabs" | "collections">): string | undefined {
  const collection = view.collections.length === 1 && view.tabs.length === 0 ? view.collections[0]!.name : undefined
  const single = view.tabs.length === 1 && view.collections.length === 0
  const these = collection ? `the ${collection} collection` : single ? "this page" : "these tabs"
  switch (intent) {
    case "ask":
      return undefined
    case "explain":
      return `Explain ${these}.`
    case "summarize":
      return `Summarize ${these}.`
    case "compare":
      return collection ? `Compare the sources in the ${collection} collection.` : "Compare these sources."
    case "analyze":
      return collection ? `Analyze the ${collection} collection: what it covers and how the tabs relate.` : `Analyze how ${these} relate.`
    case "organize":
      return collection ? `Suggest how to organize the ${collection} collection.` : `Organize ${these} into collections.`
  }
}

/**
 * Which session a request goes to: the one on screen if it works in the same
 * workspace (and is the agent asked for, when one was), else the most recent
 * live one that does. `null`: start a new session. Never a session in another
 * workspace — the request's workspace is the one its context came from.
 */
export function handoffTarget(
  sessions: readonly { view: RuntimeSessionView }[],
  handoff: Pick<AgentHandoff, "context" | "provider">,
  selectedSessionId: string | null
): string | null {
  const fits = (view: RuntimeSessionView) =>
    !isTerminalSession(view.status) &&
    workspaceIdOf(view) === handoff.context.workspaceId &&
    (!handoff.provider || view.provider === handoff.provider)
  const selected = sessions.find((entry) => entry.view.sessionId === selectedSessionId)
  if (selected && fits(selected.view)) return selected.view.sessionId
  const latest = sessions
    .filter((entry) => fits(entry.view))
    .sort((a, b) => b.view.updatedAt - a.view.updatedAt)[0]
  return latest?.view.sessionId ?? null
}

/* ------------------------------------------------------------------ *
 * How a session relates to its workspace — each failure said separately
 * ------------------------------------------------------------------ */

export type WorkspaceLink =
  /** Bound: the agent reads the workspace through its own server. */
  | { kind: "live"; canChange: boolean }
  /** Started from a workspace, but this agent cannot be given it safely (J.4). */
  | { kind: "agent-cannot-read" }
  /** Started from a workspace, but this runtime has no live context for it. */
  | { kind: "no-live-access" }
  /** The workspace it was started in has since been deleted. */
  | { kind: "workspace-missing" }
  /** Started without a workspace. */
  | { kind: "none" }

export function workspaceLinkOf(view: RuntimeSessionView, workspaces: readonly Pick<Workspace, "id">[]): WorkspaceLink {
  const workspaceId = workspaceIdOf(view)
  if (!workspaceId) return { kind: "none" }
  if (!workspaces.some((workspace) => workspace.id === workspaceId)) return { kind: "workspace-missing" }
  if (view.context) return { kind: "live", canChange: view.context.capabilities.includes("collections.write") }
  if (view.contextUnavailable === "provider") return { kind: "agent-cannot-read" }
  return { kind: "no-live-access" }
}

/** What the agent can reach, in one sentence per link. Fixed text. */
export const WORKSPACE_LINK_DETAIL: Record<WorkspaceLink["kind"], string> = {
  live: "Reads this workspace when it needs to. Nothing outside it.",
  "agent-cannot-read":
    "This agent can't be given live access to your workspace safely, so it only knows the tabs and collections you add here.",
  "no-live-access": "This session has no live access to the workspace here. It only knows the tabs and collections you add.",
  "workspace-missing": "The workspace this session was started in no longer exists. It has no Hubble context.",
  none: "This session was started without a workspace, so it has no Hubble context.",
}

/** Whether it can change the workspace, and if not, why — in words. */
export function changeAccessLabel(link: WorkspaceLink): { allowed: boolean; text: string } {
  if (link.kind !== "live") return { allowed: false, text: "Can't change your workspace" }
  return link.canChange
    ? { allowed: true, text: "Can change collections — you approve each change" }
    : { allowed: false, text: "Read only — start a session with a project that allows changing Hubble content" }
}
