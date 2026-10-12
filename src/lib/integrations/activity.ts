import { mintRecordId } from "./credentials";
import type { ActivityKind, ActivityOutcome, ActivityRecord } from "./records";
import type { IntegrationGrant } from "./grants";
import type { IntegrationStore } from "./store";
import type { ActivityView } from "./activity-labels";

export { ACTIVITY_KIND_LABEL, ACTIVITY_OUTCOME_LABEL } from "./activity-labels";
export type { ActivityView } from "./activity-labels";

/**
 * The integration audit log: what each connected AI client did, and what the
 * person decided about it.
 *
 * ## Why its own log
 *
 * Hubble's Agent Activity Timeline and Agent History describe *sessions*
 * Hubble's runtime hosts — a control session with an event journal. An
 * integration connection has neither: ChatGPT or Claude calls a tool and
 * leaves. Forcing those calls into session rows would invent sessions that
 * never ran. So this is a small, separate, durable record with the same
 * discipline as those stores — append-only, owner-scoped, bounded — and the
 * same vocabulary the timeline uses for the person-facing distinctions:
 * read, proposed, approved, declined, applied, failed.
 *
 * ## What it never holds
 *
 * Resource text, search queries, prompts, notes' bodies, tokens and
 * transcripts. `detail` is one of the fixed templates below; the only free
 * text a template may carry is a collection or workspace name, bounded,
 * which the person already owns and needs to recognise the action.
 */

/** Kept for 90 days. */
export const ACTIVITY_RETENTION_MS = 90 * 24 * 60 * 60 * 1000;
const MAX_TARGETS = 20;
const MAX_DETAIL = 160;

export function boundedName(value: string | undefined, max = 60): string {
  const name = (value ?? "").replace(/[\u0000-\u001f\u007f]/g, "").trim();
  if (!name) return "Untitled";
  return name.length > max ? `${name.slice(0, max - 1)}…` : name;
}

export type ActivityInput = {
  kind: ActivityKind;
  operation: string;
  outcome: ActivityOutcome;
  workspaceId?: string;
  targets?: readonly string[];
  errorCategory?: string;
  detail?: string;
};

export function activityRecord(grant: Pick<IntegrationGrant, "userId" | "connectionId" | "client" | "actor">, input: ActivityInput, at: number): ActivityRecord {
  return {
    id: mintRecordId("act"),
    userId: grant.userId,
    ...(grant.connectionId ? { connectionId: grant.connectionId } : {}),
    client: grant.client,
    actor: grant.actor,
    kind: input.kind,
    operation: input.operation,
    ...(input.workspaceId ? { workspaceId: input.workspaceId } : {}),
    targets: [...(input.targets ?? [])].slice(0, MAX_TARGETS),
    outcome: input.outcome,
    ...(input.errorCategory ? { errorCategory: input.errorCategory } : {}),
    ...(input.detail ? { detail: input.detail.slice(0, MAX_DETAIL) } : {}),
    at,
  };
}

/** A person's own action in Hubble (approving, declining, disconnecting). */
export function userActivity(userId: string, input: ActivityInput & { connectionId?: string }, at: number): ActivityRecord {
  const { connectionId, ...rest } = input;
  const record = activityRecord({ userId, actor: "user", client: "other" }, rest, at);
  // The person acted, not a client.
  delete record.client;
  return connectionId ? { ...record, connectionId } : record;
}

/**
 * Appends one record, best effort. The audit log never turns a completed
 * action into a reported failure — but a write that was *refused* is still
 * refused whether or not its refusal could be logged.
 */
export async function recordActivity(store: IntegrationStore | undefined, record: ActivityRecord): Promise<void> {
  if (!store) return;
  try {
    await store.appendActivity(record);
    // Prune occasionally rather than on every write.
    if (record.id.charCodeAt(record.id.length - 1) % 16 === 0) {
      await store.pruneActivity(record.userId, record.at - ACTIVITY_RETENTION_MS);
    }
  } catch {
    // Observational.
  }
}

export function toActivityView(record: ActivityRecord): ActivityView {
  return {
    id: record.id,
    at: record.at,
    kind: record.kind,
    operation: record.operation,
    outcome: record.outcome,
    actor: record.actor,
    ...(record.client ? { client: record.client } : {}),
    ...(record.connectionId ? { connectionId: record.connectionId } : {}),
    ...(record.workspaceId ? { workspaceId: record.workspaceId } : {}),
    ...(record.detail ? { detail: record.detail } : {}),
    ...(record.errorCategory ? { errorCategory: record.errorCategory } : {}),
  };
}
