import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { Collection } from "@/lib/collections/types"

/**
 * What agents have changed in Hubble workspaces, as the Command Centre
 * applied it — the "what did it change?" half of the workspace ↔ agent loop.
 *
 * ## Recorded by the one thing that knows
 *
 * The Command Centre applies every approved change itself (J.3–J.5), so it is
 * the one place that knows exactly what happened: which collection was
 * created, under what name, with how many tabs — or that nothing was. Each
 * application is recorded here once, in the user's words (names and counts;
 * never an id, a tool name or a protocol verb), and the activity rows, the
 * notification and "View" all read from this record.
 *
 * ## Memory only, for this page
 *
 * Not persisted. The workspace itself is the durable record of what changed;
 * this is the story of how, for the session that is open. It survives the
 * Command Centre being closed and reopened, which is when "what did it do
 * while I was away?" gets asked.
 */

export type WorkspaceChangeStep =
  | { kind: "created"; collectionId?: string; name: string; tabCount: number }
  | { kind: "renamed"; collectionId: string; name: string; previousName?: string }
  | { kind: "added"; collectionId: string; name: string; tabCount: number }

export type AppliedWorkspaceChange = {
  /** The approved action's id — one record per application. */
  id: string
  sessionId: string
  provider: AgentProviderId
  workspaceId: string
  at: number
  ok: boolean
  /** The approved plan this applied (J.5), so its verified outcome joins the right record. */
  planId?: string
  /**
   * The approval that allowed it, as the runtime reported it with the action
   * — how the activity inspector joins a result to its request, by id.
   */
  approvalId?: string
  steps: readonly WorkspaceChangeStep[]
  /**
   * The workspace's collections either side of the change, for an exact undo
   * — offered only while the workspace still matches `after` (see
   * `restoreCollections` in use-collection-store.ts). Absent when nothing
   * changed.
   */
  before?: readonly Collection[]
  after?: readonly Collection[]
  /** Set once the user undid it. */
  undone?: boolean
  /**
   * When it was undone. The record itself stays — undoing is a second fact,
   * told after the first, never a rewrite of what the agent did.
   */
  undoneAt?: number
}

const MAX_RECORDS = 100

let records: readonly AppliedWorkspaceChange[] = []
const listeners = new Set<() => void>()

function emit(): void {
  for (const listener of listeners) listener()
}

export function recordWorkspaceChange(change: AppliedWorkspaceChange): void {
  if (records.some((record) => record.id === change.id)) return
  records = [...records, change].slice(-MAX_RECORDS)
  emit()
}

export function markWorkspaceChangeUndone(id: string, at: number = Date.now()): void {
  records = records.map((record) => (record.id === id && !record.undone ? { ...record, undone: true, undoneAt: at } : record))
  emit()
}

export function workspaceChanges(): readonly AppliedWorkspaceChange[] {
  return records
}

export function subscribeWorkspaceChanges(listener: () => void): () => void {
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}

/** Tests only: forget everything. */
export function resetWorkspaceChanges(): void {
  records = []
  emit()
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** One step in words: `Created collection "Physics Sources" · 4 tabs`. */
export function describeStep(step: WorkspaceChangeStep): string {
  switch (step.kind) {
    case "created":
      return `Created collection “${step.name}” · ${plural(step.tabCount, "tab", "tabs")}`
    case "renamed":
      return step.previousName ? `Renamed “${step.previousName}” to “${step.name}”` : `Renamed a collection to “${step.name}”`
    case "added":
      return `Added ${plural(step.tabCount, "tab", "tabs")} to “${step.name}”`
  }
}

/** The headline for a notification: the first step, and how many more. */
export function describeChange(change: Pick<AppliedWorkspaceChange, "ok" | "steps">): string {
  if (!change.ok) return "Couldn't apply the approved change — nothing was changed"
  const first = change.steps[0]
  if (!first) return "Workspace updated"
  const rest = change.steps.length - 1
  return rest > 0 ? `${describeStep(first)} · ${plural(rest, "more change", "more changes")}` : describeStep(first)
}

/**
 * What undoing a change did, as its own line in the history:
 * `Undid creation of “Physics Sources”`. The original change keeps its own
 * line; this one is told after it.
 */
export function describeUndo(change: Pick<AppliedWorkspaceChange, "steps">): string {
  const [first] = change.steps
  if (change.steps.length !== 1 || !first) return `Undid ${plural(change.steps.length, "workspace change", "workspace changes")}`
  switch (first.kind) {
    case "created":
      return `Undid creation of “${first.name}”`
    case "renamed":
      return first.previousName ? `Undid renaming “${first.previousName}” to “${first.name}”` : `Undid renaming “${first.name}”`
    case "added":
      return `Undid adding ${plural(first.tabCount, "tab", "tabs")} to “${first.name}”`
  }
}

/**
 * What an undo will do, one line per step — what the confirmation lists
 * before anything moves. Read off the recorded steps, which were read off the
 * collections either side of the change.
 */
export function undoEffects(change: Pick<AppliedWorkspaceChange, "steps">): string[] {
  return change.steps.map((step) => {
    switch (step.kind) {
      case "created":
        return `Remove the collection “${step.name}”`
      case "renamed":
        return step.previousName ? `Rename “${step.name}” back to “${step.previousName}”` : `Give “${step.name}” its previous name back`
      case "added":
        return `Take ${plural(step.tabCount, "tab", "tabs")} back out of “${step.name}”`
    }
  })
}

/** The collection a "View" should land on, when there is one. */
export function collectionToView(change: Pick<AppliedWorkspaceChange, "steps">): string | undefined {
  for (const step of change.steps) if (step.collectionId) return step.collectionId
  return undefined
}
