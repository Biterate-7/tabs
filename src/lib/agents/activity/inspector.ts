import { describeApproval } from "./timeline";
import { isLiveSession } from "@/lib/agents/command-centre/presentation";
import { collectionToView, undoEffects } from "@/lib/agents/command-centre/workspace-activity";
import { relativePathBasename } from "@/lib/agents/paths";
import type { ActivityRefs, AgentActivityEntry } from "./timeline";
import type { AppliedWorkspaceChange, WorkspaceChangeStep } from "@/lib/agents/command-centre/workspace-activity";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentVisualState } from "@/lib/agents/visual/types";
import type {
  RuntimeApprovalView,
  RuntimePlanOutcomeView,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";

/**
 * The action inspector's model: one action an agent asked for or took, told
 * from request to result — and, where Hubble knows the exact inverse, how to
 * take it back.
 *
 *     Created collection “Pricing Research”          Completed
 *     Requested by Claude Code · Approved · Applied
 *     Action    Create collection
 *     Changes   + Collection “Pricing Research” · 5 tabs
 *     [Open collection]  [Undo]
 *
 * ## Joined by reference, never by wording
 *
 * An activity entry carries the ids of what it came from (`refs`: approval,
 * applied change, plan, file). Clicking any entry of one action — "Waiting
 * for approval", "Action approved", "Created …" — resolves the same action
 * from those ids and the session's own records: the approval as the broker
 * reported it, the decision event in the journal, the change the Command
 * Centre applied, the plan's verified outcome. Nothing is reconstructed from
 * a title, and nothing is inferred: an action is "completed" only once the
 * record of its result exists, never because it was requested or approved.
 *
 * ## Pure, and so persistence-ready
 *
 * The same records the timeline reads, in, one inspection out. A future
 * durable journal that replays those records gives the same answer; nothing
 * here holds state.
 *
 * ## User-facing only
 *
 * No ids, tool names, protocol verbs, payloads or paths outside the project
 * reach the result — only names, counts and project-relative file paths, the
 * same vocabulary the timeline and the approval card already use.
 */

export type ActionStatus =
  | "waiting_for_approval"
  | "approved"
  | "running"
  | "completed"
  | "failed"
  | "rejected"
  | "expired"
  | "withdrawn"
  | "undone";

export const ACTION_STATUS_LABEL: Record<ActionStatus, string> = {
  waiting_for_approval: "Waiting for approval",
  approved: "Approved",
  running: "Running",
  completed: "Completed",
  failed: "Failed",
  rejected: "Rejected",
  expired: "Approval expired",
  withdrawn: "Withdrawn",
  undone: "Undone",
};

/**
 * Each action status in the shared visual vocabulary — the same states, and
 * so the same tones, a session's own status pill uses. A waiting action looks
 * like a waiting session; a failed one like a failed session.
 */
export const ACTION_VISUAL_STATE: Record<ActionStatus, AgentVisualState> = {
  waiting_for_approval: "waiting",
  approved: "idle",
  running: "working",
  completed: "success",
  failed: "error",
  rejected: "idle",
  expired: "idle",
  withdrawn: "idle",
  undone: "idle",
};

/** One step of request → approval → result → undo, in order. */
export type ActionChainStep = {
  key: "requested" | "decision" | "running" | "result" | "undone";
  label: string;
  at?: number;
  tone: "done" | "active" | "waiting" | "failed" | "neutral";
};

export type ActionChangeLine = { sign: "add" | "change" | "remove"; text: string };

export type ActionUndo =
  /** Hubble knows the exact inverse and the workspace still holds what the change left. */
  | { kind: "available"; changeId: string; effects: readonly string[]; label: "Undo" | "Undo all" }
  | { kind: "unavailable"; reason: string }
  | { kind: "done"; at?: number };

export type ActionInspection = {
  /** Stable for the action whichever of its entries opened it: the approval, else the change, else the entry. */
  key: string;
  title: string;
  status: ActionStatus;
  agentName: string;
  provider: AgentProviderId;
  workspaceName?: string;
  /** What kind of action, in words: "Create collection", "Edit file". */
  action?: string;
  chain: readonly ActionChainStep[];
  /** What was asked, when an approval stood behind it. */
  request?: { summary: string; reason?: string; at?: number };
  result?: { tone: "success" | "warning" | "failure" | "neutral"; text: string };
  /** What changed — or, before there is a result, what was asked for (`planned`). */
  changes?: { planned: boolean; lines: readonly ActionChangeLine[] };
  /** The applied change to show in the workspace, and what to call that. */
  view?: { changeId: string; label: "Open collection" | "View changes" };
  /** A file the action is about, project-relative. Hubble cannot open project files, so it is named, not linked. */
  file?: { relativePath: string; projectName?: string };
  undo?: ActionUndo;
};

export type ActionInspectorInput = {
  /** The session's timeline, as `buildAgentActivityTimeline` built it from these same records. */
  entries: readonly AgentActivityEntry[];
  session: RuntimeSessionView;
  events: readonly SequencedControlEvent[];
  approvals?: readonly RuntimeApprovalView[];
  knownApprovals?: ReadonlyMap<string, RuntimeApprovalView>;
  changes?: readonly AppliedWorkspaceChange[];
  agentName: string;
  workspaceName?: string;
  projectName?: string;
  /**
   * Whether an applied change can be undone exactly right now — the workspace
   * still holds what it left. Decided by the owner of the workspace; absent
   * means no undo is offered.
   */
  canUndo?: (change: AppliedWorkspaceChange) => boolean;
};

/** Whether an entry stands for an action there is more to say about. Lifecycle and reads are not. */
export function isInspectable(entry: AgentActivityEntry): boolean {
  const refs = entry.refs;
  return Boolean(refs && (refs.approvalId || refs.changeId || refs.planId || refs.file));
}

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

const APPROVAL_ACTION: Record<string, string> = {
  create_files: "Create file",
  modify_files: "Edit file",
  delete_files: "Delete file",
  run_command: "Run a command",
  network_request: "Use the network",
  use_mcp_tool: "Use a tool",
  change_workspace: "Change the workspace",
};

const CHANGE_KIND_ACTION: Record<string, string> = {
  create_collection: "Create collection",
  rename_collection: "Rename collection",
  add_tabs_to_collection: "Add tabs to a collection",
};

const STEP_ACTION: Record<WorkspaceChangeStep["kind"], string> = {
  created: "Create collection",
  renamed: "Rename collection",
  added: "Add tabs to a collection",
};

function stepLine(step: WorkspaceChangeStep): ActionChangeLine {
  switch (step.kind) {
    case "created":
      return { sign: "add", text: `Collection “${step.name}” · ${plural(step.tabCount, "tab", "tabs")}` };
    case "renamed":
      return { sign: "change", text: step.previousName ? `“${step.previousName}” renamed to “${step.name}”` : `Renamed to “${step.name}”` };
    case "added":
      return { sign: "add", text: `${plural(step.tabCount, "tab", "tabs")} added to “${step.name}”` };
  }
}

function plannedLine(step: { kind: string; subject: string; to?: string; tabCount?: number }): ActionChangeLine {
  switch (step.kind) {
    case "create_collection":
      return { sign: "add", text: `Collection “${step.subject}”${step.tabCount ? ` · ${plural(step.tabCount, "tab", "tabs")}` : ""}` };
    case "rename_collection":
      return { sign: "change", text: `“${step.subject}” renamed to “${step.to ?? ""}”` };
    default:
      return { sign: "add", text: `${plural(step.tabCount ?? 0, "tab", "tabs")} added to “${step.subject}”` };
  }
}

/** What an approval asked for, line by line, before anything happened. */
function plannedLines(view: RuntimeApprovalView): ActionChangeLine[] {
  if (view.plan) return view.plan.steps.map(plannedLine);
  if (view.change) return [plannedLine(view.change)];
  if (view.action === "create_files" || view.action === "modify_files" || view.action === "delete_files") {
    const sign = view.action === "create_files" ? "add" : view.action === "delete_files" ? "remove" : "change";
    return view.targets.map((target) => ({ sign, text: target }));
  }
  return [];
}

function actionOf(change: AppliedWorkspaceChange | undefined, view: RuntimeApprovalView | undefined, file: ActivityRefs["file"]): string | undefined {
  if (change?.ok && change.steps.length === 1) return STEP_ACTION[change.steps[0]!.kind];
  if (change?.ok && change.steps.length > 1) return "Change the workspace";
  if (view?.plan) return view.plan.steps.length === 1 ? CHANGE_KIND_ACTION[view.plan.steps[0]!.kind] : "Change the workspace";
  if (view?.change) return CHANGE_KIND_ACTION[view.change.kind];
  if (view) {
    const label = APPROVAL_ACTION[view.action];
    if (label && (view.action === "create_files" || view.action === "modify_files" || view.action === "delete_files") && view.targets.length > 1) {
      return `${label}s`;
    }
    return label;
  }
  if (file) return file.operation === "created" ? "Create file" : "Edit file";
  return undefined;
}

export function inspectActivityEntry(entryId: string, input: ActionInspectorInput): ActionInspection | null {
  const entry = input.entries.find((candidate) => candidate.id === entryId);
  if (!entry || !isInspectable(entry)) return null;
  const refs = entry.refs!;
  const { session, agentName } = input;
  const sessionId = session.sessionId;
  const workspaceId = session.workspaceId ?? session.context?.workspaceId;
  const where = input.workspaceName ?? "the workspace";

  // Only this session's records, in this session's workspace — whatever the caller passed.
  const changes = (input.changes ?? []).filter(
    (change) => change.sessionId === sessionId && (!workspaceId || change.workspaceId === workspaceId)
  );
  const events = input.events.filter((event) => event.sessionId === sessionId);
  const outcomes = session.context?.planOutcomes ?? [];

  /* ---------------- Resolve the action from its references. */

  let change = refs.changeId ? changes.find((candidate) => candidate.id === refs.changeId) : undefined;
  let approvalId = refs.approvalId ?? change?.approvalId;
  let outcome: RuntimePlanOutcomeView | undefined =
    (approvalId ? outcomes.find((candidate) => candidate.approvalId === approvalId) : undefined) ??
    (refs.planId ? outcomes.find((candidate) => candidate.planId === refs.planId) : undefined) ??
    (change?.planId ? outcomes.find((candidate) => candidate.planId === change!.planId) : undefined);
  change ??=
    (approvalId ? changes.find((candidate) => candidate.approvalId === approvalId) : undefined) ??
    (outcome ? changes.find((candidate) => candidate.planId === outcome!.planId) : undefined);
  approvalId ??= outcome?.approvalId;
  if (!outcome && change?.planId) outcome = outcomes.find((candidate) => candidate.planId === change!.planId);

  const pending = (input.approvals ?? []).find((view) => view.approvalId === approvalId && view.sessionId === sessionId);
  const remembered = approvalId ? input.knownApprovals?.get(approvalId) : undefined;
  const view = pending ?? (remembered?.sessionId === sessionId ? remembered : undefined);

  const requestEntry = approvalId ? input.entries.find((candidate) => candidate.id === `approval:${approvalId}`) : undefined;
  const requestEvent = approvalId
    ? events.find((event) => event.kind === "approval_requested" && event.approvalId === approvalId)
    : undefined;
  const decision = approvalId
    ? events.find((event) => (event.kind === "approval_granted" || event.kind === "approval_denied") && event.approvalId === approvalId)
    : undefined;

  const fileEntry = refs.file
    ? entry
    : approvalId
      ? input.entries.find((candidate) => candidate.refs?.file && candidate.refs.approvalId === approvalId)
      : undefined;
  const file = fileEntry?.refs?.file;
  // A command, or a step that failed, that this approval stood behind.
  const stepEntry =
    approvalId && !fileEntry
      ? input.entries.find(
          (candidate) =>
            candidate.refs?.approvalId === approvalId &&
            !candidate.refs.changeId &&
            !candidate.refs.planId &&
            (candidate.kind === "command" || candidate.kind === "action_failed")
        )
      : undefined;
  const changeEntry = change ? input.entries.find((candidate) => candidate.id === `change:${change!.id}`) : undefined;
  const planEntry = outcome ? input.entries.find((candidate) => candidate.id === `plan:${outcome!.planId}`) : undefined;
  const resultEntry = changeEntry ?? fileEntry ?? stepEntry ?? planEntry;

  /* ---------------- Where it stands — from the records, never assumed. */

  const live = isLiveSession(session.status);
  const status = ((): ActionStatus => {
    if (change) return !change.ok ? "failed" : change.undone ? "undone" : "completed";
    if (outcome) {
      switch (outcome.status) {
        case "applied":
        case "unverified":
          return "completed";
        case "not_applied":
        case "stale":
          return "failed";
        case "denied":
          return "rejected";
        case "expired":
          return "expired";
        case "cancelled":
          return "withdrawn";
      }
    }
    if (resultEntry) return resultEntry.status === "failed" ? "failed" : "completed";
    if (decision?.kind === "approval_denied") return "rejected";
    if (decision?.kind === "approval_granted") return live && session.status === "running" ? "running" : "approved";
    if (requestEntry?.kind === "approval_closed") return requestEntry.title === "Approval expired" ? "expired" : "withdrawn";
    if (requestEntry?.status === "waiting") return "waiting_for_approval";
    // Asked, and no longer waiting, with no decision on record: the request ended unanswered.
    if (requestEntry) return "withdrawn";
    return entry.status === "failed" ? "failed" : "completed";
  })();

  /* ---------------- Words. */

  const requestSummary = view ? describeApproval(view) : requestEntry?.description;
  const finished = status === "completed" || status === "undone" || status === "failed";
  // A step that failed without saying which file ("A step didn't work") is
  // named by what was approved instead: the pill already says it failed.
  const genericFailure = resultEntry === stepEntry && stepEntry?.kind === "action_failed" && requestSummary !== undefined;
  const title = (finished && !genericFailure ? resultEntry?.title : undefined) ?? requestSummary ?? entry.title;

  const request =
    approvalId && (view || requestEntry || requestEvent)
      ? {
          summary: requestSummary ?? "An action that needed your approval",
          ...(view?.reason ? { reason: view.reason } : {}),
          // The journal's time first — the same instant the timeline row shows.
          ...((requestEvent?.timestamp ?? view?.requestedAt ?? requestEntry?.at) !== undefined
            ? { at: requestEvent?.timestamp ?? view?.requestedAt ?? requestEntry?.at }
            : {}),
        }
      : undefined;

  const resultAt = change?.at ?? outcome?.at ?? (resultEntry ? (resultEntry.completedAt ?? resultEntry.at) : undefined);
  const result = ((): ActionInspection["result"] => {
    switch (status) {
      case "completed":
      case "undone": {
        if (outcome?.status === "unverified") {
          return {
            tone: "warning",
            text: `Only ${outcome.verifiedCount} of ${plural(outcome.operationCount, "change", "changes")} could be confirmed — check the workspace.`,
          };
        }
        if (change?.ok) {
          const [first] = change.steps;
          if (change.steps.length === 1 && first?.kind === "created") return { tone: "success", text: `Created “${first.name}” in ${where}.` };
          return { tone: "success", text: `Applied ${plural(change.steps.length, "change", "changes")} to ${where}.` };
        }
        if (file) {
          const project = input.projectName ? ` in ${input.projectName}` : "";
          return {
            tone: "success",
            text: file.operation === "created" ? `Created ${file.relativePath}${project}.` : `Saved changes to ${file.relativePath}${project}.`,
          };
        }
        if (outcome) return { tone: "success", text: `Applied ${plural(outcome.operationCount, "change", "changes")} to ${where}.` };
        if (resultEntry?.kind === "command") return { tone: "success", text: "The command finished." };
        return { tone: "success", text: "Done." };
      }
      case "failed": {
        if (change && !change.ok) return { tone: "failure", text: "Couldn't apply the approved change. Nothing was changed." };
        if (outcome?.status === "stale") return { tone: "failure", text: "The workspace changed while you were deciding. Nothing was changed." };
        if (outcome) return { tone: "failure", text: "The approved changes weren't applied. Nothing was changed." };
        if (file) {
          const verb = file.operation === "created" ? "create" : "edit";
          return { tone: "failure", text: `${agentName} couldn't ${verb} ${relativePathBasename(file.relativePath)}.` };
        }
        return { tone: "failure", text: `${agentName} reported that it didn't work.` };
      }
      case "rejected":
        return { tone: "neutral", text: "You rejected it. Nothing was changed." };
      case "expired":
        return { tone: "neutral", text: "Nobody answered in time, so nothing was changed." };
      case "withdrawn":
        return { tone: "neutral", text: "The request was withdrawn before it was answered. Nothing was changed." };
      case "running":
        return { tone: "neutral", text: `Approved — ${agentName} is carrying it out.` };
      case "approved":
        return { tone: "neutral", text: "Approved. No result has been reported yet." };
      case "waiting_for_approval":
        return undefined;
    }
  })();

  /* ---------------- What changed, or what was asked to. */

  let changesSection: ActionInspection["changes"];
  if (change?.ok && change.steps.length > 0) {
    changesSection = { planned: false, lines: change.steps.map(stepLine) };
  } else if (file && (status === "completed" || status === "undone")) {
    changesSection = { planned: false, lines: [{ sign: file.operation === "created" ? "add" : "change", text: file.relativePath }] };
  } else if (!finished && view) {
    const lines = plannedLines(view);
    if (lines.length > 0) changesSection = { planned: true, lines };
  }

  /* ---------------- The chain: request → decision → result → undo. */

  const chain: ActionChainStep[] = [];
  if (request) chain.push({ key: "requested", label: `Requested by ${agentName}`, ...(request.at !== undefined ? { at: request.at } : {}), tone: "done" });
  if (approvalId) {
    if (decision) {
      const granted = decision.kind === "approval_granted";
      chain.push({ key: "decision", label: granted ? "Approved" : "Rejected", at: decision.timestamp, tone: granted ? "done" : "neutral" });
    } else if (status === "waiting_for_approval") {
      chain.push({ key: "decision", label: "Waiting for approval", tone: "waiting" });
    } else if (status === "expired" || status === "withdrawn" || status === "rejected") {
      chain.push({ key: "decision", label: ACTION_STATUS_LABEL[status], ...(outcome ? { at: outcome.at } : {}), tone: "neutral" });
    }
  }
  if (status === "running") chain.push({ key: "running", label: "Running", tone: "active" });
  if (finished) {
    chain.push({
      key: "result",
      label: status === "failed" ? "Failed" : "Completed",
      ...(resultAt !== undefined ? { at: resultAt } : {}),
      tone: status === "failed" ? "failed" : "done",
    });
  }
  if (status === "undone") chain.push({ key: "undone", label: "Undone", ...(change?.undoneAt !== undefined ? { at: change.undoneAt } : {}), tone: "done" });

  /* ---------------- What can be done with it. */

  const viewTarget: ActionInspection["view"] =
    change?.ok && !change.undone && change.steps.length > 0
      ? {
          changeId: change.id,
          label: change.steps.length === 1 && change.steps[0]!.kind === "created" && collectionToView(change) ? "Open collection" : "View changes",
        }
      : undefined;

  const undo = ((): ActionUndo | undefined => {
    if (status === "undone") return { kind: "done", ...(change?.undoneAt !== undefined ? { at: change.undoneAt } : {}) };
    if (status !== "completed") return undefined;
    if (change?.ok) {
      if (!change.before || !change.after) return { kind: "unavailable", reason: "Undo isn't available for this change." };
      if (!input.canUndo?.(change)) {
        return {
          kind: "unavailable",
          reason: "Undo isn't available — the workspace has changed since, and undoing now would discard those later edits.",
        };
      }
      return { kind: "available", changeId: change.id, effects: undoEffects(change), label: change.steps.length > 1 ? "Undo all" : "Undo" };
    }
    if (file) {
      return {
        kind: "unavailable",
        reason: "Undo isn't available for this change. Hubble doesn't keep a copy of the files agents write, so it can't safely put them back.",
      };
    }
    if (resultEntry?.kind === "command") return { kind: "unavailable", reason: "Undo isn't available for this change. Hubble can't reverse a command." };
    return { kind: "unavailable", reason: "Undo isn't available for this change." };
  })();

  const action = actionOf(change, view, file);

  return {
    key: approvalId ? `approval:${approvalId}` : change ? `change:${change.id}` : entry.id,
    title,
    status,
    agentName,
    provider: session.provider,
    ...(input.workspaceName ? { workspaceName: input.workspaceName } : {}),
    ...(action ? { action } : {}),
    chain,
    ...(request ? { request } : {}),
    ...(result ? { result } : {}),
    ...(changesSection ? { changes: changesSection } : {}),
    ...(viewTarget ? { view: viewTarget } : {}),
    ...(file ? { file: { relativePath: file.relativePath, ...(input.projectName ? { projectName: input.projectName } : {}) } } : {}),
    ...(undo ? { undo } : {}),
  };
}
