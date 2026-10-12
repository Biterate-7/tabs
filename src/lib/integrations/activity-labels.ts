import type { ActivityKind, ActivityOutcome, ActivityRecord } from "./records";

/**
 * The audit log as the settings pane reads it: labels and the view shape.
 *
 * Kept apart from ./activity.ts, which mints record ids with node:crypto and
 * must never reach the browser bundle. Nothing here imports a Node module.
 */

export const ACTIVITY_KIND_LABEL: Record<ActivityKind, string> = {
  read: "Read",
  write: "Saved",
  proposal: "Proposed",
  approval: "Approved",
  decline: "Declined",
  apply: "Applied",
  connection: "Connection",
};

export const ACTIVITY_OUTCOME_LABEL: Record<ActivityOutcome, string> = {
  ok: "Done",
  denied: "Not permitted",
  failed: "Failed",
  pending: "Waiting for you",
  partial: "Partly done",
};

/** The person-facing view of a record. Ids stay ids; nothing is looked up or invented. */
export type ActivityView = {
  id: string;
  at: number;
  kind: ActivityKind;
  operation: string;
  outcome: ActivityOutcome;
  actor: ActivityRecord["actor"];
  client?: ActivityRecord["client"];
  connectionId?: string;
  workspaceId?: string;
  detail?: string;
  errorCategory?: string;
};
