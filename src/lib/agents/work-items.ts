import { createId } from "@/lib/id";
import { findRun } from "./runs";
import {
  MAX_WORK_ITEMS_PER_RUN,
  agentFailure,
  isTerminalWorkItemStatus,
  normalizeWorkItemProgress,
  normalizeWorkItemSummary,
  normalizeWorkItemTitle,
} from "./types";
import type {
  AgentFailure,
  AgentState,
  AgentWorkItem,
  AgentWorkItemProgress,
  AgentWorkItemStatus,
} from "./types";

/**
 * Agent work items: creation, metadata, lifecycle and deletion.
 *
 * Pure reducers over AgentState with the clock injected — the same contract
 * as ./runs.ts and ./registry.ts, so a caller that knows one knows all three.
 *
 * A work item is an *observational* object. It records that some unit of work
 * exists and what state it is in; it is never a thing this app can run. There
 * is no `execute`, `start`, `retry` or `assign` here, and none may be added:
 * the moment a work item can be acted on, Hubble stops observing agents and
 * starts driving them, which is a categorically different product.
 */

export type CreateWorkItemInput = {
  runId: string;
  title: string;
  summary?: string;
  /** Defaults to "pending". An item may legitimately be discovered already active. */
  status?: AgentWorkItemStatus;
  /** The provider's own id for this item, if it has one. Used for idempotent ingestion. */
  externalId?: string;
  progress?: AgentWorkItemProgress;
};

export type CreateWorkItemResult =
  | { ok: true; state: AgentState; workItem: AgentWorkItem }
  | AgentFailure;

/**
 * Creates a work item against an existing run.
 *
 * The workspace is taken FROM THE RUN rather than accepted from the caller.
 * That is the single most important line in this module: a caller cannot file
 * a work item into a workspace its run does not belong to, because it never
 * gets to name a workspace at all. The cross-workspace check that links.ts
 * has to perform is, here, structurally impossible to fail.
 *
 * A title is mandatory and must survive normalisation — an untitled work item
 * is a row that says nothing, and inventing "Untitled" for it would put a
 * fabricated name in front of the user.
 */
export function createWorkItem(
  state: AgentState,
  input: CreateWorkItemInput,
  now: number
): CreateWorkItemResult {
  const run = findRun(state, input.runId);
  if (!run) return agentFailure("run-not-found");

  const title = normalizeWorkItemTitle(input.title);
  if (!title) return agentFailure("invalid-input");

  // Bounded per run, oldest-wins. A provider that emitted an item per tool
  // call must not be able to grow persisted state without limit.
  const existingForRun = state.workItems.filter((item) => item.runId === run.id).length;
  if (existingForRun >= MAX_WORK_ITEMS_PER_RUN) return agentFailure("invalid-input");

  const status = input.status ?? "pending";
  const workItem: AgentWorkItem = {
    id: createId(),
    workspaceId: run.workspaceId,
    runId: run.id,
    title,
    status,
    createdAt: now,
    updatedAt: now,
  };

  const externalId = input.externalId?.trim();
  if (externalId) workItem.externalId = externalId;

  const summary = input.summary ? normalizeWorkItemSummary(input.summary) : "";
  if (summary) workItem.summary = summary;

  const progress = normalizeWorkItemProgress(input.progress);
  if (progress) workItem.progress = progress;

  // An item discovered already active started now, as far as anything here
  // can honestly say. An item discovered already FINISHED gets no startedAt:
  // it plainly started at some point, but nothing observed when, and stamping
  // `now` would assert a beginning that is simply the moment Hubble happened
  // to look. Between two wrong answers, the one that claims less wins — the
  // same reasoning that makes Claude Code's `Write` map to `edited`.
  if (status === "active") workItem.startedAt = now;
  if (isTerminalWorkItemStatus(status)) workItem.completedAt = now;

  return {
    ok: true,
    state: { ...state, workItems: [...state.workItems, workItem] },
    workItem,
  };
}

export function findWorkItem(state: AgentState, workItemId: string): AgentWorkItem | undefined {
  return state.workItems.find((item) => item.id === workItemId);
}

