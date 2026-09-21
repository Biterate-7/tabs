import "server-only";
import type {
  ClaudePermissionDecision,
  ClaudeRuntime,
  ClaudeRuntimeError,
  ClaudeRuntimeHandle,
  ClaudeRuntimeMessage,
  ClaudeRuntimeStartOptions,
  ClaudeRuntimeStartResult,
} from "./runtime";

/**
 * The real Claude runtime, on `@anthropic-ai/claude-agent-sdk`.
 *
 * **The only module in TabDump that imports the SDK.** Everything else —
 * the adapter, the normalizer, the permission mapping, the control service —
 * works against the narrow interface in ./runtime.ts, so the provider's types
 * never leak and replacing it is one file.
 *
 * ## server-only, and why that matters here more than anywhere else
 *
 * The first line makes this module a build error if it is ever reached from a
 * client component. That is not defence in depth for its own sake: this
 * module spawns a Claude Code process with filesystem access, and a bundler
 * that pulled it into the browser graph would be shipping the *shape* of that
 * capability to every visitor of a hosted deployment.
 *
 * The SDK itself is reached through a **dynamic** import inside the function
 * that needs it, for the same reason `lib/platform/desktop.ts` reaches Tauri
 * that way: a static import is evaluated when the module is, and this module
 * is imported by a route that must be able to *load* on a hosted deployment
 * in order to refuse cleanly.
 *
 * ## The runtime boundary is not checked here
 *
 * Deliberately. `../../runtime.ts` answers "may this deployment execute
 * agents", and the control service checks it before anything reaches an
 * adapter. Repeating that check here would suggest this module is safe to
 * call directly, which it is not — it is safe to call *after* the boundary
 * has said yes.
 */

/** Cap on how long a run may sit with no provider output before it is failed. */
const IDLE_TIMEOUT_MS = 10 * 60 * 1000;

/**
 * A queue that turns imperative `send` calls into the async iterable the SDK
 * wants for streaming input.
 *
 * The SDK takes `prompt: AsyncIterable<SDKUserMessage>` and consumes it for
 * the life of the conversation. TabDump receives messages one at a time from
 * a user, so this bridges the two: `push` hands a turn to whatever the
 * generator is currently awaiting, and `close` ends the conversation.
 *
 * Without this, each message would need its own `query()` — a new process per
 * turn, losing all conversation context, which is exactly what §12 of the
 * brief forbids.
 */
function createMessageQueue() {
  const waiting: Array<(value: IteratorResult<unknown>) => void> = [];
  const buffered: unknown[] = [];
  let closed = false;

  return {
    push(value: unknown): void {
      if (closed) return;
      const next = waiting.shift();
      if (next) next({ value, done: false });
      else buffered.push(value);
    },
    close(): void {
      if (closed) return;
      closed = true;
      // Release every pending consumer, or the generator never returns and
      // the SDK's process is never torn down.
      while (waiting.length > 0) waiting.shift()!({ value: undefined, done: true });
    },
    isClosed: () => closed,
    async *[Symbol.asyncIterator](): AsyncGenerator<unknown> {
      for (;;) {
        if (buffered.length > 0) {
          yield buffered.shift();
          continue;
        }
        if (closed) return;

        const result = await new Promise<IteratorResult<unknown>>((resolve) => {
          waiting.push(resolve);
        });
        if (result.done) return;
        yield result.value;
      }
    },
  };
}

/** Shapes a user turn the way the SDK's streaming input expects. */
function userMessage(text: string, sessionId: string) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: text },
    parent_tool_use_id: null,
    session_id: sessionId,
  };
}

/**
 * Classifies a thrown value without letting its text escape.
 *
 * The message is inspected only to choose a *code*; the raw string goes into
 * `detail`, which the adapter uses for diagnosis and never renders. This is
 * the same discipline `connectorError` already applies on the observation
 * side — a provider must not get to choose what a user reads.
 */
function classify(error: unknown): ClaudeRuntimeError {
  const detail = error instanceof Error ? error.message : String(error);
  const lowered = detail.toLowerCase();

  if (lowered.includes("enoent") || lowered.includes("not found")) {
    return { code: "not-installed", detail };
  }
  if (
    lowered.includes("authentication") ||
    lowered.includes("unauthorized") ||
    lowered.includes("api key") ||
    lowered.includes("oauth")
  ) {
    return { code: "authentication", detail };
  }
  return { code: "process-failed", detail };
}

export type SdkClaudeRuntimeOptions = {
  /**
   * Overrides the module specifier the SDK is loaded from.
   *
   * Exists so the opt-in integration test can point at the installed package
   * explicitly. Production passes nothing and gets the package name.
   */
  moduleSpecifier?: string;
  idleTimeoutMs?: number;
};

