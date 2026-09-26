import "server-only";
import type {
  ClaudeCredentialSource,
  ClaudePermissionDecision,
  ClaudeRuntime,
  ClaudeRuntimeAvailability,
  ClaudeRuntimeError,
  ClaudeRuntimeHandle,
  ClaudeRuntimeMessage,
  ClaudeRuntimeStartOptions,
  ClaudeRuntimeStartResult,
} from "./runtime";

/** The environment variable a session's Hubble context credential travels in (Phase J.3). */
export const CONTEXT_TOKEN_ENV = "TABDUMP_CONTEXT_TOKEN";

/**
 * The real Claude runtime, on `@anthropic-ai/claude-agent-sdk`.
 *
 * **The only module in Hubble that imports the SDK.** Everything else —
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
 * the life of the conversation. Hubble receives messages one at a time from
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
  /**
   * Supplies the SDK module directly instead of importing it by specifier.
   *
   * The desktop runtime (Phase J.1) is a single bundled file with no
   * `node_modules` beside it, so the SDK has to be part of the bundle — which
   * needs a literal `import()` the bundler can see. That import lives in the
   * desktop entry, and is handed in here.
   */
  loadModule?: () => Promise<unknown>;
  /**
   * The Claude Code executable to drive, when it is not the SDK's own bundled
   * binary.
   *
   * The desktop runtime drives the user's *installed* Claude Code, resolved
   * from the launch allowlist — which is also where that user's own login
   * lives. Never taken from a request.
   */
  executablePath?: string;
  idleTimeoutMs?: number;
  /**
   * The signed-in user's own provider credential.
   *
   * Required. Before this phase the local runtime inherited whatever Claude
   * Code login happened to exist in the process environment — which on a
   * developer's own machine is their own credential and is fine, and on any
   * deployment with an `ANTHROPIC_API_KEY` set is *the operator's*, used
   * silently for everybody. There is no way to tell those two apart from
   * inside this function, so it no longer tries: the credential arrives
   * explicitly or the run does not start.
   */
  credentials: ClaudeCredentialSource;
  /**
   * The environment the agent process inherits, minus its credential.
   *
   * Injected so the stripping below is testable without a real `process.env`.
   */
  baseEnv?: Readonly<Record<string, string | undefined>>;
};

/**
 * Provider credential variables removed from the inherited environment.
 *
 * The user's own key is written over the top of these anyway, so stripping
 * them changes no outcome — it removes the *path*. A future edit that forgot
 * to set one of them would otherwise fall through to the operator's key and
 * work, which is precisely the silent fallback §6 forbids and precisely the
 * kind of bug that is invisible until a billing statement arrives.
 */
const INHERITED_CREDENTIAL_VARS: readonly string[] = [
  "ANTHROPIC_API_KEY",
  "ANTHROPIC_AUTH_TOKEN",
  "ANTHROPIC_BASE_URL",
] as const;

export function createSdkClaudeRuntime(options: SdkClaudeRuntimeOptions): ClaudeRuntime {
  const specifier = options.moduleSpecifier ?? "@anthropic-ai/claude-agent-sdk";
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;

  /**
   * The environment one agent process runs in.
   *
   * Built fresh per run, from a copy of the base environment with every
   * provider credential variable deleted, then the resolved credential
   * written in. Nothing mutates `process.env`, so two concurrent sessions
   * belonging to two different users cannot see each other's key — which they
   * would if this set a global and cleared it afterwards.
   */
  /**
   * The session's MCP configuration: Hubble's session server, or nothing.
   *
   * The header names the credential by environment variable. Claude Code
   * expands `${VAR}` in MCP headers (verified against 2.1.x), so the
   * command line the SDK builds carries the placeholder, never the token.
   */
  function contextMcpServers(server: ClaudeRuntimeStartOptions["contextServer"]): Record<string, unknown> {
    if (!server) return {};
    return {
      [server.name]: {
        type: "http",
        url: server.url,
        headers: { Authorization: "Bearer " + "$" + "{" + CONTEXT_TOKEN_ENV + "}" },
      },
    };
  }

  function environmentFor(credentialEnv: Readonly<Record<string, string>>): Record<string, string> {
    const base = options.baseEnv ?? process.env;
    const env: Record<string, string> = {};

    for (const [key, value] of Object.entries(base)) {
      if (value === undefined) continue;
      if (INHERITED_CREDENTIAL_VARS.includes(key)) continue;
      env[key] = value;
    }

    return { ...env, ...credentialEnv };
  }

  type SdkModule = {
    query(params: { prompt: unknown; options?: Record<string, unknown> }): AsyncGenerator<
      ClaudeRuntimeMessage,
      void
    > & {
      interrupt(): Promise<unknown>;
    };
  };

  async function loadSdk(): Promise<SdkModule | null> {
    if (options.loadModule) {
      try {
        return (await options.loadModule()) as SdkModule;
      } catch {
        return null;
      }
    }
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
      // Both halves. A machine with the SDK installed and no connected
      // credential cannot run an agent, and reporting it as available is how
      // a user gets a session that dies on its first message.
      if ((await loadSdk()) === null) return false;
      return (await options.credentials()).ok;
    },

    async describeAvailability(): Promise<ClaudeRuntimeAvailability> {
      if ((await loadSdk()) === null) return { kind: "unavailable" };

      const credential = await options.credentials();
      if (!credential.ok) return { kind: "credential-required", reason: credential.reason };
      return { kind: "available" };
    },

    async start(start: ClaudeRuntimeStartOptions): Promise<ClaudeRuntimeStartResult> {
      const sdk = await loadSdk();
      if (!sdk) {
        return { ok: false, error: { code: "not-installed" } };
      }

      // Resolved here, per run, and never held on the runtime. A user who
      // disconnected their credential a minute ago cannot start a session
      // now, even though this runtime object was built before they did.
      const credential = await options.credentials();
      if (!credential.ok) {
        return { ok: false, error: { code: "authentication", detail: credential.reason } };
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
            // The credential's only crossing on the local plane. It reaches
            // the agent process as one entry in its environment and appears
            // nowhere else in this call: not in `allowedTools`, not in a
            // prompt, not in a path, not in anything the queue carries.
            // The session's Hubble context credential (J.3) travels here too,
            // as one variable of this agent's own environment — never on its
            // command line, where `--mcp-config` would otherwise put it.
            env: environmentFor({
              ...credential.env,
              ...(start.contextServer ? { [CONTEXT_TOKEN_ENV]: start.contextServer.token } : {}),
            }),
            ...(options.executablePath ? { pathToClaudeCodeExecutable: options.executablePath } : {}),
            ...(start.cwd ? { cwd: start.cwd } : {}),
            ...(start.additionalDirectories.length > 0
              ? { additionalDirectories: [...start.additionalDirectories] }
              : {}),
            permissionMode: start.permissionMode,
            allowedTools: [...start.allowedTools],
            disallowedTools: [...start.disallowedTools],
            ...(start.resume ? { resume: start.resume } : {}),
            // No MCP server but Hubble's own session server (J.3), and none
            // at all without workspace context. `strictMcpConfig` makes the
            // CLI ignore every server it would otherwise inherit from the
            // user's own configuration, so a session cannot silently gain
            // tools Hubble never authorized. See docs/claude-code-control.md.
            mcpServers: contextMcpServers(start.contextServer),
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