/**
 * The work item an observer has already created for a provider task.
 *
 * Scoped by run as well as externalId: provider task ids are frequently
 * small integers scoped to one session ("1", "2", "3"), so matching on the
 * id alone would merge unrelated items from different runs into one.
 */
export function findWorkItemByExternalId(
  state: AgentState,
  runId: string,
  externalId: string
): AgentWorkItem | undefined {
  return state.workItems.find((item) => item.runId === runId && item.externalId === externalId);
}

export function listWorkItems(state: AgentState): AgentWorkItem[] {
  return state.workItems;
}

export type UpdateWorkItemPatch = {
  title?: string;
  summary?: string;
  progress?: AgentWorkItemProgress | null;
};

export type UpdateWorkItemResult =
  | { ok: true; state: AgentState; workItem: AgentWorkItem }
  | AgentFailure;

/**
 * Updates a work item's descriptive metadata.
 *
 * `status`, `runId` and `workspaceId` are all absent by design. Status goes
 * through transitionWorkItem, which is the only thing that enforces the
 * lifecycle; allowing it here would be a second, unguarded door into the same
 * field. Moving an item between runs would strand it in a workspace its run
 * does not belong to.
 *
 * Absent fields are no news and are left alone, matching updateRun: an
 * observer that learns less on a later poll must not erase what is already
 * known. A title may not be cleared — an item with no name is not a thing the
 * UI can render — but a summary may, by passing an empty string, and progress
 * may, by passing null.
 */
export function updateWorkItem(
  state: AgentState,
  workItemId: string,
  patch: UpdateWorkItemPatch,
  now: number
): UpdateWorkItemResult {
  const existing = findWorkItem(state, workItemId);
  if (!existing) return agentFailure("work-item-not-found");

  const next: AgentWorkItem = { ...existing };
  let changed = false;

  if (patch.title !== undefined) {
    const title = normalizeWorkItemTitle(patch.title);
    // An empty title is refused rather than applied: "no news" is the right
    // reading of a blank from an observer, not "erase the name".
    if (title && title !== next.title) {
      next.title = title;
      changed = true;
    }
  }

  if (patch.summary !== undefined) {
    const summary = normalizeWorkItemSummary(patch.summary);
    if (summary) {
      if (next.summary !== summary) {
        next.summary = summary;
        changed = true;
      }
    } else if (next.summary !== undefined) {
      delete next.summary;
      changed = true;
    }
  }

  if (patch.progress !== undefined) {
    if (patch.progress === null) {
      if (next.progress !== undefined) {
        delete next.progress;
        changed = true;
      }
    } else {
      const progress = normalizeWorkItemProgress(patch.progress);
      // Unusable progress is dropped, not applied and not fatal — see
      // normalizeWorkItemProgress for why clamping would be worse.
      if (
        progress &&
        (next.progress?.completed !== progress.completed ||
          next.progress?.total !== progress.total)
      ) {
        next.progress = progress;
        changed = true;
      }
    }
  }

  if (!changed) return { ok: true, state, workItem: existing };

  next.updatedAt = now;
  return {
    ok: true,
    state: {
      ...state,
      workItems: state.workItems.map((item) => (item.id === workItemId ? next : item)),
    },
    workItem: next,
  };
}

/**
 * The lifecycle, in one place.
 *
 *     pending --> active --> completed
 *                   |
 *                   |--> blocked --> active
 *                   |
 *                   \--> cancelled
 *
 * Two rules govern it:
 *
 *   - **`blocked` is not terminal.** An item waiting on something can be
 *     unblocked by the very next observation. This is the deliberate
 *     divergence from AgentRunStatus, where `blocked` means the session
 *     stopped for good.
 *   - **`cancelled` is reachable from every live state.** Abandoning work that
 *     was never started is an ordinary thing to do, so pending, active and
 *     blocked can all be cancelled. Completion, by contrast, is reachable only
 *     from `active`: an item cannot finish without having been worked on, and
 *     letting `pending -> completed` through would let a provider mark work
 *     done that was never observed being done.
 *
 * There is no reopening. Once completed or cancelled, an item is history, and
 * a provider re-reporting it as active is a stale observation rather than a
 * resurrection. Re-asserting a status an item already holds is not a
 * transition at all and is handled by the caller below.
 */
