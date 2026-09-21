import type {
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudeRuntime,
  ClaudeRuntimeError,
  ClaudeRuntimeHandle,
  ClaudeRuntimeMessage,
  ClaudeRuntimeStartOptions,
} from "../runtime";

/**
 * A Claude runtime driven by the test instead of by Claude.
 *
 * ## Why this is not a mock
 *
 * It is a real implementation of the real `ClaudeRuntime` contract. The
 * adapter cannot tell it apart from the SDK-backed one: same interface, same
 * lifecycle, same ordering guarantees, same `onExit`-exactly-once rule. What
 * differs is only *where the messages come from* — the test pushes them
 * rather than a model producing them.
 *
 * That distinction matters because the brief forbids hiding lifecycle
 * problems behind mocks. A `vi.mock` of the SDK would assert that the adapter
 * calls a function; this asserts that the adapter behaves correctly across a
 * whole session lifecycle, which is a different and much more useful claim.
 *
 * ## The messages are real shapes
 *
 * Everything the helpers below emit is shaped like an actual
 * `@anthropic-ai/claude-agent-sdk` message, taken from the installed
 * package's type declarations (0.3.278). If the SDK's shapes change, these
 * fixtures are wrong in the same way the normalizer is wrong, and the
 * opt-in integration test is what catches that.
 */

export type ScriptedRun = {
  /** The options the adapter started this run with. Asserted directly by tests. */
  readonly options: ClaudeRuntimeStartOptions;
  /** Every user turn the adapter has sent, in order. */
  readonly sent: readonly string[];
  /** How many times the run was interrupted. */
  readonly interrupts: number;
  /** Whether the run has been disposed. */
  readonly disposed: boolean;
  /** Whether `onExit` has fired. */
  readonly exited: boolean;

  /** Delivers a provider message to the adapter. */
  emit(message: ClaudeRuntimeMessage): void;
  /**
   * Raises a permission request and returns the promise the provider would be
   * blocked on. It resolves only when the adapter answers.
   */
  requestPermission(
    request?: Partial<ClaudePermissionRequest>
  ): Promise<ClaudePermissionDecision>;
  /** Ends the run, as the provider would. */
  finish(error?: ClaudeRuntimeError): void;
};

export type ScriptedRuntime = ClaudeRuntime & {
  /** Every run started, oldest first. */
  readonly runs: readonly ScriptedRun[];
  /** The most recent run, for the common single-run case. */
  latest(): ScriptedRun;
  /** Makes `start` fail with this error, once. */
  failNextStart(error: ClaudeRuntimeError): void;
  /** Makes `isAvailable` report false. */
  setAvailable(available: boolean): void;
};

export function createScriptedRuntime(): ScriptedRuntime {
  const runs: ScriptedRun[] = [];
  let available = true;
  let nextFailure: ClaudeRuntimeError | null = null;

  return {
    runs,

    latest() {
      const run = runs[runs.length - 1];
      if (!run) throw new Error("no run has been started");
      return run;
    },

    failNextStart(error) {
      nextFailure = error;
    },

    setAvailable(next) {
      available = next;
    },

    isAvailable: async () => available,

    async start(options: ClaudeRuntimeStartOptions) {
      if (nextFailure) {
        const error = nextFailure;
        nextFailure = null;
        return { ok: false as const, error };
      }

      const sent: string[] = [];
      let interrupts = 0;
      let disposed = false;
      let exited = false;
      let active = true;
      const abort = new AbortController();

      function exit(error?: ClaudeRuntimeError): void {
        // Exactly once, matching the contract the SDK runtime holds to. A
        // second call is what a buggy runtime would do, and the adapter must
        // not depend on being protected from it — so the fixture does not
        // protect it either beyond this guard.
        if (exited) return;
        exited = true;
        active = false;
        options.onExit(error);
      }

      const handle: ClaudeRuntimeHandle = {
        async send(text) {
          if (!active) throw new Error("session is not active");
          sent.push(text);
        },
        async interrupt() {
          interrupts += 1;
          abort.abort();
        },
        async dispose() {
          disposed = true;
          abort.abort();
          exit();
        },
        isActive: () => active,
      };

      const run: ScriptedRun = {
        options,
        get sent() {
          return sent;
        },
        get interrupts() {
          return interrupts;
        },
        get disposed() {
          return disposed;
        },
        get exited() {
          return exited;
        },
        emit(message) {
          options.onMessage(message);
        },
        requestPermission(overrides = {}) {
          return options.onPermissionRequest({
            toolName: "Edit",
            toolUseId: "toolu_1",
            requestId: "req_1",
            input: {},
            signal: abort.signal,
            ...overrides,
          });
        },
        finish(error) {
          exit(error);
        },
      };

      runs.push(run);
      return { ok: true as const, handle };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Message fixtures — shaped like real SDK messages
 * ------------------------------------------------------------------ */

export function systemInit(sessionId: string, cwd = "C:/work/research"): ClaudeRuntimeMessage {
  return {
    type: "system",
    subtype: "init",
    session_id: sessionId,
    cwd,
    tools: ["Read", "Edit"],
    model: "claude-opus-5",
    permissionMode: "default",
    apiKeySource: "none",
    claude_code_version: "2.1.229",
    mcp_servers: [],
    uuid: "11111111-1111-1111-1111-111111111111",
  };
}

export function assistantText(sessionId: string, text: string): ClaudeRuntimeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: "22222222-2222-2222-2222-222222222222",
    message: {
      id: "msg_1",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "text", text }],
      stop_reason: null,
    },
  };
}

export function assistantThinking(sessionId: string): ClaudeRuntimeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: "33333333-3333-3333-3333-333333333333",
    message: {
      id: "msg_2",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "thinking", thinking: "secret reasoning that must not travel" }],
      stop_reason: null,
    },
  };
}

export function assistantToolUse(
  sessionId: string,
  name: string,
  input: Record<string, unknown>,
  id = "toolu_1"
): ClaudeRuntimeMessage {
  return {
    type: "assistant",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: "44444444-4444-4444-4444-444444444444",
    message: {
      id: "msg_3",
      role: "assistant",
      model: "claude-opus-5",
      content: [{ type: "tool_use", id, name, input }],
      stop_reason: null,
    },
  };
}

export function toolResult(
  sessionId: string,
  toolUseId = "toolu_1",
  isError = false
): ClaudeRuntimeMessage {
  return {
    type: "user",
    session_id: sessionId,
    parent_tool_use_id: null,
    uuid: "55555555-5555-5555-5555-555555555555",
    message: {
      role: "user",
      content: [
        {
          type: "tool_result",
          tool_use_id: toolUseId,
          is_error: isError,
          content: "file contents that must not travel",
        },
      ],
    },
  };
}

export function resultSuccess(sessionId: string): ClaudeRuntimeMessage {
  return {
    type: "result",
    subtype: "success",
    session_id: sessionId,
    is_error: false,
    duration_ms: 1200,
    num_turns: 1,
    result: "Done.",
    uuid: "66666666-6666-6666-6666-666666666666",
  };
}

export function resultError(
  sessionId: string,
  subtype: "error_during_execution" | "error_max_turns" = "error_during_execution"
): ClaudeRuntimeMessage {
  return {
    type: "result",
    subtype,
    session_id: sessionId,
    is_error: true,
    duration_ms: 400,
    num_turns: 1,
    uuid: "77777777-7777-7777-7777-777777777777",
  };
}
