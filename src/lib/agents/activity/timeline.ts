import { describeStep, describeUndo } from "@/lib/agents/command-centre/workspace-activity";
import {
  APPROVAL_CLOSED_TITLE,
  APPROVAL_REQUESTED_TITLE,
  APPROVAL_STATE_LABEL,
  agentStoppedUnexpectedly,
  isLiveSession,
  isTerminalSession,
  toolStage,
} from "@/lib/agents/command-centre/presentation";
import { relativePathBasename } from "@/lib/agents/paths";
import { agentDisplayName, handoffPassedLine } from "@/lib/agents/handoff/handoff";
import type { SessionHandoff } from "@/lib/agents/handoff/handoff";
import type { AppliedWorkspaceChange, WorkspaceChangeStep } from "@/lib/agents/command-centre/workspace-activity";
import type { ContextToolStage } from "@/lib/agents/command-centre/presentation";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { ControlContextInfo } from "@/lib/agents/control/events";
import type {
  RuntimeApprovalView,
  RuntimePlanOutcomeView,
  RuntimeSessionView,
  SequencedControlEvent,
} from "@/lib/agents/runtime/protocol";

/**
 * The agent activity timeline: what one agent session did in its workspace,
 * in order, in a person's words.
 *
 *     Claude Code connected            · Working in Research
 *     Workspace context loaded         · 18 tabs · 3 collections
 *     Read workspace                   · 18 tabs · 3 collections
 *     Found 14 relevant tabs           · Searched Research
 *     Asked for approval               · Create collection “Physics” · 4 tabs
 *     Approved
 *     Created collection “Physics”     · 4 tabs
 *
 * ## Where every entry comes from
 *
 * Nothing here is invented, timed or simulated. Each entry is derived from a
 * record that already exists for the session:
 *
 *   - the runtime's **event journal** (`SequencedControlEvent`, the same
 *     stream the conversation renders) — lifecycle, tool and file work,
 *     approvals, and the context server's own `context_loaded` /
 *     `context_read` events, which carry the real counts;
 *   - the **pending approvals** the broker reports, for what an approval asks;
 *   - the **workspace changes** the Command Centre applied
 *     (./command-centre/workspace-activity.ts), for what actually changed;
 *   - the session's **status**, for whether anything is still in progress.
 *
 * It is a pure function of those, so re-running it on the same records gives
 * the same timeline, and a remount, a reconnect or a re-read of the journal
 * from the start reproduces it exactly — which is the whole persistence story:
 * the journal is the record, and this is a view of it.
 *
 * ## The rules it keeps
 *
 * - **Stable ids.** Every entry's id comes from its source — an event id, an
 *   approval id, a change id — never from its position, so a row keeps its
 *   identity as the stream grows.
 * - **One fact, one entry.** The same approval answered twice, the same file
 *   created by two layers, or the same event delivered twice produces one
 *   entry. The journal already deduplicates on the wire; this deduplicates by
 *   meaning.
 * - **Grouped for people.** Fifteen reads in a row are "Read workspace"; a run
 *   of commands is "Ran 3 commands". The timeline is for understanding, not a
 *   log.
 * - **Only live work is active.** Something is "in progress" only while the
 *   runtime says the session is live; a session that ended leaves nothing
 *   spinning.
 * - **One session, one workspace.** Records belonging to another session or
 *   another workspace are ignored, whatever the caller passes.
 *
 * Provider-neutral: no branch here names an agent. The agent's name is passed
 * in, and its mark is drawn by the component.
 */

export type AgentActivityKind =
  | "connecting"
  | "connected"
  | "connection_failed"
  | "context_loaded"
  | "context_unavailable"
  | "reading"
  | "searching"
  | "analyzing"
  | "checking"
  | "context_failed"
  | "thinking"
  | "working"
  | "replying"
  | "replied"
  | "message_sent"
  | "waiting_for_input"
  | "approval_required"
  | "action_requested"
  | "action_approved"
  | "action_rejected"
  | "approval_closed"
  | "files_read"
  | "created"
  | "updated"
  | "command"
  | "workspace_updated"
  /** A workspace change the person undid — told after the change, which keeps its own entry. */
  | "undone"
  /** The person handed this session's work to another agent (Hubble 1.4). */
  | "handoff_sent"
  /** A handoff that did not reach the other agent. */
  | "handoff_failed"
  /** This session was started by a handoff. */
  | "handoff_received"
  | "action_failed"
  | "error"
  | "completed"
  | "cancelled"
  | "disconnected"
  | "ended";

/**
 * - `active` — in progress right now (only while the session is live);
 * - `waiting` — stopped on the person: an approval or a question;
 * - `completed` — something that happened and worked;
 * - `failed` — something that did not;
 * - `info` — a quieter fact: connected, context loaded, a message sent.
 */
export type AgentActivityStatus = "active" | "waiting" | "completed" | "failed" | "info";

/** Counts only — the safe metadata an entry may carry, for display and for later features. */
export type AgentActivityMetadata = {
  tabs?: number;
  collections?: number;
  matches?: number;
  groups?: number;
  files?: number;
};

export type AgentActivityAction =
  /** Show what an applied workspace change did. */
  | { kind: "view_change"; changeId: string }
  /** The session cannot continue; a new one can. */
  | { kind: "new_session" }
  /** The session on the other end of a handoff. */
  | { kind: "open_session"; sessionId: string; provider: AgentProviderId };

