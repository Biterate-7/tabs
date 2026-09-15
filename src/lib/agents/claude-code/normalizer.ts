import { toProjectRelative } from "@/lib/agents/paths";
import { CLAUDE_CODE_PROVIDER, CLAUDE_LIMITS, mapClaudeTaskStatus } from "./types";
import type {
  ClaudeDiscoveredSession,
  ClaudeParsedRecord,
  ClaudeToolUse,
} from "./types";
import type {
  AgentAdapterObservation,
  AgentArtifactObservation,
  ObservedWorkItem,
} from "@/lib/agents/adapter";
import type { AgentRunArtifactRole } from "@/lib/agents/types";

/**
 * Turns parsed Claude Code records into Phase 11 observations.
 *
 * Pure: no filesystem, no storage, no React. This is where provider detail
 * stops — everything downstream of here speaks only the generic
 * `AgentAdapterObservation` vocabulary, and nothing Claude-specific travels
 * any further.
 *
 * Observations are produced WITHOUT a `workspaceId`. Attaching one is the
 * client's job, because the project→workspace mapping is account-scoped
 * state the server has no business holding. An observation that never gets a
 * workspace is not lost: Phase 11's `ingestObservation` reports it as
 * `unattached` and creates nothing, which is the behaviour this phase wants.
 */

/** Tools whose work is a modification. */
const WRITING_TOOLS = new Set(["Edit", "Write", "NotebookEdit", "MultiEdit"]);

/** Tools whose work is a look. */
const READING_TOOLS = new Set(["Read", "Grep", "Glob", "NotebookRead"]);

/**
 * How a tool's file interaction is recorded.
 *
 * `Write` maps to `edited`, not `created`, and that is a deliberate
 * under-claim. Claude Code's `Write` input is `{file_path, content}` — it
 * says nothing about whether the file existed beforehand, and the only way to
 * find out would be to stat the file, which this phase does not do (it is
 * observational, and touching the project's filesystem is out of scope).
 *
 * Between two wrong answers, `edited` is the one that claims less: saying a
 * run "created" a file it actually overwrote is a false statement about
 * history, whereas "edited" is true of both cases. So `created` and `deleted`
 * exist in the vocabulary for providers that can distinguish them, and Claude
 * Code currently emits neither.
 */
function roleForTool(name: string): AgentRunArtifactRole | undefined {
  if (WRITING_TOOLS.has(name)) return "edited";
  if (READING_TOOLS.has(name)) return "inspected";
  // Unknown tools contribute no artifact. A tool whose input shape is not
  // understood cannot be said to have touched anything in particular.
  return undefined;
}

/**
 * A one-line, human-readable summary of a tool invocation.
 *
 * Every branch below produces text derived from a *structured* field — a
 * basename, a provider-written description, a tool name. None of them
 * interpolates a command, a pattern, file contents, a tool result, or
 * anything a model wrote as prose.
 *
 * The default is the important one: an unrecognised tool degrades to "Used
 * tool" rather than falling through to something that might expose its input.
 * The live survey found `mcp__Claude_Browser__*`, `mcp__computer-use__*` and
 * `mcp__ccd_session__*` invocations alongside the built-ins, so unknown tools
 * are the common case, not a theoretical one.
 */
export function summarizeTool(tool: ClaudeToolUse): string {
  if (WRITING_TOOLS.has(tool.name)) {
    return tool.fileName ? `Edited ${tool.fileName}` : "Edited a file";
  }

  if (READING_TOOLS.has(tool.name)) {
    return tool.fileName ? `Inspected ${tool.fileName}` : "Inspected files";
  }

  // Shell tools: the description Claude Code already wrote for a human. Never
  // the command. With no description there is nothing safe to say beyond the
  // fact that something ran.
  if (tool.description) return tool.description;
  if (tool.name === "Bash" || tool.name === "PowerShell") return "Ran a command";

  if (tool.url) return "Opened a page";

  return "Used tool";
}

export type NormalizeInput = {
  session: ClaudeDiscoveredSession;
  records: ClaudeParsedRecord[];
  /** Clock for records that carry no usable timestamp of their own. */
  now: number;
  /**
   * How many tasks this session had already created before these records.
   *
   * Carried across polls in the server-owned cursor. See `taskExternalId`
   * for why an ordinal is the identity, and `countCreatedTasks` for how the
   * caller advances it.
   */
  taskOrdinalBase?: number;
};

/**
 * Patterns that mean "this text names a place on someone's disk".
 *
 * Task subjects and descriptions are prose a model wrote, so unlike a
 * `file_path` they cannot simply be resolved against a project root — they
 * may contain no path, or a path in the middle of a sentence. What they must
 * never do is carry the machine's own directory layout into stored,
 * searchable, displayed state.
 *
 * The patterns are deliberately narrow: a drive letter, a UNC share, or one
 * of the well-known user/system roots. A bare `/api/users` is left alone,
 * because it is overwhelmingly an API route rather than a filesystem path,
 * and redacting it would mangle ordinary task text to guard against nothing.
 */
