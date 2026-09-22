import { parseBridgeLine } from "@/lib/agents/remote/bridge";
import { isDispatchableStatus, REMOTE_LIMITS } from "@/lib/agents/remote/types";
import type { BridgeConfig, BridgeLine } from "@/lib/agents/remote/bridge";
import type { RemoteSandboxService } from "@/lib/agents/remote/sandbox";
import type { RemoteStore } from "@/lib/agents/remote/store";
import type {
  ClaudePermissionRequest,
  ClaudeRuntime,
  ClaudeRuntimeError,
  ClaudeRuntimeHandle,
  ClaudeRuntimeStartOptions,
  ClaudeRuntimeStartResult,
} from "./runtime";

/**
 * Claude Code, driven inside an isolated remote sandbox.
 *
 * ## What this is, structurally
 *
 * A second implementation of the `ClaudeRuntime` seam, beside
 * `sdk-runtime.ts`. That is the whole of the change: there is no
 * `RemoteClaudeAdapter`, no second control service, no parallel event model
 * and no second approval broker. The `ClaudeCodeControlAdapter` above it does
 * not know which of the two it is holding, the `ControlService` above *that*
 * does not know either, and the UI at the top cannot tell — which is the
 * brief's requirement that an event must not reveal where it came from.
 *
 * ## The one thing that genuinely differs
 *
 * A local runtime is a child process of the thing listening to it. This one
 * is a process inside a microVM, and the thing listening to it is a
 * serverless function that will not exist in a second's time. So the provider
 * does not push; it appends to a log, and `drain()` replays that log through
 * the same `onMessage` and `onPermissionRequest` callbacks a local runtime
 * calls directly.
 *
 * Replay is from the beginning of the log, every time, and that is deliberate
 * rather than lazy — see the long note in `remote/types.ts`. The runtime
 * host's journal is in memory and starts empty on each request, so a stored
 * cursor would produce sequence numbers addressing events this process never
 * saw. Replaying the whole log rebuilds the same journal, and the journal's
 * own deduplication makes it free of side effects.
 *
 * ## How an approval survives a process that does not
 *
 * The agent blocks inside the sandbox while the request that saw its
 * permission request ends. The user answers minutes later, on an instance
 * that has never heard of it. That works because of two rules, and both are
 * load-bearing:
 *
 *   1. **The drain stops at an unresolved permission.** The pending request is
 *      re-read on every subsequent drain, so the adapter re-registers a
 *      resolver for it and `respondToApproval` finds one.
 *   2. **The approval id comes from the bridge, not from a counter.** Two
 *      reads of the same pending request produce the same approval id, so the
 *      broker sees a duplicate rather than a second prompt and the journal
 *      drops the repeated event.
 *
 * Neither rule involves storing an approval. The provider's own blocked state
 * *is* the durable record, which is the only version of this that cannot
 * drift out of sync with the agent.
 */

/** Hosts the sandbox is allowed to reach. Deny-by-default; this is the entire allowlist. */
const ALLOWED_EGRESS: readonly string[] = [
  "api.anthropic.com",
  // npm, for the bridge's single dependency. Without it the bridge cannot be
  // installed on a cold sandbox and nothing runs at all.
  "registry.npmjs.org",
] as const;

/**
 * The environment variable carrying the provider credential.
 *
 * Read from the deployment's own environment at the moment a bridge starts,
 * handed to the platform over TLS, and never written to a row, a prompt, an
 * event or a log. There is deliberately no per-user path here yet — see
 * docs/agent-remote-runtime.md on why delegating a person's Claude
 * subscription to a hosted service is not something this architecture can do
 * honestly, and what a bring-your-own-key seam would need.
 */
export const PROVIDER_CREDENTIAL_ENV_VAR = "ANTHROPIC_API_KEY";

export type RemoteClaudeRuntimeOptions = {
  sandbox: RemoteSandboxService;
  store: RemoteStore;
  /** Whose sandboxes this runtime may address. Every store read is scoped to it. */
  ownerId: string;
  /** The process environment. Injected so the credential read is testable without one. */
  env?: Readonly<Record<string, string | undefined>>;
  now?: () => number;
};

