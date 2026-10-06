import { describeApproval } from "./timeline";
import { PROJECT_CHECK_LABELS } from "@/lib/agents/project/checks";
import { changeTotals, changedFiles } from "@/lib/agents/project/changes";
import type { AgentActivityEntry } from "./timeline";
import type { AgentSessionStatus } from "@/lib/agents/control/session";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { ProjectCheckId, VerificationOutcome } from "@/lib/agents/project/checks";
import type { RuntimeApprovalView, SequencedControlEvent } from "@/lib/agents/runtime/protocol";

/**
 * Where the agent's work stands, in one answer (Stage 3): the task the person
 * gave, whether the agent is working, waiting on them, done or stopped, what
 * changed, and whether the project's checks passed.
 *
 * The Command Centre's task status, the workspace's "where you left off" and
 * the landing demo all read this — so "Done · Changed 2 files · Tests passed"
 * is said one way everywhere.
 *
 * ## Where the facts come from
 *
 * Nothing here is new state. The session's status is the runtime's; the task
 * is the person's last message (or the instruction a handoff carried);
 * changes are Hubble's own measurements (`project_changed`, net of undo) and
 * the workspace changes the Command
 * Centre applied, as the activity timeline already folded them; checks are
 * the `verification_*` events since the newest change. A fact that is not in
 * the records is not said.
 */

export type TaskState = "ready" | "working" | "needs_you" | "done" | "failed" | "stopped";

export const TASK_STATE_LABEL: Record<TaskState, string> = {
  ready: "Ready",
  working: "Working",
  needs_you: "Needs you",
  done: "Done",
  failed: "Failed",
  stopped: "Stopped",
};

export type TaskCheck = { check: ProjectCheckId; label: string; outcome: VerificationOutcome };

export type TaskOutcome = {
  state: TaskState;
  /** One sentence: what is happening, or what happened. */
  headline: string;
  /** The person's latest instruction, on one line. Absent before the first one. */
  task?: string;
  /** Which task this is: the journal position of the message that gave it. -1 before the first. */
  taskSequence: number;
  changes: {
    /** Project files changed and still changed (undone changes are not counted). */
    files: number;
    added: number;
    removed: number;
    /** Whether Hubble could count lines for any of them. */
    counted: boolean;
    /** Applied workspace changes (collections) still standing. */
    workspace: number;
    /** A project change that only partly applied — worth a look before anything else. */
    partial: boolean;
    /** The newest project change still standing: what "Review changes" shows. */
    latestProjectChangeId?: string;
    /** The newest workspace change still standing: what "View" shows. */
    latestWorkspaceChangeId?: string;
  };
  /** The newest result of each check run since the newest change. Git status is not a check. */
  checks: readonly TaskCheck[];
  /** The approval the agent is stopped on, when it is. */
  approval?: { approvalId: string; description: string };
  /** Approvals the person rejected during the latest task. */
  rejected: number;
  /** When the newest record was made. 0 when there is none. */
  at: number;
};

/** Bounded, single-line text: an instruction is shown as one line, never as a document. */
export const TASK_TEXT_LIMIT = 160;

