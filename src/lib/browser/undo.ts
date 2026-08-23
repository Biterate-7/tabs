import { createId } from "@/lib/id"

/**
 * A browser mutation's undo lives entirely outside WorkspaceStore (opening,
 * closing, and pinning real Chrome tabs never touches the store), so it
 * can't reuse src/lib/undo/history.ts's whole-store before/after diff —
 * that system is untouched by this feature on purpose (see
 * src/lib/undo/history.test.ts, which this must not risk breaking).
 * This is a small, parallel, browser-only undo history instead: each entry
 * names the exact extension command(s) that reverse one action, built from
 * data the extension itself returned at execution time (the opened tabs'
 * real ids, a pinned tab's previous state) — never guessed or re-derived
 * later. Actions Chrome can't safely reverse (closing tabs, moving tabs
 * between windows) simply never get an entry — see src/lib/browser/execute.ts.
 */
export type BrowserRevertStep =
  | { kind: "close_tabs"; tabIds: number[] }
  | { kind: "restore_pinned"; tabId: number; pinned: boolean }

export type BrowserUndoEntry = {
  id: string
  timestamp: number
  description: string
  status: "active" | "undone"
  /** Almost always one step; an array so a single turn that ran more than one revertible browser action (e.g. open_tabs + pin_tab) still gets exactly one Undo button that reverts all of it. */
  revert: BrowserRevertStep[]
}

export function pushBrowserUndoEntry(
  history: BrowserUndoEntry[],
  params: { description: string; revert: BrowserRevertStep[] }
): { history: BrowserUndoEntry[]; entry: BrowserUndoEntry } {
  const entry: BrowserUndoEntry = {
    id: createId("bundo"),
    timestamp: Date.now(),
    description: params.description,
    status: "active",
    revert: params.revert,
  }
  return { history: [...history, entry], entry }
}

export function markBrowserUndone(history: BrowserUndoEntry[], id: string): BrowserUndoEntry[] {
  return history.map((e) => (e.id === id ? { ...e, status: "undone" as const } : e))
}

export function findBrowserUndoEntry(history: BrowserUndoEntry[], id: string): BrowserUndoEntry | undefined {
  return history.find((e) => e.id === id)
}
