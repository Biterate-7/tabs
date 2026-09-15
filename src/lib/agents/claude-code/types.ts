/**
 * Claude Code specific shapes, kept entirely on this side of the boundary.
 *
 * Nothing here is imported by `src/lib/agents/*` — the generic agent domain
 * must not learn what a transcript record is. Traffic flows one way: this
 * directory produces `AgentAdapterObservation`s and hands them to Phase 11's
 * `ingestObservation`.
 *
 * Observed live against Claude Code 2.1.270 on win32; see
 * docs/phase-12-real-claude-code-adapter.md for the full source survey.
 */

/**
 * One entry of `~/.claude/sessions/<pid>.json`, reduced to the fields this
 * feature actually uses.
 *
 * The real file carries more, including `messagingSocketPath` — a live named
 * pipe into the running session. It is deliberately absent from this type and
 * dropped at the reader, so no later code can reach a control channel simply
 * by following a field that happened to be in scope.
 */
export type ClaudeSessionRegistryEntry = {
  sessionId: string;
  /** Absolute project directory of the session, as Claude Code records it. */
  cwd: string;
  /** Raw provider status string, un-mapped. `"busy"` and `"idle"` observed. */
  status?: string;
  /** Claude Code's own derived name for the session, used as a run title. */
  name?: string;
  version?: string;
  startedAt?: number;
  statusUpdatedAt?: number;
};

/**
 * A transcript record, reduced to the allowlisted fields.
 *
 * The parser never carries a record's message content forward. What survives
 * parsing is this and nothing else, which is why no later layer has the
 * option of leaking a prompt: it never receives one.
 */
export type ClaudeParsedRecord = {
  /** Record `type` as written by Claude Code, kept only for filtering. */
  type: string;
  /** Stable per-record id. Used as an event `sourceId` when no tool id exists. */
  uuid?: string;
  timestamp?: number;
  gitBranch?: string;
  /** Tool invocations extracted from an `assistant` record's content blocks. */
  tools: ClaudeToolUse[];
  /**
   * Task-list activity extracted from the same content blocks.
   *
   * Separate from `tools` because it feeds an entirely different thing: tools
   * become activity summaries and artifacts, task events become work items.
   * Keeping them apart means neither pipeline has to filter the other's
   * records out.
   */
  tasks: ClaudeTaskEvent[];
};

/**
 * One entry in Claude Code's own task list, reduced to allowlisted fields.
 *
 * **Why this is safe to read.** These come from the structured input of the
 * `TaskCreate` / `TaskUpdate` tools, exactly as `file_path` and a shell tool's
 * `description` already do — the established Phase 12 pattern of reading a
 * *named, structured* input key rather than scraping prose. `subject` and
 * `description` are the human-readable task text Claude Code renders in its
 * own UI: they are not a prompt, not a command, not a tool result and not
 * hidden reasoning, all of which live in fields this parser has no branch for.
 *
 * **What is deliberately not read.** `mcp__ccd_session__spawn_task` carries a
 * `prompt` field holding raw instructions and frequently code; it is not in
 * the tool allowlist below and must never be added. The distinction is that
 * `subject` is a label *about* work, while `prompt` is the work's input.
 *
 * Observed live against the transcripts on the survey machine: of 148
 * transcripts, 2 used these tools; `TodoWrite` never fired at all (its 146
 * textual occurrences are the tool listing inside system prompts, and the
 * `todos` key appears zero times). See
 * docs/phase-15-agent-work-tracking.md for the full survey.
 */
export type ClaudeTaskEvent =
  | {
      kind: "create";
      /** The task's human-readable title, from `subject`. */
      subject: string;
      /** Longer human-readable detail, from `description`. */
      description?: string;
    }
  | {
      kind: "update";
      /** Claude Code's own id for the task, scoped to the session. */
      taskId: string;
      status: ClaudeTaskStatus;
    };

/**
 * Task statuses Claude Code actually writes.
 *
 * Only these two were observed across every `TaskUpdate` on the survey
 * machine (15 `completed`, 13 `in_progress`). Anything else is unrecognised
 * and means *no status change* — never a guessed one.
 */
export type ClaudeTaskStatus = "in_progress" | "completed";

export function isClaudeTaskStatus(value: unknown): value is ClaudeTaskStatus {
  return value === "in_progress" || value === "completed";
}

/**
 * Raw task status -> TabDump work item status.
 *
 * `in_progress` maps to `active` and `completed` to `completed`. There is no
 * mapping onto `blocked` or `cancelled`, because Claude Code writes neither —
 * inventing one would manufacture states that were never observed.
 */
export function mapClaudeTaskStatus(raw: unknown): "active" | "completed" | undefined {
  if (raw === "in_progress") return "active";
  if (raw === "completed") return "completed";
  return undefined;
}

/**
 * One `tool_use` block, reduced to what a safe summary needs.
 *
 * `id` is Claude's own `toolu_…` identifier and is the deduplication key —
 * far better than hashing display text, which would collide the moment an
 * agent edited the same file twice.
 */