export type AgentActivityEntry = {
  /** Stable, derived from the source record. Never shown. */
  id: string;
  sessionId: string;
  workspaceId?: string;
  provider: AgentProviderId;
  kind: AgentActivityKind;
  status: AgentActivityStatus;
  title: string;
  description?: string;
  /** When it started (ms). Entries are in this order, oldest first. */
  at: number;
  /** When it finished, when that is later than it started. */
  completedAt?: number;
  /** How many underlying records this entry stands for. */
  count: number;
  metadata?: AgentActivityMetadata;
  action?: AgentActivityAction;
  /**
   * What it came from: the approval, the applied change, the plan and the file
   * it is about. The action inspector (./inspector.ts) joins on these — never
   * on the title — and undo acts on `changeId`. Never shown as ids.
   */
  refs?: ActivityRefs;
};

export type ActivityRefs = {
  approvalId?: string;
  changeId?: string;
  planId?: string;
  sequence?: number;
  /** The project file a file entry is about. Project-relative, as the event carried it. */
  file?: { relativePath: string; projectId: string; operation: "created" | "updated" };
  /** The handoff a handoff entry is about (Hubble 1.4). */
  handoffId?: string;
};

export type AgentActivityInput = {
  session: RuntimeSessionView;
  events: readonly SequencedControlEvent[];
  /** Approvals waiting on the person now, as the runtime reports them. */
  approvals?: readonly RuntimeApprovalView[];
  /** Approvals seen earlier and since answered, so their entry can still say what they asked. */
  knownApprovals?: ReadonlyMap<string, RuntimeApprovalView>;
  /**
   * Plans' verified outcomes. Absent: the live session's own
   * (`session.context.planOutcomes`). Agent history passes the ones it kept,
   * because a session read back from history holds no live context.
   */
  planOutcomes?: readonly RuntimePlanOutcomeView[];
  /** Workspace changes the Command Centre applied. Filtered to this session and workspace here. */
  changes?: readonly AppliedWorkspaceChange[];
  /** Handoffs this session was part of, for what each passed (Hubble 1.4). The events say that they happened. */
  handoffs?: readonly SessionHandoff[];
  agentName: string;
  /** Another agent's name — the one on the other end of a handoff. Defaults to the catalog's. */
  agentNameOf?: (provider: AgentProviderId) => string;
  /** The session's workspace by its live name. */
  workspaceName?: string;
  now: number;
};