const ABSOLUTE_PATH_PATTERNS: readonly RegExp[] = [
  // C:\Users\someone\project or C:/Users/someone/project
  /\b[A-Za-z]:[\\/][^\s"']*/g,
  // \\server\share
  /\\\\[^\s"']+/g,
  // /home/x, /Users/x, /root/..., /var/..., /tmp/...
  /(?:^|\s)(\/(?:home|Users|root|var|tmp|opt|etc)\/[^\s"']*)/g,
];

/**
 * Removes anything that looks like an absolute local path from task text.
 *
 * Replaced with a marker rather than deleted, so a reader can see that
 * something was removed instead of reading a sentence with a hole in it.
 * Applied to every piece of task prose before it leaves this module — which
 * is the same boundary `artifactsForTool` enforces for structured paths, just
 * expressed differently because the input is prose rather than a path field.
 */
export function redactAbsolutePaths(value: string): string {
  let out = value;
  for (const pattern of ABSOLUTE_PATH_PATTERNS) {
    out = out.replace(pattern, (match, captured?: string) => {
      // The POSIX pattern captures the path without its leading separator so
      // the preceding space survives; the others match the whole thing.
      if (typeof captured === "string") return match.replace(captured, "[path]");
      return "[path]";
    });
  }
  return out;
}

/**
 * The stable identity of one task within one session.
 *
 * Claude Code's `TaskUpdate` refers to tasks by a small integer that it never
 * writes into `TaskCreate`'s input — the id is assigned by the tool and comes
 * back in its *result*, which this feature does not read. So the id is
 * re-derived from creation order instead: the Nth `TaskCreate` in a session
 * is task N, 1-based.
 *
 * That correspondence is not assumed, it was verified against real
 * transcripts: a session with 11 `TaskCreate` calls produced exactly
 * `taskId` 1 through 11, each moving `in_progress` then `completed` in
 * creation order. See docs/phase-15-agent-work-tracking.md for the trace.
 *
 * It is also fail-safe rather than fail-wrong. When a session is first seen
 * mid-transcript, the early creations are simply not in the window, the
 * ordinal starts behind, and updates for tasks that were never observed match
 * nothing — so the domain records nothing for them, rather than attaching a
 * status to the wrong title.
 */
function taskExternalId(ordinal: number): string {
  return String(ordinal);
}

/** How many tasks a batch of records created, so a caller can advance its ordinal. */
export function countCreatedTasks(records: ClaudeParsedRecord[]): number {
  let count = 0;
  for (const record of records) {
    for (const task of record.tasks) {
      if (task.kind === "create") count += 1;
    }
  }
  return count;
}

/**
 * Turns a poll's task events into work-item observations.
 *
 * One entry per task touched in this batch, carrying the *final* state the
 * batch left it in — a task created and completed within one poll yields a
 * single observation, not three. Entries are keyed by the task's ordinal
 * identity, so re-reading the same records produces the same observations and
 * ingestion is idempotent.
 *
 * An update for a task with no creation in scope still produces an entry, but
 * a titleless one. Phase 11's ingestion treats that as "update only, never
 * create", so it lands on an item an earlier poll named and is dropped
 * entirely if no such item exists.
 */
function workItemsForRecords(
  records: ClaudeParsedRecord[],
  ordinalBase: number
): ObservedWorkItem[] {
  const byExternalId = new Map<string, ObservedWorkItem>();
  let ordinal = ordinalBase;

  for (const record of records) {
    for (const task of record.tasks) {
      if (task.kind === "create") {
        ordinal += 1;
        const externalId = taskExternalId(ordinal);

        const item: ObservedWorkItem = {
          externalId,
          title: redactAbsolutePaths(task.subject),
          // A newly created task has not been started — Claude Code emits a
          // separate `in_progress` update when work on it actually begins.
          status: "pending",
        };
        if (task.description) item.summary = redactAbsolutePaths(task.description);

        byExternalId.set(externalId, item);
        continue;
      }

      const status = mapClaudeTaskStatus(task.status);
      if (!status) continue;

      const existing = byExternalId.get(task.taskId);
      if (existing) {
        // Created earlier in this same batch: fold the status into the entry
        // that already carries the title.
        existing.status = status;
        continue;
      }

      // Created in an earlier poll. Title-less on purpose — see the note on
      // ObservedWorkItem.title.
      byExternalId.set(task.taskId, { externalId: task.taskId, status });
    }
  }

  return [...byExternalId.values()];
}

/**
 * Produces the observations for one session in one poll.
 *
 * The first observation always carries the session's identity and status, so
 * a poll that found no new transcript activity still keeps the run's status
 * and metadata current. Each new tool invocation then contributes one further
 * observation carrying its own summary and `sourceId`.
 */
export function normalizeSession(input: NormalizeInput): AgentAdapterObservation[] {
  const { session, records, now, taskOrdinalBase = 0 } = input;

  const base: AgentAdapterObservation = {
    provider: CLAUDE_CODE_PROVIDER,
    externalId: session.externalId,
    observedAt: session.lastObservedAt || now,
  };

  // Sticky by omission: a field is only ever *set* here, never set to empty.
  // Phase 11's updateRun treats an absent field as "no news" and keeps what it
  // already knows, so a poll that learns less than an earlier one cannot erase
  // a title or a branch.
  if (session.title) base.title = session.title;
  if (session.gitBranch) base.gitBranch = session.gitBranch;
  base.projectKey = session.projectPath;

  // An explicit lifecycle artifact outranks the live status: a released
  // session is over regardless of what the registry last said about it.
  if (session.terminal === "deleted") {
    base.status = "cancelled";
  } else if (session.status) {
    base.status = session.status;
  }
  // No `else`. An unrecognised provider status means *no status change*, not
  // a guess — mapping the unknown onto "failed" would manufacture failures
  // that never happened.

  // Work items ride on the base observation because they are session-level
  // facts rather than per-tool ones: a task's life spans many tool calls, and
  // attaching it to whichever call happened to be nearby would make its
  // arrival depend on unrelated activity.
  const workItems = workItemsForRecords(records, taskOrdinalBase);
  if (workItems.length > 0) base.workItems = workItems;

  const observations: AgentAdapterObservation[] = [base];

  let branch = session.gitBranch;
  let budget = CLAUDE_LIMITS.maxObservationsPerSession;

  for (const record of records) {
    // The branch a record was written on is fresher than the session-level
    // value, so later records refine it for subsequent observations.
    if (record.gitBranch) branch = record.gitBranch;

    for (const tool of record.tools) {
      if (budget <= 0) return observations;
      budget -= 1;

      const observation: AgentAdapterObservation = {
        provider: CLAUDE_CODE_PROVIDER,
        externalId: session.externalId,
        activity: summarizeTool(tool),
        // Claude's own `toolu_…` id. Stable across re-reads of the same
        // record, which is what makes repeated polling idempotent without
        // hashing display text.
        sourceId: tool.id,
        observedAt: record.timestamp ?? now,
        projectKey: session.projectPath,
      };
      if (branch) observation.gitBranch = branch;
      if (tool.url) observation.url = tool.url;

      const artifacts = artifactsForTool(tool, session.projectPath);
      if (artifacts.length > 0) observation.artifacts = artifacts;

      observations.push(observation);
    }
  }

  return observations;
}

/**
 * The project files a tool invocation worked on, if any.
 *
 * This is where an absolute path stops. The paths Claude Code records are
 * usually absolute (`C:\Users\someone\project\src\a.ts`); they are converted
 * here against the session's own project root and only the relative remainder
 * travels onward. A path that cannot be expressed inside the project — an
 * agent reading its own config, a temp file, something under a different root
 * — yields no artifact at all rather than an artifact with an absolute path.
 *
 * `toProjectRelative` also refuses traversal, so `../../secret.txt` is
 * dropped here rather than becoming a file the project is said to contain.
 */
function artifactsForTool(
  tool: ClaudeToolUse,
  projectPath: string
): AgentArtifactObservation[] {
  const role = roleForTool(tool.name);
  if (!role || !tool.filePaths?.length) return [];

  const artifacts: AgentArtifactObservation[] = [];
  const seen = new Set<string>();

  for (const raw of tool.filePaths) {
    const relative = toProjectRelative(projectPath, raw);
    if (!relative.ok) continue;
    if (seen.has(relative.relativePath)) continue;
    seen.add(relative.relativePath);

    artifacts.push({
      projectPath,
      relativePath: relative.relativePath,
      role,
      sourceId: tool.id,
    });
  }

  return artifacts;
}

/**
 * The fields an observation is permitted to carry out of this directory.
 *
 * Exported so the security suite can assert against it rather than against a
 * hand-maintained copy of the list.
 */
export const OBSERVATION_ALLOWLIST = [
  "provider",
  "externalId",
  "workspaceId",
  "status",
  "title",
  "activity",
  "projectKey",
  "gitBranch",
  "sourceId",
  "url",
  "observedAt",
  "artifacts",
  "workItems",
] as const;

/** The fields one artifact observation may carry. Asserted against in the security suite. */
export const ARTIFACT_OBSERVATION_ALLOWLIST = [
  "projectPath",
  "relativePath",
  "role",
  "sourceId",
] as const;