/** Whether this deployment holds a provider credential at all. */
export function hasProviderCredential(
  env: Readonly<Record<string, string | undefined>> = process.env
): boolean {
  const value = env[PROVIDER_CREDENTIAL_ENV_VAR];
  return typeof value === "string" && value.trim().length > 0;
}

export function createRemoteClaudeRuntime(
  options: RemoteClaudeRuntimeOptions
): ClaudeRuntime {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => Date.now());

  return {
    async isAvailable(): Promise<boolean> {
      // Both halves, and neither is inferred. A sandbox platform with no
      // provider credential can create microVMs that cannot run an agent, and
      // reporting that as available is how a user gets a session that dies on
      // its first message with an unexplained error.
      if (!hasProviderCredential(env)) return false;
      return options.sandbox.isAvailable();
    },

    async start(start: ClaudeRuntimeStartOptions): Promise<ClaudeRuntimeStartResult> {
      // A remote session without a project has nowhere to run. The local path
      // tolerates this — an agent with no project scope is a legitimate, if
      // limited, thing — but here the project *is* the sandbox.
      if (!start.projectId) return { ok: false, error: { code: "unavailable" } };
      if (!hasProviderCredential(env)) return { ok: false, error: { code: "authentication" } };

      // Owner-scoped. A project id belonging to somebody else resolves to
      // nothing here, exactly as if it did not exist — the store's `findProject`
      // folds the owner into the query rather than checking it afterwards.
      const project = await options.store.findProject(options.ownerId, start.projectId);
      if (!project) return { ok: false, error: { code: "unavailable" } };

      const ensured = await options.sandbox.ensure({
        sandboxName: project.sandboxName,
        timeoutMs: REMOTE_LIMITS.sandboxTimeoutMs,
        allowedHosts: ALLOWED_EGRESS,
        tags: { app: "tabdump", project: project.id },
      });
      if (!ensured.ok) return { ok: false, error: toRuntimeError(ensured.error.code) };

      // Re-read rather than trusting the row. The brief's "a stopped/expired
      // sandbox must not be reused accidentally" is precisely the failure that
      // happens when code acts on a status it fetched earlier, and `ensure`
      // returns the platform's own current answer.
      if (!isDispatchableStatus(ensured.value.status)) {
        return { ok: false, error: { code: "unavailable", detail: ensured.value.status } };
      }

      const config: BridgeConfig = {
        sessionId: start.sessionId,
        // Straight from the grant, exactly as the local path derives it. The
        // security suite diffs these with and without context attached to
        // prove that attaching context cannot move a single flag.
        permissionMode: start.permissionMode,
        allowedTools: [...start.allowedTools],
        disallowedTools: [...start.disallowedTools],
        ...(start.resume ? { resume: start.resume } : {}),
      };

      const wrote = await options.sandbox.writeBridgeConfig(project.sandboxName, config);
      if (!wrote.ok) return { ok: false, error: toRuntimeError(wrote.error.code) };

      const started = await options.sandbox.startBridge({
        sandboxName: project.sandboxName,
        // The credential's only crossing. Read here, used immediately,
        // referenced nowhere else.
        env: { [PROVIDER_CREDENTIAL_ENV_VAR]: env[PROVIDER_CREDENTIAL_ENV_VAR] ?? "" },
      });
      if (!started.ok) return { ok: false, error: toRuntimeError(started.error.code) };

      await options.store.createSession({
        id: start.sessionId,
        ownerId: options.ownerId,
        projectId: project.id,
        provider: "claude-code",
        sandboxName: project.sandboxName,
        commandId: started.value.commandId,
        createdAt: now(),
        updatedAt: now(),
      });

      await options.store.updateProject(
        options.ownerId,
        project.id,
        {
          status: "running",
          ...(ensured.value.expiresAt ? { expiresAt: ensured.value.expiresAt } : {}),
        },
        now()
      );

      return {
        ok: true,
        handle: createHandle({
          sandboxName: project.sandboxName,
          sandbox: options.sandbox,
          start,
        }),
      };
    },

    async reattach(start: ClaudeRuntimeStartOptions): Promise<ClaudeRuntimeHandle | null> {
      return reattachRemoteSession({
        sandbox: options.sandbox,
        store: options.store,
        ownerId: options.ownerId,
        sessionId: start.sessionId,
        start,
      });
    },
  };
}

