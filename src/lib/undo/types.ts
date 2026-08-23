import type { WorkspaceStore } from "@/lib/workspace/types";

export type UndoEntryStatus = "active" | "undone";

/**
 * One reversible AI mutation. Deliberately a whole-store before/after pair
 * rather than a reversal of individual actions — see history.ts — so
 * undoing a 5-step operation (create workspace, create group, two moves,
 * a rename) is exactly as safe as undoing a 1-step one: there's nothing
 * action-specific to get wrong.
 */
export type UndoEntry = {
  id: string;
  timestamp: number;
  description: string;
  beforeState: WorkspaceStore;
  afterState: WorkspaceStore;
  status: UndoEntryStatus;
};
