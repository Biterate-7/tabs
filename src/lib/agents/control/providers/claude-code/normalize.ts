import { toProjectRelative } from "@/lib/agents/paths";
import { boundMessageText, normalizeControlSummary } from "../../events";
import type { AgentControlEvent, AgentControlEventKind, ControlFileInfo } from "../../events";
import type { ClaudeRuntimeMessage } from "./runtime";

/**
 * Provider messages, reduced to the canonical event.
 *
 * ## Defensive by construction
 *
 * Every field is read through a guard. The SDK's message union has around
 * forty members and grows with the CLI, so a normalizer that destructured it
 * confidently would break on a version bump. This one recognises the shapes
 * it knows and returns `[]` for everything else — an unknown message is not
 * an error, it is a message from a newer Claude than this build was written
 * against.
 *
 * ## What is deliberately dropped
 *
 * - **Tool inputs.** A `Bash` command string, an `Edit` patch body, a
 *   `Write` file content. `ControlToolInfo` has nowhere to put them, and this
 *   module never tries.
 * - **Tool results.** Command output, file contents, search hits.
 * - **Absolute paths.** Every path is reduced against the project root, and
 *   one that will not reduce is dropped rather than emitted — see
 *   `fileInfoFor`.
 * - **Thinking content.** Presence becomes a `thinking` event; the text does
 *   not travel.
 *
 * ## Why file events come from tool calls rather than from prose
 *
 * The brief's rule, and the observation plane's existing rule: a file event
 * is emitted only when a structured `tool_use` block names a path in its
 * input. Nothing here reads assistant prose looking for filenames, because
 * that produces confident nonsense the first time Claude mentions a file it
 * did not touch.
 */

export type NormalizeContext = {
  sessionId: string;
  /** Hubble's project id, for `ControlFileInfo`. Absent when the session has no project. */
  projectId?: string;
  /** The project root, for reducing absolute paths. Absent when the session has no project. */
  projectPath?: string;
  /** The domain run this session is currently producing, once it has one. */
  runId?: string;
  now: number;
  /** Mints event ids. Injected so tests are deterministic. */
  createId: () => string;
};