/* ------------------------------------------------------------------ *
 * Reattaching
 * ------------------------------------------------------------------ */

export type ReattachInput = {
  sandbox: RemoteSandboxService;
  store: RemoteStore;
  ownerId: string;
  sessionId: string;
  start: ClaudeRuntimeStartOptions;
};

/**
 * Picks a live session back up on an instance that never started it.
 *
 * This is the serverless counterpart of "the process is still running": the
 * agent genuinely is still going inside its microVM, and what has been lost is
 * only this deployment's handle on it. Reattaching rebuilds the handle from
 * two durable facts — which sandbox, and which process inside it — and starts
 * nothing.
 *
 * Returns nothing when the session is not this caller's, when the sandbox is
 * gone, or when the bridge has exited. Each of those is a session that cannot
 * be driven, and the honest answer is to say so rather than to quietly start a
 * second agent over the top of the first.
 */
export async function reattachRemoteSession(
  input: ReattachInput
): Promise<ClaudeRuntimeHandle | null> {
  const session = await input.store.findSession(input.ownerId, input.sessionId);
  if (!session) return null;

  const state = await input.sandbox.state(session.sandboxName);
  if (!state.ok || !isDispatchableStatus(state.value.status)) return null;

  // A bridge that has exited leaves a log worth reading but nothing worth
  // sending to. The handle still drains — the conversation's history is real
  // and the user should see it — and refuses to send, which is what
  // `isActive: false` means to the adapter.
  const running = session.commandId
    ? await input.sandbox.isBridgeRunning(session.sandboxName, session.commandId)
    : false;

  return createHandle({
    sandboxName: session.sandboxName,
    sandbox: input.sandbox,
    start: input.start,
    active: running,
  });
}

/* ------------------------------------------------------------------ *
 * The handle
 * ------------------------------------------------------------------ */

type HandleInput = {
  sandboxName: string;
  sandbox: RemoteSandboxService;
  start: ClaudeRuntimeStartOptions;
  active?: boolean;
};

function createHandle(input: HandleInput): ClaudeRuntimeHandle {
  let active = input.active ?? true;
  let exited = false;

  /**
   * Approvals this handle has already reported during this request.
   *
   * Scoped to the handle rather than to the process, because a handle is one
   * request's view of one session. Its job is only to stop a single drain
   * reporting the same pending request twice when the log is replayed.
   */
  const reported = new Set<string>();

  return {
    async send(text: string): Promise<void> {
      if (!active) throw new Error("session is not active");
      const written = await input.sandbox.writeInbox(input.sandboxName, "message", {
        kind: "message",
        text,
      });
      if (!written.ok) throw new Error("could not reach the session");
    },

    async interrupt(): Promise<void> {
      if (!active) return;
      // Reaches the provider: the bridge polls for this and calls the SDK's
      // own interrupt. A local flag that merely stopped TabDump listening
      // would leave the agent running and still editing files, which is the
      // failure this method exists to prevent — and it would do so inside a
      // machine the user cannot see.
      await input.sandbox.writeInbox(input.sandboxName, "interrupt", { kind: "interrupt" });
    },

    async dispose(): Promise<void> {
      if (exited) return;
      exited = true;
      active = false;
      // Ends the conversation without destroying the sandbox. The project's
      // files, and the dependencies installed into it, are the point of a
      // remote project and must outlive one session.
      await input.sandbox.writeInbox(input.sandboxName, "close", { kind: "close" });
    },

    isActive: () => active,

    async drain(): Promise<void> {
      const drained = await input.sandbox.drain(input.sandboxName, 0);
      if (!drained.ok) return;

      const lines = drained.value.lines
        .map(parseBridgeLine)
        .filter((line): line is BridgeLine => line !== null);

      // Which permissions were settled *within this batch*. A request whose
      // resolution is in the log is history; one whose resolution is not is
      // the agent blocked right now, and the drain stops at it.
      const resolved = new Set(
        lines.filter((line) => line.t === "permission_resolved").map((line) => line.id)
      );

      for (const line of lines) {
        switch (line.t) {
          case "ready":
            break;

          case "message":
            input.start.onMessage(line.payload);
            break;

          case "permission": {
            if (resolved.has(line.id)) {
              // Already answered. Reporting it again would re-open a decision
              // the user has made; the tool call it authorized shows up in the
              // message stream on its own.
              break;
            }
            if (reported.has(line.id)) break;
            reported.add(line.id);
            reportPermission(input, line);
            break;
          }

          case "permission_resolved":
            break;

          case "exit":
            active = false;
            if (!exited) {
              exited = true;
              input.start.onExit(line.error ? toRuntimeError(line.error.code, line.error.detail) : undefined);
            }
            break;
        }
      }
    },
  };
}