const ALLOWED_TRANSITIONS: Record<AgentWorkItemStatus, readonly AgentWorkItemStatus[]> = {
  pending: ["active", "cancelled"],
  active: ["blocked", "completed", "cancelled"],
  blocked: ["active", "cancelled"],
  completed: [],
  cancelled: [],
};

export function canTransitionWorkItem(
  from: AgentWorkItemStatus,
  to: AgentWorkItemStatus
): boolean {
  return (ALLOWED_TRANSITIONS[from] as readonly string[]).includes(to);
}

export type TransitionWorkItemResult =
  | { ok: true; state: AgentState; workItem: AgentWorkItem }
  | AgentFailure;

/**
 * Moves a work item to a new status, stamping the timestamps that status
 * implies.
 *
 * Re-asserting the current status is a no-op that succeeds and leaves state
 * *entirely* untouched, `updatedAt` included — the same contract
 * transitionRunStatus offers, and for the same reason: a poll that reports
 * "still active" every few seconds must not rewrite the record and retrigger
 * every consumer downstream of it.
 *
 * `startedAt` is stamped only if absent, so an item that goes
 * active -> blocked -> active keeps the moment it *first* started rather than
 * having its history quietly rewritten by the second transition.
 */
export function transitionWorkItem(
  state: AgentState,
  workItemId: string,
  next: AgentWorkItemStatus,
  now: number
): TransitionWorkItemResult {
  const existing = findWorkItem(state, workItemId);
  if (!existing) return agentFailure("work-item-not-found");

  // Re-asserting a live status is a no-op; re-asserting a terminal one is
  // refused, so a caller can tell "nothing to do" from "that item is over".
  if (existing.status === next) {
    return isTerminalWorkItemStatus(existing.status)
      ? agentFailure("invalid-transition")
      : { ok: true, state, workItem: existing };
  }

  if (!canTransitionWorkItem(existing.status, next)) return agentFailure("invalid-transition");

  const workItem: AgentWorkItem = { ...existing, status: next, updatedAt: now };
  if (next === "active" && workItem.startedAt === undefined) workItem.startedAt = now;
  if (isTerminalWorkItemStatus(next)) workItem.completedAt = now;

  return {
    ok: true,
    state: {
      ...state,
      workItems: state.workItems.map((item) => (item.id === workItemId ? workItem : item)),
    },
    workItem,
  };
}

export type DeleteWorkItemResult = { ok: true; state: AgentState } | AgentFailure;

/**
 * Deletes one work item.
 *
 * One thing hangs off a work item: its evidence rows, which name it and are
 * meaningless without it. Those go.
 *
 * Nothing else does. A work item owns no links, no events and no artifacts —
 * its relationships to tabs and files are its *run's* relationships, and an
 * evidence row refines one of those rather than replacing it. So there is
 * deliberately no cascade outward: deleting an item must never remove the
 * artifacts or tab links its run accumulated, which belong to the run and
 * outlive any one item's lifetime.
 */
export function deleteWorkItem(state: AgentState, workItemId: string): DeleteWorkItemResult {
  if (!findWorkItem(state, workItemId)) return agentFailure("work-item-not-found");

  return {
    ok: true,
    state: {
      ...state,
      workItems: state.workItems.filter((item) => item.id !== workItemId),
      workItemEvidence: state.workItemEvidence.filter((row) => row.workItemId !== workItemId),
    },
  };
}

/**
 * Drops every work item belonging to a run.
 *
 * deleteRun calls this as part of its cascade — a work item has no meaning
 * without the run it describes.
 */
export function removeWorkItemsForRun(state: AgentState, runId: string): AgentState {
  const kept = state.workItems.filter((item) => item.runId !== runId);
  const keptEvidence = state.workItemEvidence.filter((row) => row.runId !== runId);
  if (kept.length === state.workItems.length && keptEvidence.length === state.workItemEvidence.length) {
    return state;
  }
  return { ...state, workItems: kept, workItemEvidence: keptEvidence };
}