function str(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The tool-input keys that name a file, in priority order.
 *
 * An allowlist. A tool whose input happens to contain some other string is
 * not mined for paths — only these keys are read, because only these are
 * documented to hold one.
 */
const PATH_KEYS = ["file_path", "notebook_path", "path"] as const;

/** Tools whose use means the agent read a file. */
const READ_TOOLS = new Set(["Read", "NotebookRead"]);
/** Tools whose use means the agent changed a file that already existed. */
const EDIT_TOOLS = new Set(["Edit", "NotebookEdit"]);
/** Tools whose use may create a file. */
const WRITE_TOOLS = new Set(["Write"]);
/** Tools that execute rather than touch files. */
const COMMAND_TOOLS = new Set(["Bash", "BashOutput", "KillShell"]);

/**
 * Reduces a provider path to project-relative form, or gives up.
 *
 * Delegates to `lib/agents/paths.ts`, which the observation plane already
 * uses for exactly this, rather than reimplementing containment. A path that
 * does not reduce — outside the project, traversing, drive-relative — yields
 * `undefined`, and the caller emits a tool event without a file rather than
 * an event carrying an absolute path.
 */
function fileInfoFor(
  input: Record<string, unknown>,
  context: NormalizeContext
): ControlFileInfo | undefined {
  if (!context.projectId || !context.projectPath) return undefined;

  for (const key of PATH_KEYS) {
    const candidate = str(input[key]);
    if (!candidate) continue;

    const reduced = toProjectRelative(context.projectPath, candidate);
    if (reduced.ok) {
      return { relativePath: reduced.relativePath, projectId: context.projectId };
    }
  }

  return undefined;
}

function event(
  kind: AgentControlEventKind,
  summary: string,
  context: NormalizeContext,
  extra: Partial<AgentControlEvent> = {}
): AgentControlEvent {
  const base: AgentControlEvent = {
    id: context.createId(),
    sessionId: context.sessionId,
    provider: "claude-code",
    kind,
    timestamp: context.now,
    summary: normalizeControlSummary(summary),
    ...extra,
  };

  if (context.runId && !base.runId) base.runId = context.runId;
  return base;
}

/**
 * The file event a tool call implies, if any.
 *
 * `Write` is reported as `file_modified` rather than `file_created`, because
 * the provider does not say whether the file already existed and Hubble will
 * not guess. The observation plane made the same call for the same reason —
 * see the note on `AgentRunArtifactRole` in the domain types.
 */
function fileEventKindFor(toolName: string): AgentControlEventKind | null {
  if (READ_TOOLS.has(toolName)) return "file_read";
  if (EDIT_TOOLS.has(toolName) || WRITE_TOOLS.has(toolName)) return "file_modified";
  return null;
}

/** Events for one `tool_use` content block. */
function fromToolUse(
  block: Record<string, unknown>,
  context: NormalizeContext
): AgentControlEvent[] {
  const toolName = str(block.name);
  if (!toolName) return [];

  const callId = str(block.id);
  const input = record(block.input) ?? {};
  const isCommand = COMMAND_TOOLS.has(toolName);

  const events: AgentControlEvent[] = [
    event(isCommand ? "command_started" : "tool_started", toolName, context, {
      tool: callId ? { name: toolName, callId } : { name: toolName },
    }),
  ];

  // A file event only when a structured path key is present AND reduces.
  const fileKind = fileEventKindFor(toolName);
  if (fileKind) {
    const file = fileInfoFor(input, context);
    if (file) {
      events.push(
        event(fileKind, `${summaryVerbFor(fileKind)} ${file.relativePath}`, context, { file })
      );
    }
  }

  return events;
}

function summaryVerbFor(kind: AgentControlEventKind): string {
  return kind === "file_read" ? "Read" : "Edited";
}

/** Events for one assistant message's content blocks. */
function fromAssistant(
  message: Record<string, unknown>,
  context: NormalizeContext
): AgentControlEvent[] {
  const inner = record(message.message);
  if (!inner) return [];

  const events: AgentControlEvent[] = [];
  let text = "";
  let sawThinking = false;

  for (const raw of list(inner.content)) {
    const block = record(raw);
    if (!block) continue;

    switch (str(block.type)) {
      case "text": {
        const value = str(block.text);
        if (value) text += text ? ` ${value}` : value;
        break;
      }
      case "thinking":
      case "redacted_thinking":
        // Presence only. The content never travels.
        sawThinking = true;
        break;
      case "tool_use":
        events.push(...fromToolUse(block, context));
        break;
      default:
        break;
    }
  }

  if (text) {
    // The summary stays the collapsed one-liner the durable log wants; the
    // reply itself rides in `text` for the chat surface. See TEXT_EVENT_KINDS.
    const full = boundMessageText(
      list(inner.content)
        .map((raw) => record(raw))
        .filter((block) => block && str(block.type) === "text")
        .map((block) => (block ? (str(block.text) ?? "") : ""))
        .filter(Boolean)
        .join("\n\n")
    );
    events.unshift(event("message_received", text, context, { text: full }));
  } else if (sawThinking && events.length === 0) {
    // A turn that is only thinking so far. Reported as `thinking` rather than
    // as an empty message, so a UI can say "working" without inventing prose.
    events.unshift(event("thinking", "Thinking", context));
  }

  return events;
}

/**
 * Events for a user message.
 *
 * In this stream a `user` message is usually the *tool result* being fed
 * back, not something a person typed. Only the result case is normalized:
 * Hubble already knows what it sent, and re-emitting its own message as
 * `message_sent` from the provider's echo would double-count it.
 */
function fromUser(
  message: Record<string, unknown>,
  context: NormalizeContext
): AgentControlEvent[] {
  const inner = record(message.message);
  if (!inner) return [];

  const events: AgentControlEvent[] = [];

  for (const raw of list(inner.content)) {
    const block = record(raw);
    if (!block || str(block.type) !== "tool_result") continue;

    const callId = str(block.tool_use_id);
    // `is_error` is the provider's own flag. Absent means success.
    const failed = block.is_error === true;

    events.push(
      event("tool_finished", failed ? "Tool failed" : "Tool finished", context, {
        tool: callId ? { name: "tool", callId, ok: !failed } : { name: "tool", ok: !failed },
      })
    );
  }

  return events;
}

/** The result message ends the run, one way or another. */
function fromResult(
  message: Record<string, unknown>,
  context: NormalizeContext
): AgentControlEvent[] {
  const subtype = str(message.subtype);
  const isError = message.is_error === true || subtype === "error_during_execution";

  if (subtype === "error_max_turns") {
    return [event("error", "Reached the turn limit for this run.", context)];
  }

  if (isError) {
    return [event("error", "The agent stopped with an error.", context)];
  }

  return [event("run_completed", "Run completed.", context)];
}

/**
 * One provider message, normalized.
 *
 * Returns an array because a single assistant message routinely produces
 * several events — some prose, a tool call, and the file that tool touched.
 * Returns `[]` for anything unrecognised.
 */
export function normalizeClaudeMessage(
  message: ClaudeRuntimeMessage,
  context: NormalizeContext
): AgentControlEvent[] {
  const type = str(message.type);
  if (!type) return [];

  switch (type) {
    case "system":
      // Only `init` is meaningful to the control plane; the rest are
      // diagnostics about the provider's own configuration.
      return str(message.subtype) === "init"
        ? [event("session_started", "Session started.", context)]
        : [];
    case "assistant":
      return fromAssistant(message, context);
    case "user":
      return fromUser(message, context);
    case "result":
      return fromResult(message, context);
    default:
      // Partial messages, status frames, hook frames, task frames, and
      // everything a future CLI adds. Recognised as "not for us" rather than
      // guessed at.
      return [];
  }
}

/**
 * The provider's own session id, if this message carries one.
 *
 * Pulled out separately from event normalization because it is correlation
 * rather than activity: the adapter needs it to persist a resumable handle,
 * and it arrives on the first frame rather than as an event.
 */
export function providerSessionIdOf(message: ClaudeRuntimeMessage): string | undefined {
  return str(message.session_id);
}
