import { DEFAULT_WORKSPACE_NAME } from "@/lib/workspace/migration"
import type { Tab } from "@/lib/tabs/types"
import type { Workspace, WorkspaceStore } from "@/lib/workspace/types"

/**
 * Subjects: the student-facing name for a workspace.
 *
 * A presentation layer only. A subject IS a `Workspace` — same id, same
 * store, same sync, same agent context — and nothing here is persisted. The
 * word changes; the model does not. Storage ids, protocol names and the
 * agent tools keep saying "workspace", on purpose.
 *
 *     Workspace ── shown as ──▶ Subject
 *     Tab.resource ─────────▶ Resource
 */

export const UNTITLED_SUBJECT = "Untitled subject"

export function subjectName(workspace: Pick<Workspace, "name">): string {
  return workspace.name.trim() || UNTITLED_SUBJECT
}

/**
 * The workspace every install starts with, untouched: the default name, no
 * tabs, no brief, no attached folder. A store holding only this has no
 * subjects yet as far as a student is concerned — Home shows "Start with a
 * subject", and the first subject they create takes this workspace's place
 * rather than sitting beside an empty "General".
 */
export function isPristineDefault(workspace: Workspace): boolean {
  return (
    workspace.name === DEFAULT_WORKSPACE_NAME &&
    workspace.tabs.length === 0 &&
    !workspace.brief?.description &&
    !workspace.brief?.focus &&
    !workspace.project &&
    !workspace.logo
  )
}

/**
 * The subjects a student has made — the store minus a lone, untouched default.
 *
 * `started` is the explicit answer, once there is one: as soon as a student
 * makes a subject, every workspace is theirs — including a first subject they
 * happened to call "General", which the shape alone could not tell apart from
 * the untouched default.
 */
export function visibleSubjects(store: WorkspaceStore, started = false): Workspace[] {
  if (!started && store.workspaces.length === 1 && isPristineDefault(store.workspaces[0]!)) return []
  return store.workspaces
}

const STARTED_KEY = "hubble:subjects-started:v1"

/** Whether this device has made a subject. Unknown (no storage) answers false: the default is just hidden. */
export function loadSubjectsStarted(): boolean {
  try {
    return window.localStorage.getItem(STARTED_KEY) === "1"
  } catch {
    return false
  }
}

export function markSubjectsStarted(): void {
  try {
    window.localStorage.setItem(STARTED_KEY, "1")
  } catch {
    // Without storage the default simply stays hidden while empty; nothing is lost.
  }
}

/** "Good morning" / "Good afternoon" / "Good evening", by the local hour. */
export function greeting(hour: number): string {
  if (hour >= 5 && hour < 12) return "Good morning"
  if (hour >= 12 && hour < 18) return "Good afternoon"
  return "Good evening"
}

/** When anything in a subject last changed: its newest tab, or the subject itself. */
export function subjectUpdatedAt(workspace: Workspace): number {
  let latest = workspace.updatedAt
  for (const tab of workspace.tabs) {
    const at = tab.resource?.addedAt ?? tab.createdAt
    if (at && at > latest) latest = at
  }
  return latest
}

export type RecentResource = { workspace: Workspace; tab: Tab; at: number }

/** The newest things added across every subject, newest first. */
export function recentResources(workspaces: readonly Workspace[], limit: number): RecentResource[] {
  const all: RecentResource[] = []
  for (const workspace of workspaces) {
    for (const tab of workspace.tabs) {
      const at = tab.resource?.addedAt ?? tab.lastAccessedAt ?? tab.createdAt ?? 0
      all.push({ workspace, tab, at })
    }
  }
  return all.sort((a, b) => b.at - a.at).slice(0, limit)
}