export type ClaudeToolUse = {
  id: string;
  name: string;
  /**
   * Basename only, never a directory. Extracted from structured tool input
   * (`file_path`, `path`), never scraped from free text. This is what an
   * activity summary shows.
   */
  fileName?: string;
  /**
   * The paths exactly as the tool recorded them, usually absolute.
   *
   * SERVER-SIDE ONLY. These exist so the normalizer can express them relative
   * to the session's project root; they are consumed there and never travel
   * to the browser. Plural because a single tool invocation may
   * structurally name more than one file — read from allowlisted input keys,
   * never scraped from prose.
   */
  filePaths?: string[];
  /**
   * The human-written `description` a shell tool carries alongside its
   * command. The command itself is never read.
   */
  description?: string;
  /** A URL the tool navigated to, for exact-match tab linking. */
  url?: string;
};

/** How a session's transcript is being followed. Server-owned; opaque to the browser. */
export type ClaudeTranscriptCursor = {
  sessionId: string;
  /**
   * Byte offset of the start of the first line not yet processed.
   *
   * Always positioned immediately after a newline, so a partially written
   * final line is simply re-read next poll rather than parsed in half. This
   * is why no separate "partial line" buffer is needed.
   */
  offset: number;
  /** File size when the offset was taken, used to detect truncation or replacement. */
  size: number;
  /**
   * How many tasks this session has created so far, across every poll.
   *
   * The running counter that gives a task its identity — see `taskExternalId`
   * in ./normalizer.ts. It lives in the cursor because the cursor is the only
   * per-session state that survives a poll, and it is server-owned for the
   * same reason the offset is: the browser has no business constructing it.
   *
   * A forged or absent value costs correctness nothing that matters: task
   * numbering shifts, updates stop matching creations, and the domain records
   * fewer work items. It can never attach a status to the wrong *existing*
   * item, because an item is only ever matched within its own run.
   */
  taskOrdinal: number;
};

/** A session the reader found, with everything the client needs to decide what to do with it. */
export type ClaudeDiscoveredSession = {
  externalId: string;
  /**
   * The session's absolute project directory.
   *
   * This is the one absolute local path that crosses to the browser, and it
   * does so because the mapping this feature is built around is "the user
   * explicitly says which of *their* projects is which workspace" — a choice
   * that cannot be offered without showing them the project. It is never used
   * in an activity summary, and the endpoint only ever serves the machine the
   * browser is already running on. See the security note in the docs.
   */
  projectPath: string;
  /** Mapped TabDump status, or absent when the provider status was unrecognised. */
  status?: "working" | "waiting";
  title?: string;
  gitBranch?: string;
  /**
   * Set when Claude Code recorded an explicit lifecycle artifact for this
   * session. The only value observed is "deleted" — see TERMINAL_REASONS.
   */
  terminal?: ClaudeTerminalReason;
  lastObservedAt: number;
};

/**
 * Explicit end-of-life signals Claude Code writes down.
 *
 * Only one exists: a `<sessionId>.desktop-released.json` sidecar, whose
 * `reason` was `"delete"` in all 21 instances on the survey machine. It means
 * *the user deleted the session record in the desktop app* — not that the
 * work failed, and not that it succeeded. The transcript survives it (all 20
 * checked still had one), which is the clearest evidence that the sidecar is
 * about the record rather than the run.
 *
 * Crucially, a session that simply exits writes NOTHING: the vanished session
 * observed during the survey left its transcript and no sidecar at all. So
 * disappearance is not a terminal signal and is never treated as one.
 */
export type ClaudeTerminalReason = "deleted";

/** Raw provider status -> TabDump status. Anything else means "no status change". */
export function mapClaudeStatus(raw: unknown): "working" | "waiting" | undefined {
  if (raw === "busy") return "working";
  if (raw === "idle") return "waiting";
  return undefined;
}

/** The provider key this whole directory speaks for. */
export const CLAUDE_CODE_PROVIDER = "claude-code";

/** Display name for the single provider-level Agent. */
export const CLAUDE_CODE_AGENT_NAME = "Claude Code";

/**
 * Bounds, all of them deliberate.
 *
 * Transcripts on the survey machine reached 17.4 MB. Reading one end to end
 * on every poll would be the single worst thing this feature could do to the
 * machine it is observing, so every dimension of a poll is capped.
 */
export const CLAUDE_LIMITS = {
  /** Sessions inspected per poll. */
  maxSessions: 24,
  /** Bytes of transcript read per session per poll. A backlog is caught up over several polls. */
  maxBytesPerPoll: 256 * 1024,
  /** How far back to look when a session is seen for the first time. */
  initialTailBytes: 64 * 1024,
  /** Tool invocations turned into observations per session per poll. */
  maxObservationsPerSession: 50,
} as const;

/** Poll interval. Slow enough to be unnoticeable, fast enough to feel live. */
export const CLAUDE_POLL_INTERVAL_MS = 5_000;