export function oneLine(text: string | undefined, limit = TASK_TEXT_LIMIT): string | undefined {
  if (!text) return undefined;
  const first = text
    .split(/\r?\n/)
    .map((line) => line.replace(/^\s*(?:[#>*-]+\s*)+/, "").trim())
    .find((line) => line.length > 0);
  if (!first) return undefined;
  const collapsed = first.replace(/\s+/g, " ");
  return collapsed.length > limit ? `${collapsed.slice(0, limit - 1).trimEnd()}…` : collapsed;
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

export function taskOutcome(input: {
  status: AgentSessionStatus;
  sessionId: string;
  events: readonly SequencedControlEvent[];
  /** The session's activity timeline (`buildAgentActivityTimeline`), oldest first. */
  entries: readonly AgentActivityEntry[];
  /** Approvals waiting on the person now. */
  approvals?: readonly RuntimeApprovalView[];
  /** Handoffs this session is part of — the one that started it carries its task. */
  handoffs?: readonly SessionHandoff[];
  agentName: string;
  projectName?: string;
}): TaskOutcome {
  const { status, events, entries, agentName } = input;
  const own = events.filter((event) => event.sessionId === input.sessionId);

  /* The latest task: the newest message the person sent (a handoff's first message is its instruction). */
  let taskStart = -1;
  let task: string | undefined;
  for (const event of own) {
    if (event.kind !== "message_sent") continue;
    taskStart = event.sequence;
    if (event.handoff) {
      const record = (input.handoffs ?? []).find((handoff) => handoff.handoffId === event.handoff!.handoffId);
      task = oneLine(record?.instruction) ?? "Continue the handed-off work";
    } else {
      task = oneLine(event.text);
    }
  }
  const turn = own.filter((event) => event.sequence > taskStart);

  /* What changed: Hubble's measurements, net of what was undone. */
  const undoneProject = new Set(
    own.filter((event) => event.kind === "project_change_undone" && event.projectUndo?.outcome === "undone").map((event) => event.projectUndo!.changeId)
  );
  const standing = own.filter(
    (event) => event.kind === "project_changed" && event.projectChange && event.projectChange.outcome !== "not_applied" && !undoneProject.has(event.projectChange.changeId)
  );
  const paths = new Set<string>();
  let added = 0;
  let removed = 0;
  let counted = false;
  let partial = false;
  for (const event of standing) {
    const info = event.projectChange!;
    const files = changedFiles(info);
    for (const file of files) paths.add(file.path);
    const totals = changeTotals(files);
    added += totals.added;
    removed += totals.removed;
    counted ||= totals.counted;
    partial ||= info.outcome === "partial";
  }
  const latestProject = standing[standing.length - 1];
  const notApplied = turn.some((event) => event.kind === "project_changed" && event.projectChange?.outcome === "not_applied");

  const undoneWorkspace = new Set(entries.filter((entry) => entry.kind === "undone" && entry.refs?.changeId).map((entry) => entry.refs!.changeId!));
  const workspaceChanges = entries.filter(
    (entry) =>
      (entry.kind === "workspace_updated" || entry.kind === "created") &&
      entry.status === "completed" &&
      entry.refs?.changeId &&
      !undoneWorkspace.has(entry.refs.changeId)
  );

  /* Checks since the newest change: an older result verified older code. */
  const since = latestProject?.sequence ?? -1;
  const latestCheck = new Map<ProjectCheckId, TaskCheck>();
  for (const event of own) {
    if (event.sequence <= since || !event.verification || event.verification.check === "git_status") continue;
    if (event.kind !== "verification_started" && event.kind !== "verification_finished") continue;
    const info = event.verification;
    latestCheck.set(info.check, { check: info.check, label: PROJECT_CHECK_LABELS[info.check], outcome: event.kind === "verification_started" ? "running" : info.outcome });
  }
  const checks = [...latestCheck.values()];

  const pending = (input.approvals ?? []).find((approval) => approval.sessionId === input.sessionId);
  const rejected = turn.filter((event) => event.kind === "approval_denied").length;
  const at = own.reduce((latest, event) => Math.max(latest, event.timestamp), 0);

  const changes = {
    files: paths.size,
    added,
    removed,
    counted,
    workspace: workspaceChanges.length,
    partial,
    ...(latestProject ? { latestProjectChangeId: latestProject.projectChange!.changeId } : {}),
    ...(workspaceChanges.length > 0 ? { latestWorkspaceChangeId: workspaceChanges[workspaceChanges.length - 1]!.refs!.changeId! } : {}),
  };
  const base = { ...(task ? { task } : {}), taskSequence: taskStart, changes, checks, rejected, at };

  const where = input.projectName ? ` in ${input.projectName}` : "";
  const doneHeadline = (): string => {
    if (notApplied && changes.files === 0) return "The approved change wasn't made — nothing changed";
    if (changes.partial) return `Partly applied${where} — check the project before continuing`;
    if (changes.files > 0) return `Changed ${plural(changes.files, "file", "files")}${where}`;
    if (changes.workspace > 0) return `Made ${plural(changes.workspace, "change", "changes")} to the workspace`;
    if (rejected > 0) return "Nothing changed — you rejected the change";
    if (undoneProject.size > 0 || undoneWorkspace.size > 0) return "Nothing changed — you undid the change";
    return "Answered — nothing changed";
  };

  switch (status) {
    case "waiting_for_approval":
      return {
        state: "needs_you",
        headline: pending ? `Approve: ${describeApproval(pending)}` : "Waiting for your approval",
        ...base,
        ...(pending ? { approval: { approvalId: pending.approvalId, description: describeApproval(pending) } } : {}),
      };
    case "waiting_for_input":
      return { state: "needs_you", headline: `${agentName} asked you a question`, ...base };
    case "connecting":
      return { state: "working", headline: `Connecting to ${agentName}…`, ...base };
    case "running": {
      const active = [...entries].reverse().find((entry) => entry.status === "active");
      return { state: "working", headline: active?.title ?? "Working on it…", ...base };
    }
    case "failed":
      return { state: "failed", headline: [...entries].reverse().find((entry) => entry.kind === "error")?.title ?? `${agentName} stopped unexpectedly`, ...base };
    case "disconnected":
      return { state: "failed", headline: `The connection to ${agentName} was lost`, ...base };
    case "cancelled":
      return { state: "stopped", headline: "Stopped before it finished", ...base };
    case "completed":
      return { state: "done", headline: doneHeadline(), ...base };
    case "created":
    case "ready": {
      if (taskStart < 0) return { state: "ready", headline: `${agentName} is ready for a task`, ...base };
      if (turn.some((event) => event.kind === "error")) {
        return { state: "failed", headline: [...entries].reverse().find((entry) => entry.kind === "error")?.title ?? `${agentName} stopped unexpectedly`, ...base };
      }
      if (turn.some((event) => event.kind === "run_cancelled")) return { state: "stopped", headline: "Stopped before it finished", ...base };
      // A message sent and no turn end yet: the runtime moves to running on its own.
      if (!turn.some((event) => event.kind === "run_completed")) return { state: "working", headline: "Working on it…", ...base };
      return { state: "done", headline: doneHeadline(), ...base };
    }
  }
}

/**
 * The outcome's facts as short phrases, for a line under the headline:
 * "+17 −6 · Tests passed · Lint failed", "Checks not run".
 */
export function taskOutcomeFacts(outcome: TaskOutcome, options: { checksAvailable?: boolean } = {}): string[] {
  const facts: string[] = [];
  const { changes } = outcome;
  if (changes.files > 0 && changes.counted) facts.push(`+${changes.added} −${changes.removed}`);
  if (changes.files > 0 && changes.workspace > 0) facts.push(plural(changes.workspace, "workspace change", "workspace changes"));
  for (const check of outcome.checks) facts.push(`${check.label} ${CHECK_OUTCOME_WORD[check.outcome]}`);
  if (outcome.checks.length === 0 && changes.files > 0 && options.checksAvailable) facts.push("Checks not run");
  return facts;
}

const CHECK_OUTCOME_WORD: Record<VerificationOutcome, string> = {
  running: "running…",
  passed: "passed",
  failed: "failed",
  timed_out: "timed out",
  unavailable: "couldn't run",
  error: "couldn't run",
};

/** Whether a finished task still asks something of the person: a failed check, a partial change. */
export function taskNeedsAttention(outcome: TaskOutcome): boolean {
  return outcome.state === "needs_you" || outcome.state === "failed" || outcome.changes.partial || outcome.checks.some((check) => check.outcome === "failed");
}