export function createSdkClaudeRuntime(
  options: SdkClaudeRuntimeOptions = {}
): ClaudeRuntime {
  const specifier = options.moduleSpecifier ?? "@anthropic-ai/claude-agent-sdk";
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  type SdkModule = {
    query(params: { prompt: unknown; options?: Record<string, unknown> }): AsyncGenerator<
      ClaudeRuntimeMessage,
      void
    > & {
      interrupt(): Promise<unknown>;
    };
  };

  async function loadSdk(): Promise<SdkModule | null> {
    try {
      // Dynamic, and the specifier is a constant from this module — never a
      // caller-supplied string, so this cannot become an arbitrary-module
      // loader.
      return (await import(/* webpackIgnore: true */ specifier)) as unknown as SdkModule;
    } catch {
      return null;
    }
  }

  return {
    async isAvailable(): Promise<boolean> {
      return (await loadSdk()) !== null;
    },

    async start(start: ClaudeRuntimeStartOptions): Promise<ClaudeRuntimeStartResult> {
      const sdk = await loadSdk();
      if (!sdk) {
        return { ok: false, error: { code: "not-installed" } };
      }

      const queue = createMessageQueue();
      const abort = new AbortController();
      let active = true;
      let exited = false;
      let idleTimer: ReturnType<typeof setTimeout> | null = null;

      function finish(error?: ClaudeRuntimeError): void {
        if (exited) return;
        exited = true;
        active = false;
        if (idleTimer) clearTimeout(idleTimer);
        queue.close();
        start.onExit(error);
      }

      function touchIdle(): void {
        if (idleTimer) clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          // A run that has said nothing for the whole window is not going to.
          // Aborting reaches the process rather than merely giving up on it,
          // so nothing is left running.
          abort.abort();
          finish({ code: "timeout" });
        }, idleTimeoutMs);
      }

      let query: ReturnType<SdkModule["query"]>;
      try {
        query = sdk.query({
          prompt: queue,
          options: {
            abortController: abort,
            ...(start.cwd ? { cwd: start.cwd } : {}),
            ...(start.additionalDirectories.length > 0
              ? { additionalDirectories: [...start.additionalDirectories] }
              : {}),
            permissionMode: start.permissionMode,
            allowedTools: [...start.allowedTools],
            disallowedTools: [...start.disallowedTools],
            ...(start.resume ? { resume: start.resume } : {}),
            // TabDump configures no MCP servers, and says so explicitly
            // rather than by omission: `strictMcpConfig` makes the CLI ignore
            // every server it would otherwise inherit from the user's own
            // configuration, so a session cannot silently gain tools TabDump
            // never authorized. See docs/claude-code-control.md.
            mcpServers: {},
            strictMcpConfig: true,
            // The permission callback. This is the whole reason the SDK was
            // chosen over the CLI: it is invoked per tool call and awaits a
            // verdict, which is what makes an approval real.
            canUseTool: async (
              toolName: string,
              input: Record<string, unknown>,
              meta: Record<string, unknown>
            ): Promise<ClaudePermissionDecision> =>
              start.onPermissionRequest({
                toolName,
                input,
                toolUseId: typeof meta.toolUseID === "string" ? meta.toolUseID : "",
                requestId: typeof meta.requestId === "string" ? meta.requestId : "",
                ...(typeof meta.title === "string" ? { title: meta.title } : {}),
                ...(typeof meta.displayName === "string"
                  ? { displayName: meta.displayName }
                  : {}),
                ...(typeof meta.description === "string"
                  ? { description: meta.description }
                  : {}),
                ...(typeof meta.decisionReason === "string"
                  ? { decisionReason: meta.decisionReason }
                  : {}),
                ...(typeof meta.blockedPath === "string"
                  ? { blockedPath: meta.blockedPath }
                  : {}),
                signal: meta.signal instanceof AbortSignal ? meta.signal : abort.signal,
              }),
          },
        });
      } catch (error) {
        finish(classify(error));
        return { ok: false, error: classify(error) };
      }

      // Drains the provider's output for the life of the run. Not awaited:
      // `start` resolves once the run is live, and messages arrive after.
      void (async () => {
        try {
          touchIdle();
          for await (const message of query) {
            touchIdle();
            start.onMessage(message);
          }
          finish();
        } catch (error) {
          // An abort is how cancellation and idle-timeout both land here.
          // Neither is a failure worth reporting as one.
          if (abort.signal.aborted) finish();
          else finish(classify(error));
        }
      })();

      const handle: ClaudeRuntimeHandle = {
        async send(text: string): Promise<void> {
          if (!active || queue.isClosed()) throw new Error("session is not active");
          queue.push(userMessage(text, start.sessionId));
        },

        async interrupt(): Promise<void> {
          if (!active) return;
          try {
            // The supported mechanism: it reaches the running turn rather
            // than killing the process, so the session stays resumable.
            await query.interrupt();
          } catch {
            // A CLI too old to support it, or a turn that already ended.
            // Aborting is the backstop, and it genuinely stops the process.
            abort.abort();
          }
        },

        async dispose(): Promise<void> {
          if (exited) return;
          queue.close();
          abort.abort();
          finish();
        },

        isActive: () => active,
      };

      return { ok: true, handle };
    },
  };
}
