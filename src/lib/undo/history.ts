import { createId } from "@/lib/id";
import type { WorkspaceStore } from "@/lib/workspace/types";
import type { UndoEntry } from "./types";

/**
 * Bounded so the history can't grow forever across a long session — a
 * single named constant, easy to change later. Never persisted (see
 * use-ask-tabdump.ts): it lives only for the current conversation, in
 * memory, so this bound is about a single session's footprint, not
 * long-term storage growth.
 */
export const MAX_UNDO_HISTORY = 20;

/**
 * Records one AI mutation and returns both the trimmed history and the
 * entry that was just added (so the caller can attach its id to the
 * assistant message that reported the change, without a second lookup).
 */
export function pushUndoEntry(
  history: UndoEntry[],
  params: { beforeState: WorkspaceStore; afterState: WorkspaceStore; description: string }
): { history: UndoEntry[]; entry: UndoEntry } {
  const entry: UndoEntry = {
    id: createId("undo"),
    timestamp: Date.now(),
    description: params.description,
    beforeState: params.beforeState,
    afterState: params.afterState,
    status: "active",
  };
  const next = [...history, entry];
  const trimmed = next.length > MAX_UNDO_HISTORY ? next.slice(next.length - MAX_UNDO_HISTORY) : next;
  return { history: trimmed, entry };
}

export function markUndone(history: UndoEntry[], id: string): UndoEntry[] {
  return history.map((e) => (e.id === id ? { ...e, status: "undone" as const } : e));
}

export function findUndoEntry(history: UndoEntry[], id: string): UndoEntry | undefined {
  return history.find((e) => e.id === id);
}

/** Structural equality over plain JSON-shaped data — WorkspaceStore is exactly that (no functions, dates, etc). Order-independent on object keys, unlike a raw JSON.stringify comparison. */
function deepEqual(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (typeof a !== "object" || typeof b !== "object" || a === null || b === null) return false;

  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
    return a.every((v, i) => deepEqual(v, b[i]));
  }

  const aObj = a as Record<string, unknown>;
  const bObj = b as Record<string, unknown>;
  const aKeys = Object.keys(aObj);
  const bKeys = Object.keys(bObj);
  if (aKeys.length !== bKeys.length) return false;
  return aKeys.every((k) => Object.prototype.hasOwnProperty.call(bObj, k) && deepEqual(aObj[k], bObj[k]));
}

/**
 * The concurrency/stale-state guard (requirement: don't let Undo blindly
 * overwrite a newer manual change). An undo entry's `beforeState` is only
 * safe to restore if the CURRENT store is still exactly the `afterState`
 * this entry produced — if anything at all changed since (the AI action
 * itself, or a manual edit, or a later AI action), restoring `beforeState`
 * wholesale would silently discard that. Whole-store equality is
 * deliberately strict: this system never tries to guess which changes are
 * "unrelated enough" to keep.
 */
export function storesMatch(a: WorkspaceStore, b: WorkspaceStore): boolean {
  return deepEqual(a, b);
}

export type UndoAttempt =
  | { ok: true; store: WorkspaceStore }
  | { ok: false; reason: "not-found" | "already-undone" | "stale" };

/**
 * Pure decision function — no side effects, nothing persisted here. The
 * caller (useAskTabDump) is responsible for calling onStoreUpdate with the
 * returned store and for marking the entry undone in its own history
 * state. Kept pure and separate specifically so it's trivial to unit test
 * every safety branch without any React/persistence machinery involved.
 */
export function attemptUndo(entry: UndoEntry | undefined, currentStore: WorkspaceStore): UndoAttempt {
  if (!entry) return { ok: false, reason: "not-found" };
  if (entry.status !== "active") return { ok: false, reason: "already-undone" };
  if (!storesMatch(currentStore, entry.afterState)) return { ok: false, reason: "stale" };
  return { ok: true, store: entry.beforeState };
}