/**
 * Turns one pending permission line into the request the adapter expects.
 *
 * The resulting promise is *not* awaited, and that is the design rather than a
 * missing `await`. The adapter resolves it when the user answers, which may be
 * on a different instance entirely; what this call does here and now is cause
 * an `approval_requested` event to be emitted so the user sees the prompt. The
 * `.then` below is the path that matters when the answer *does* arrive in this
 * same request — the common case, because the host drains immediately before
 * handling `respond_to_approval`.
 */
function reportPermission(
  input: HandleInput,
  line: Extract<BridgeLine, { t: "permission" }>
): void {
  const request: ClaudePermissionRequest = {
    // The bridge's own id. Stable across replays, which is what makes the
    // approval answerable from an instance that never saw it raised.
    stableId: line.id,
    toolName: line.toolName,
    toolUseId: typeof line.toolUseId === "string" ? line.toolUseId : "",
    requestId: typeof line.requestId === "string" ? line.requestId : "",
    ...(typeof line.title === "string" ? { title: line.title } : {}),
    ...(typeof line.displayName === "string" ? { displayName: line.displayName } : {}),
    ...(typeof line.description === "string" ? { description: line.description } : {}),
    ...(typeof line.decisionReason === "string" ? { decisionReason: line.decisionReason } : {}),
    ...(typeof line.blockedPath === "string" ? { blockedPath: line.blockedPath } : {}),
    input:
      line.input && typeof line.input === "object"
        ? (line.input as Record<string, unknown>)
        : {},
    // Nothing aborts a remote permission from this side. The bridge has its own
    // deadline and denies on it, which is the fail-closed direction and the one
    // that survives this process disappearing.
    signal: new AbortController().signal,
  };

  void input.start
    .onPermissionRequest(request)
    .then((decision) =>
      input.sandbox.writeInbox(input.sandboxName, `approval-${line.id}`, {
        kind: "approval",
        id: line.id,
        decision: decision.behavior === "allow" ? "granted" : "denied",
      })
    )
    .catch(() => undefined);
}

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

/**
 * Maps a sandbox or bridge failure onto the runtime's fixed table.
 *
 * Takes a code and an optional detail, and never the caught value — the same
 * discipline the local runtime's `classify` follows. A cloud platform and a
 * provider both get to fail; neither gets to choose what a user reads.
 */
function toRuntimeError(code: string, detail?: string): ClaudeRuntimeError {
  const mapped: ClaudeRuntimeError["code"] =
    code === "authentication"
      ? "authentication"
      : code === "not-installed"
        ? "not-installed"
        : code === "timeout"
          ? "timeout"
          : code === "unavailable" || code === "not-found" || code === "not-dispatchable"
            ? "unavailable"
            : code === "cancelled"
              ? "unknown"
              : "process-failed";

  return detail === undefined ? { code: mapped } : { code: mapped, detail };
}