/* ------------------------------------------------------------------ *
 * Words
 * ------------------------------------------------------------------ */

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`;

/** "18 tabs · 3 collections" — counts that are known, nothing that is not. */
export function activityCountsLine(metadata: AgentActivityMetadata | undefined): string | undefined {
  if (!metadata) return undefined;
  const parts: string[] = [];
  if (metadata.tabs !== undefined) parts.push(plural(metadata.tabs, "tab", "tabs"));
  if (metadata.collections !== undefined) parts.push(plural(metadata.collections, "collection", "collections"));
  return parts.length > 0 ? parts.join(" · ") : undefined;
}

const APPROVAL_VERB: Record<string, string> = {
  create_files: "Create",
  modify_files: "Edit",
  delete_files: "Delete",
  run_command: "Run a command",
  network_request: "Use the network",
  use_mcp_tool: "Use a tool",
  change_workspace: "Change the workspace",
};

/** Actions whose targets are files, so the first target names what is acted on. */
const FILE_ACTIONS = new Set(["create_files", "modify_files", "delete_files"]);

function quoted(name: string): string {
  return `“${name}”`;
}

function shortStep(step: { kind: string; subject: string; to?: string; tabCount?: number }): string {
  switch (step.kind) {
    case "create_collection":
      return `Create collection ${quoted(step.subject)}${step.tabCount ? ` · ${plural(step.tabCount, "tab", "tabs")}` : ""}`;
    case "rename_collection":
      return `Rename ${quoted(step.subject)} to ${quoted(step.to ?? "")}`;
    case "add_tabs_to_collection":
      return `Add ${plural(step.tabCount ?? 0, "tab", "tabs")} to ${quoted(step.subject)}`;
    default:
      return "Change the workspace";
  }
}

/**
 * What an approval asks, in one short line: "Create research-summary.md",
 * "Create collection “Physics” · 4 tabs", "3 changes · 12 tabs". Built from
 * the approval's own structured fields; never a command line — the approval
 * card is the place for the exact command.
 */
export function describeApproval(approval: RuntimeApprovalView): string {
  if (approval.plan) {
    const [first] = approval.plan.steps;
    if (approval.plan.steps.length === 1 && first) return shortStep(first);
    return `${plural(approval.plan.operationCount, "change", "changes")} · ${plural(approval.plan.tabCount, "tab", "tabs")}`;
  }
  if (approval.change) return shortStep(approval.change);

  const verb = APPROVAL_VERB[approval.action] ?? "Do something that needs approval";
  const [target] = approval.targets;
  if (FILE_ACTIONS.has(approval.action) && target) {
    const more = approval.targets.length - 1;
    return `${verb} ${relativePathBasename(target)}${more > 0 ? ` and ${more} more` : ""}`;
  }
  return verb;
}

/** A summary the event carried, if it is worth repeating. */
function safeSummary(summary: string | undefined): string | undefined {
  const trimmed = summary?.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.replace(/\.$/, "") : undefined;
}

/* ------------------------------------------------------------------ *
 * Context reads
 * ------------------------------------------------------------------ */

type ReadFamily = "read" | "search" | "related" | "analyze" | "duplicates" | "check";

const READ_FAMILY: Partial<Record<string, ReadFamily>> = {
  search_tabs: "search",
  find_related_tabs: "related",
  analyze_topics: "analyze",
  get_topic_group: "analyze",
  list_domains: "analyze",
  find_duplicate_tabs: "duplicates",
  find_relevant_collections: "check",
  preview_workspace_plan: "check",
};

const FAMILY_KIND: Record<ReadFamily, AgentActivityKind> = {
  read: "reading",
  search: "searching",
  related: "searching",
  analyze: "analyzing",
  duplicates: "checking",
  check: "checking",
};

type ReadGroup = {
  family: ReadFamily;
  operations: Set<string>;
  metadata: AgentActivityMetadata;
};

function familyOf(operation: string | undefined): ReadFamily {
  return READ_FAMILY[operation ?? ""] ?? "read";
}

function foldRead(group: ReadGroup, context: ControlContextInfo): void {
  group.operations.add(context.operation ?? "");
  const { metadata } = group;
  // Reads overlap — two pages, or a summary then a page — so the most any one
  // answer covered is what is claimed, never a sum that could overcount.
  if (context.tabs !== undefined) metadata.tabs = Math.max(metadata.tabs ?? 0, context.tabs);
  if (context.collections !== undefined) metadata.collections = Math.max(metadata.collections ?? 0, context.collections);
  // A later search or analysis supersedes an earlier one: it is the answer the agent went on with.
  if (context.matches !== undefined) metadata.matches = context.matches;
  if (context.groups !== undefined) metadata.groups = context.groups;
}

function readWords(group: ReadGroup, count: number, where: string): { title: string; description?: string } {
  const { metadata } = group;
  switch (group.family) {
    case "search": {
      const matches = metadata.matches ?? 0;
      return {
        title: matches > 0 ? `Found ${plural(matches, "relevant tab", "relevant tabs")}` : "No matching tabs found",
        description: count > 1 ? `${plural(count, "search", "searches")} in ${where}` : `Searched ${where}`,
      };
    }
    case "related": {
      const matches = metadata.matches ?? 0;
      return {
        title: matches > 0 ? `Found ${plural(matches, "related tab", "related tabs")}` : "No related tabs found",
        description: `In ${where}`,
      };
    }
    case "analyze": {
      const parts = [
        metadata.groups !== undefined ? plural(metadata.groups, "topic", "topics") : undefined,
        metadata.tabs !== undefined ? plural(metadata.tabs, "tab", "tabs") : undefined,
      ].filter(Boolean);
      return { title: "Analyzed the workspace", ...(parts.length > 0 ? { description: parts.join(" · ") } : {}) };
    }
    case "duplicates": {
      const groups = metadata.groups ?? 0;
      return {
        title: groups > 0 ? `Found ${plural(groups, "set of duplicate tabs", "sets of duplicate tabs")}` : "No duplicate tabs found",
        description: `Checked ${where}`,
      };
    }
    case "check": {
      const plan = group.operations.has("preview_workspace_plan");
      const collections = metadata.collections;
      return {
        title: plan && group.operations.size === 1 ? "Checked a plan" : "Checked existing collections",
        ...(collections !== undefined && !(plan && group.operations.size === 1)
          ? { description: plural(collections, "collection", "collections") }
          : {}),
      };
    }
    case "read": {
      const counts = activityCountsLine(metadata);
      return { title: "Read workspace", description: counts ? `${counts} · ${where}` : where };
    }
  }
}

const STAGE_ACTIVE_TITLE: Record<ContextToolStage, { title: string; kind: AgentActivityKind }> = {
  reading: { title: "Reading workspace…", kind: "reading" },
  analyzing: { title: "Analyzing the workspace…", kind: "analyzing" },
  checking: { title: "Checking the workspace…", kind: "checking" },
  proposing: { title: "Preparing a change…", kind: "working" },
};

/* ------------------------------------------------------------------ *
 * Workspace changes
 * ------------------------------------------------------------------ */

function changeWords(step: WorkspaceChangeStep): { title: string; description?: string } {
  switch (step.kind) {
    case "created":
      return { title: `Created collection ${quoted(step.name)}`, description: plural(step.tabCount, "tab", "tabs") };
    case "renamed":
      return { title: describeStep(step) };
    case "added":
      return { title: describeStep(step) };
  }
}

/* ------------------------------------------------------------------ *
 * The builder
 * ------------------------------------------------------------------ */

type OpenCall = {
  key: string;
  kind: "tool" | "command";
  name: string;
  description?: string;
  at: number;
  sequence: number;
  stage?: ContextToolStage;
  /** A file the call said it would create or edit, resolved when the call finishes. */
  file?: { kind: "created" | "updated"; relativePath: string; projectId: string };
  /** The approval this call stopped on, if it did. */
  approvalId?: string;
};

/** The identity of one event, the same way the journal decides it. */
function eventIdentity(event: SequencedControlEvent): string {
  return event.sourceId ? `src:${event.provider}:${event.sourceId}` : `evt:${event.id}`;
}

export function buildAgentActivityTimeline(input: AgentActivityInput): AgentActivityEntry[] {
  const { session, agentName, now } = input;
  const sessionId = session.sessionId;
  const workspaceId = session.workspaceId ?? session.context?.workspaceId;
  const where = input.workspaceName ?? "the workspace";
  const live = isLiveSession(session.status);
  const pending = new Map<string, RuntimeApprovalView>();
  for (const approval of input.approvals ?? []) {
    if (approval.sessionId === sessionId) pending.set(approval.approvalId, approval);
  }
  const approvalView = (id: string) => {
    const remembered = input.knownApprovals?.get(id);
    return pending.get(id) ?? (remembered?.sessionId === sessionId ? remembered : undefined);
  };

  const base = { sessionId, provider: session.provider, ...(workspaceId ? { workspaceId } : {}) };
  const entries: AgentActivityEntry[] = [];
  const byId = new Map<string, AgentActivityEntry>();

  function push(entry: Omit<AgentActivityEntry, "sessionId" | "provider" | "workspaceId" | "count"> & { count?: number }) {
    if (byId.has(entry.id)) return byId.get(entry.id)!;
    const full: AgentActivityEntry = { ...base, count: 1, ...entry };
    entries.push(full);
    byId.set(full.id, full);
    return full;
  }

  /* ---------------- The events, in the order the runtime received them. */

  const seen = new Set<string>();
  const events = input.events
    .filter((event) => event.sessionId === sessionId)
    .filter((event) => {
      const identity = eventIdentity(event);
      if (seen.has(identity)) return false;
      seen.add(identity);
      return true;
    })
    .sort((a, b) => a.sequence - b.sequence);

  const nameOf = input.agentNameOf ?? agentDisplayName;
  const handoffById = new Map((input.handoffs ?? []).map((handoff) => [handoff.handoffId, handoff]));

  let startEvent: SequencedControlEvent | undefined;
  const open = new Map<string, OpenCall>();
  let lastCallKey: string | undefined;
  let readGroup: { entry: AgentActivityEntry; group: ReadGroup } | undefined;
  const decided = new Set<string>();
  const rejected = new Set<string>();
  const fileEntries = new Map<string, AgentActivityEntry>();
  let lastEvent: SequencedControlEvent | undefined;
  /**
   * The call that just finished, for the files it reports straight after —
   * the order ACP agents use (the file is said once the edit is done, not
   * when it is called), so a file still joins the approval its call asked.
   */
  let justFinished: OpenCall | undefined;

  /** Anything but a read ends a run of reads, so grouping never reaches across other work. */
  const endReads = () => {
    readGroup = undefined;
  };

  const fileEntry = (
    kind: "created" | "updated",
    file: { relativePath: string; projectId: string },
    runId: string | undefined,
    status: "completed" | "failed",
    at: number,
    sequence: number,
    approvalId?: string
  ) => {
    const name = relativePathBasename(file.relativePath);
    const key = `${kind}:${file.projectId}:${file.relativePath}:${runId ?? ""}`;
    const existing = fileEntries.get(key);
    // The same file, the same outcome, in the same run: one fact, however many layers said it.
    if (existing && existing.status === status) {
      existing.completedAt = at;
      return;
    }
    const verb = kind === "created" ? "create" : "edit";
    const entry = push({
      id: `file:${key}:${sequence}`,
      kind: status === "failed" ? "action_failed" : kind,
      status,
      title: status === "failed" ? `Couldn't ${verb} ${name}` : `${kind === "created" ? "Created" : "Edited"} ${name}`,
      ...(file.relativePath !== name ? { description: file.relativePath } : {}),
      at,
      refs: {
        sequence,
        ...(approvalId ? { approvalId } : {}),
        file: { relativePath: file.relativePath, projectId: file.projectId, operation: kind },
      },
    });
    fileEntries.set(key, entry);
  };

  for (const event of events) {
    // A gap in the sequence is events this list does not hold — agent
    // history keeps no `thinking` or `message_delta` (./history.ts). Whatever
    // they were, they were not files, so they end "just finished" exactly as
    // they would have here had they been present.
    if (event.kind !== "file_created" && event.kind !== "file_modified") justFinished = undefined;
    else if (lastEvent && event.sequence !== lastEvent.sequence + 1) justFinished = undefined;
    lastEvent = event;
    switch (event.kind) {
      case "session_started":
      case "session_resumed":
        startEvent ??= event;
        break;

      case "context_loaded": {
        const context = event.context;
        if (!context || (workspaceId && context.workspaceId !== workspaceId)) break;
        endReads();
        const metadata: AgentActivityMetadata = {
          ...(context.tabs !== undefined ? { tabs: context.tabs } : {}),
          ...(context.collections !== undefined ? { collections: context.collections } : {}),
        };
        push({
          id: `context-loaded:${sessionId}`,
          kind: "context_loaded",
          status: "info",
          title: "Workspace context loaded",
          ...(activityCountsLine(metadata) ? { description: activityCountsLine(metadata)! } : {}),
          at: event.timestamp,
          metadata,
          refs: { sequence: event.sequence },
        });
        break;
      }

      case "context_read": {
        const context = event.context;
        if (!context || (workspaceId && context.workspaceId !== workspaceId)) break;
        // The agent's own "tool started" for this call is answered now.
        for (const [key, call] of open) {
          if (call.stage) {
            open.delete(key);
            break;
          }
        }
        if (context.ok === false) {
          endReads();
          push({
            id: `context-failed:${event.id}`,
            kind: "context_failed",
            status: "failed",
            title: "Couldn't read the workspace",
            description: "Hubble did not answer that request",
            at: event.timestamp,
            refs: { sequence: event.sequence },
          });
          break;
        }
        const family = familyOf(context.operation);
        if (readGroup && readGroup.group.family === family && entries[entries.length - 1] === readGroup.entry) {
          foldRead(readGroup.group, context);
          readGroup.entry.count += 1;
          readGroup.entry.completedAt = event.timestamp;
        } else {
          const group: ReadGroup = { family, operations: new Set(), metadata: {} };
          foldRead(group, context);
          const entry = push({
            id: `read:${event.id}`,
            kind: FAMILY_KIND[family],
            status: "completed",
            title: "",
            at: event.timestamp,
            refs: { sequence: event.sequence },
          });
          readGroup = { entry, group };
        }
        const words = readWords(readGroup.group, readGroup.entry.count, where);
        readGroup.entry.title = words.title;
        if (words.description) readGroup.entry.description = words.description;
        readGroup.entry.metadata = { ...readGroup.group.metadata };
        break;
      }

      case "tool_started":
      case "command_started": {
        const key = event.tool?.callId ?? `seq:${event.sequence}`;
        const stage = event.tool ? toolStage(event.tool.name) : undefined;
        open.set(key, {
          key,
          kind: event.kind === "command_started" ? "command" : "tool",
          name: event.tool?.name ?? "",
          ...(event.tool?.description ? { description: event.tool.description } : {}),
          at: event.timestamp,
          sequence: event.sequence,
          ...(stage ? { stage } : {}),
        });
        lastCallKey = key;
        continue; // Keeps `lastCallKey` for a file event that follows at once.
      }

      case "file_read": {
        endReads();
        const last = entries[entries.length - 1];
        const name = event.file ? relativePathBasename(event.file.relativePath) : undefined;
        if (last && last.kind === "files_read") {
          last.count += 1;
          last.metadata = { files: last.count };
          last.title = `Read ${plural(last.count, "file", "files")}`;
          last.completedAt = event.timestamp;
          break;
        }
        push({
          id: `files-read:${event.id}`,
          kind: "files_read",
          status: "completed",
          title: name ? `Read ${name}` : "Read a file",
          at: event.timestamp,
          metadata: { files: 1 },
          refs: { sequence: event.sequence },
        });
        break;
      }

      case "file_created":
      case "file_modified": {
        if (!event.file) break;
        endReads();
        const kind = event.kind === "file_created" ? "created" : "updated";
        const call = lastCallKey ? open.get(lastCallKey) : undefined;
        // Said at the moment the tool was called, so it is an intent: it
        // becomes a fact — or a failure — when the call finishes.
        if (call && lastEvent && call.sequence === event.sequence - 1) {
          call.file = { kind, relativePath: event.file.relativePath, projectId: event.file.projectId };
          break;
        }
        fileEntry(kind, event.file, event.runId, "completed", event.timestamp, event.sequence, justFinished?.approvalId);
        break;
      }

      case "tool_finished":
      case "command_finished": {
        const callId = event.tool?.callId;
        let call = callId ? open.get(callId) : undefined;
        if (!call && !callId) {
          // No id to pair by: the most recent call of the same kind.
          const wanted = event.kind === "command_finished" ? "command" : "tool";
          call = [...open.values()].reverse().find((candidate) => candidate.kind === wanted);
        }
        if (call) open.delete(call.key);
        const ok = event.tool?.ok !== false;
        if (call && ok) justFinished = call;

        // A call the person declined did not fail: "Action rejected" already says what happened.
        if (!ok && call?.approvalId && rejected.has(call.approvalId)) break;

        if (call?.file) {
          fileEntry(call.file.kind, call.file, event.runId, ok ? "completed" : "failed", event.timestamp, event.sequence, call.approvalId);
          break;
        }
        if (call?.stage) break; // A Hubble read: the server's own event says what it found.
        if (event.kind === "command_finished" || call?.kind === "command") {
          endReads();
          const last = entries[entries.length - 1];
          if (ok && last && last.kind === "command" && last.status === "completed") {
            last.count += 1;
            last.title = `Ran ${plural(last.count, "command", "commands")}`;
            delete last.description;
            last.completedAt = event.timestamp;
            break;
          }
          const description = event.tool?.description ?? call?.description;
          push({
            id: `command:${event.id}`,
            kind: ok ? "command" : "action_failed",
            status: ok ? "completed" : "failed",
            title: ok ? "Ran a command" : "A command failed",
            ...(description ? { description } : {}),
            at: call?.at ?? event.timestamp,
            completedAt: event.timestamp,
            refs: { sequence: event.sequence, ...(call?.approvalId ? { approvalId: call.approvalId } : {}) },
          });
          break;
        }
        if (!ok) {
          endReads();
          const description = event.tool?.description ?? call?.description;
          push({
            id: `step-failed:${event.id}`,
            kind: "action_failed",
            status: "failed",
            title: "A step didn't work",
            ...(description ? { description } : {}),
            at: event.timestamp,
            refs: { sequence: event.sequence, ...(call?.approvalId ? { approvalId: call.approvalId } : {}) },
          });
        }
        break;
      }

      case "message_sent":
        // The message that delivered a handoff: "Handoff received" says it.
        if (event.handoff) break;
        endReads();
        push({
          id: `sent:${event.id}`,
          kind: "message_sent",
          status: "info",
          title: "You sent a message",
          at: event.timestamp,
          refs: { sequence: event.sequence },
        });
        break;

      case "message_received": {
        endReads();
        const last = entries[entries.length - 1];
        if (last && last.kind === "replied") {
          last.count += 1;
          last.completedAt = event.timestamp;
          break;
        }
        push({
          id: `replied:${event.messageId ?? event.id}`,
          kind: "replied",
          status: "completed",
          title: "Replied",
          at: event.timestamp,
          refs: { sequence: event.sequence },
        });
        break;
      }

      case "approval_requested": {
        const approvalId = event.approvalId;
        if (!approvalId) break;
        endReads();
        const view = approvalView(approvalId);
        // The call this approval stops: the one it names, or the latest still open.
        const asking =
          (event.tool?.callId ? open.get(event.tool.callId) : undefined) ??
          [...open.values()].sort((a, b) => b.sequence - a.sequence)[0];
        if (asking) asking.approvalId = approvalId;
        const description = view
          ? describeApproval(view)
          : asking?.file
            ? `${asking.file.kind === "created" ? "Create" : "Edit"} ${relativePathBasename(asking.file.relativePath)}`
            : safeSummary(event.summary);
        push({
          id: `approval:${approvalId}`,
          kind: "approval_required",
          status: "waiting",
          title: APPROVAL_STATE_LABEL.waiting,
          ...(description ? { description } : {}),
          at: event.timestamp,
          refs: { approvalId, sequence: event.sequence },
        });
        break;
      }

      case "approval_granted":
      case "approval_denied": {
        const approvalId = event.approvalId;
        if (!approvalId || decided.has(approvalId)) break;
        decided.add(approvalId);
        if (event.kind === "approval_denied") rejected.add(approvalId);
        endReads();
        const request = byId.get(`approval:${approvalId}`);
        const granted = event.kind === "approval_granted";
        push({
          id: `decision:${approvalId}`,
          kind: granted ? "action_approved" : "action_rejected",
          status: granted ? "completed" : "info",
          title: granted ? APPROVAL_STATE_LABEL.approved : APPROVAL_STATE_LABEL.rejected,
          ...(request?.description ? { description: request.description } : {}),
          at: event.timestamp,
          refs: { approvalId, sequence: event.sequence },
        });
        break;
      }

      case "waiting_for_input":
        endReads();
        push({
          id: `input:${event.id}`,
          kind: "waiting_for_input",
          status: "info",
          title: `${agentName} asked you a question`,
          at: event.timestamp,
          refs: { sequence: event.sequence },
        });
        break;

      case "error": {
        endReads();
        const description = safeSummary(event.summary);
        push({
          id: `error:${event.id}`,
          kind: "error",
          status: "failed",
          title: agentStoppedUnexpectedly(agentName),
          ...(description ? { description } : {}),
          at: event.timestamp,
          refs: { sequence: event.sequence },
        });
        break;
      }

      case "run_completed":
        endReads();
        push({
          id: `done:${event.id}`,
          kind: "completed",
          status: "completed",
          title: "Finished",
          at: event.timestamp,
          refs: { sequence: event.sequence },
        });
        break;

      case "run_cancelled":
        endReads();
        push({
          id: `cancelled:${event.id}`,
          kind: "cancelled",
          status: "info",
          title: "Cancelled",
          description: "The run was stopped before it finished",
          at: event.timestamp,
          refs: { sequence: event.sequence },
        });
        break;

      case "handoff_sent": {
        const info = event.handoff;
        if (!info || (workspaceId && info.workspaceId !== workspaceId)) break;
        endReads();
        const peer = nameOf(info.peerProvider);
        const record = handoffById.get(info.handoffId);
        const failed = info.outcome === "failed";
        push({
          id: `handoff:${info.handoffId}`,
          kind: failed ? "handoff_failed" : "handoff_sent",
          status: failed ? "failed" : "completed",
          title: failed ? `Couldn't hand off to ${peer}` : `Handed off to ${peer}`,
          description: failed
            ? info.failure === "context_not_delivered"
              ? `${peer} didn't receive the handoff`
              : `${peer}'s session couldn't be started. Nothing was changed`
            : record
              ? handoffPassedLine(record)
              : `Continued in a new ${peer} session`,
          at: event.timestamp,
          refs: { handoffId: info.handoffId, sequence: event.sequence },
          ...(info.peerSessionId ? { action: { kind: "open_session" as const, sessionId: info.peerSessionId, provider: info.peerProvider } } : {}),
        });
        break;
      }

      case "handoff_received": {
        const info = event.handoff;
        if (!info || (workspaceId && info.workspaceId !== workspaceId)) break;
        endReads();
        push({
          id: `handoff-received:${info.handoffId}`,
          kind: "handoff_received",
          status: "info",
          title: "Handoff received",
          description: `From ${nameOf(info.peerProvider)}`,
          at: event.timestamp,
          refs: { handoffId: info.handoffId, sequence: event.sequence },
          ...(info.peerSessionId ? { action: { kind: "open_session" as const, sessionId: info.peerSessionId, provider: info.peerProvider } } : {}),
        });
        break;
      }

      case "thinking":
      case "message_delta":
        break;
    }
    lastCallKey = undefined;
  }

  // A call the person declined, whose failure arrived before the decision did.
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index]!;
    if (entry.kind === "action_failed" && entry.refs?.approvalId && rejected.has(entry.refs.approvalId)) {
      entries.splice(index, 1);
      byId.delete(entry.id);
    }
  }

  /* ---------------- Approvals: what became of each. */

  const outcomes = input.planOutcomes ?? session.context?.planOutcomes ?? [];
  const outcomeByApproval = new Map<string, RuntimePlanOutcomeView>();
  for (const outcome of outcomes) if (outcome.approvalId) outcomeByApproval.set(outcome.approvalId, outcome);

  for (const entry of entries) {
    if (entry.kind !== "approval_required" || !entry.refs?.approvalId) continue;
    const approvalId = entry.refs.approvalId;
    const view = pending.get(approvalId);
    if (view && !decided.has(approvalId) && view.expiresAt > now && !isTerminalSession(session.status)) continue;

    // No longer waiting on anybody.
    entry.status = "info";
    if (decided.has(approvalId)) {
      entry.kind = "action_requested";
      entry.title = APPROVAL_REQUESTED_TITLE;
      continue;
    }
    const outcome = outcomeByApproval.get(approvalId);
    const known = view ?? approvalView(approvalId);
    entry.kind = "approval_closed";
    entry.title =
      outcome?.status === "expired" || (known && known.expiresAt <= now)
        ? APPROVAL_CLOSED_TITLE.expired
        : APPROVAL_CLOSED_TITLE.withdrawn;
  }

  /* ---------------- What the Command Centre applied, placed by when. */

  const placed: AgentActivityEntry[] = [];
  const changes = (input.changes ?? []).filter(
    (change) => change.sessionId === sessionId && (!workspaceId || change.workspaceId === workspaceId)
  );
  const changeByPlan = new Map<string, AgentActivityEntry>();
  const seenChanges = new Set<string>();
  for (const change of changes) {
    if (seenChanges.has(change.id)) continue;
    seenChanges.add(change.id);
    // The approval that allowed it: named with the change, or — for a plan —
    // by the outcome the runtime matched to its approval.
    const approvalId =
      change.approvalId ?? (change.planId ? outcomes.find((outcome) => outcome.planId === change.planId)?.approvalId : undefined);
    const changeRefs: ActivityRefs = {
      changeId: change.id,
      ...(change.planId ? { planId: change.planId } : {}),
      ...(approvalId ? { approvalId } : {}),
    };
    let entry: AgentActivityEntry;
    let undo: AgentActivityEntry | undefined;
    if (!change.ok) {
      entry = {
        ...base,
        id: `change:${change.id}`,
        kind: "action_failed",
        status: "failed",
        title: "Couldn't apply the approved change",
        description: "Nothing was changed",
        at: change.at,
        count: 1,
        refs: changeRefs,
      };
    } else {
      const [first] = change.steps;
      const words =
        change.steps.length === 1 && first
          ? changeWords(first)
          : {
              title: `Updated ${where}`,
              description:
                change.steps.slice(0, 2).map(describeStep).join(" · ") +
                (change.steps.length > 2 ? ` · ${plural(change.steps.length - 2, "more change", "more changes")}` : ""),
            };
      entry = {
        ...base,
        id: `change:${change.id}`,
        kind: first?.kind === "created" && change.steps.length === 1 ? "created" : "workspace_updated",
        // What the agent did stays what it did. An undo is its own entry,
        // below — the history is never rewritten as if this never happened.
        status: "completed",
        title: words.title,
        ...(words.description ? { description: words.description } : {}),
        at: change.at,
        count: change.steps.length || 1,
        // Nothing left to view once it is undone.
        ...(change.undone ? {} : { action: { kind: "view_change" as const, changeId: change.id } }),
        refs: changeRefs,
      };
      if (change.undone) {
        undo = {
          ...base,
          id: `undo:${change.id}`,
          kind: "undone",
          status: "completed",
          title: describeUndo(change),
          description: "Undone by you",
          // Never before the change it undoes, whatever the clock said.
          at: Math.max(change.undoneAt ?? change.at, change.at),
          count: 1,
          refs: changeRefs,
        };
      }
    }
    placed.push(entry);
    if (undo) placed.push(undo);
    if (change.planId) changeByPlan.set(change.planId, entry);
  }

  for (const outcome of outcomes) {
    const change = changeByPlan.get(outcome.planId);
    if (change) {
      // The change is the fact; the outcome only adds what could not be confirmed.
      if (outcome.status === "unverified") {
        change.description = `Only ${outcome.verifiedCount} of ${plural(outcome.operationCount, "change", "changes")} could be confirmed — check the workspace`;
      }
      continue;
    }
    if (outcome.status === "denied" || outcome.status === "expired" || outcome.status === "cancelled") continue;
    const failed = outcome.status !== "applied";
    placed.push({
      ...base,
      id: `plan:${outcome.planId}`,
      kind: failed ? "action_failed" : "workspace_updated",
      status: failed ? "failed" : "completed",
      title:
        outcome.status === "applied"
          ? `Applied ${plural(outcome.operationCount, "change", "changes")}`
          : outcome.status === "unverified"
            ? "Changes couldn't all be confirmed"
            : "Approved changes weren't applied",
      description:
        outcome.status === "unverified"
          ? `Only ${outcome.verifiedCount} of ${plural(outcome.operationCount, "change", "changes")} could be confirmed`
          : outcome.status === "applied"
            ? where
            : outcome.status === "stale"
              ? "The workspace changed while you were deciding. Nothing was changed"
              : "Nothing was changed",
      at: outcome.at,
      count: 1,
      refs: { planId: outcome.planId, ...(outcome.approvalId ? { approvalId: outcome.approvalId } : {}) },
    });
  }

  // Each change goes after everything that happened before it, in the order applied.
  placed.sort((a, b) => a.at - b.at);
  const timeline: AgentActivityEntry[] = [];
  let next = 0;
  for (const entry of entries) {
    while (next < placed.length && placed[next]!.at < entry.at) timeline.push(placed[next++]!);
    timeline.push(entry);
  }
  while (next < placed.length) timeline.push(placed[next++]!);

  /* ---------------- The session's own beginning and end. */

  const agentStarted = startEvent !== undefined;
  const connection: AgentActivityEntry = {
    ...base,
    id: `connect:${sessionId}`,
    kind: "connected",
    status: "info",
    title: `${agentName} connected`,
    ...(input.workspaceName ? { description: `Working in ${input.workspaceName}` } : {}),
    at: session.createdAt,
    count: 1,
  };
  if (agentStarted) {
    connection.completedAt = startEvent!.timestamp;
  } else if (session.status === "connecting") {
    connection.kind = "connecting";
    connection.status = "active";
    connection.title = `Connecting to ${agentName}…`;
  } else if ((session.status === "failed" || session.status === "disconnected") && events.length === 0) {
    connection.kind = "connection_failed";
    connection.status = "failed";
    connection.title = `Couldn't connect to ${agentName}`;
    connection.description = "The connection didn't complete";
    connection.action = { kind: "new_session" };
  } else {
    connection.title = `${agentName} session started`;
  }
  timeline.unshift(connection);

  if (session.contextUnavailable === "provider") {
    timeline.splice(1, 0, {
      ...base,
      id: `context-unavailable:${sessionId}`,
      kind: "context_unavailable",
      status: "info",
      title: "Started without workspace context",
      description: `${agentName} can't be given Hubble's workspace tools`,
      at: session.createdAt,
      count: 1,
    });
  }

  /* ---------------- What is happening right now, only while it is. */

  const awaiting = timeline.some((entry) => entry.status === "waiting");
  const last = timeline[timeline.length - 1];
  if (live && session.status === "running" && !awaiting) {
    const calls = [...open.values()].sort((a, b) => a.sequence - b.sequence);
    const call = calls[calls.length - 1];
    let current: { kind: AgentActivityKind; title: string; description?: string } | undefined;
    if (call?.file) {
      const name = relativePathBasename(call.file.relativePath);
      current = { kind: call.file.kind, title: `${call.file.kind === "created" ? "Creating" : "Editing"} ${name}…` };
    } else if (call?.stage) {
      current = STAGE_ACTIVE_TITLE[call.stage];
    } else if (call?.kind === "command") {
      current = { kind: "command", title: "Running a command…", ...(call.description ? { description: call.description } : {}) };
    } else if (call) {
      current = { kind: "working", title: "Working…", ...(call.description ? { description: call.description } : {}) };
    } else if (lastEvent?.kind === "thinking") {
      current = { kind: "thinking", title: "Thinking…" };
    } else if (lastEvent?.kind === "message_delta") {
      current = { kind: "replying", title: "Writing a reply…" };
    } else {
      current = { kind: "working", title: "Working…" };
    }
    timeline.push({
      ...base,
      id: `now:${sessionId}`,
      kind: current.kind,
      status: "active",
      title: current.title,
      ...(current.description ? { description: current.description } : {}),
      at: Math.max(session.updatedAt, lastEvent?.timestamp ?? 0, last?.at ?? 0),
      count: 1,
    });
  }

  if (session.status === "waiting_for_input") {
    const question = [...timeline].reverse().find((entry) => entry.kind === "waiting_for_input");
    if (question) {
      question.status = "waiting";
      question.title = `${agentName} is waiting for your reply`;
    }
  }

  // A session that ended says how, once — unless its last entry already did.
  const ending = (() => {
    switch (session.status) {
      case "disconnected":
        return { kind: "disconnected" as const, status: "failed" as const, title: `${agentName} disconnected`, action: true };
      case "failed":
        return { kind: "error" as const, status: "failed" as const, title: agentStoppedUnexpectedly(agentName), action: true };
      case "cancelled":
        return { kind: "ended" as const, status: "info" as const, title: "Session cancelled", action: false };
      case "completed":
        return { kind: "completed" as const, status: "completed" as const, title: "Session completed", action: false };
      default:
        return undefined;
    }
  })();
  if (ending && connection.kind !== "connection_failed") {
    const final = timeline[timeline.length - 1];
    const alreadySaid =
      final !== undefined &&
      final.id !== connection.id &&
      ((ending.status === "failed" && final.status === "failed" && final.kind === "error") ||
        (ending.kind === "ended" && final.kind === "cancelled") ||
        (ending.kind === "completed" && final.kind === "completed"));
    if (alreadySaid) {
      if (ending.action) final.action = { kind: "new_session" };
    } else {
      timeline.push({
        ...base,
        id: `end:${sessionId}`,
        kind: ending.kind,
        status: ending.status,
        title: ending.title,
        at: Math.max(session.updatedAt, final?.completedAt ?? final?.at ?? 0),
        count: 1,
        ...(ending.action ? { action: { kind: "new_session" as const } } : {}),
      });
    }
  }

  return timeline;
}

/** The moment an entry is "from": when it finished, if it has. */
export function activityTime(entry: AgentActivityEntry): number {
  return entry.completedAt ?? entry.at;
}
