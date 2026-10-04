import { isHandshakeCommand, runtimeFailure } from "./protocol";
import type {
  RuntimeCommand,
  RuntimeCommandName,
  RuntimeCommandResult,
  RuntimeRequest,
  RuntimeStatus,
} from "./protocol";

/**
 * The browser's handle on the local runtime.
 *
 * ## What this is, and what it is not
 *
 * It is a typed `fetch` wrapper around one endpoint, and that is the whole
 * ambition. It holds no adapter, no provider, no credential and no session
 * state beyond the runtime's identity; it makes no decisions; and everything
 * it can express is a value in `RuntimeCommand`.
 *
 * It is *not* the control plane. Nothing here authorizes anything — the host
 * on the other side re-derives the actor from the request, re-resolves the
 * project from its own store, and re-checks every gate. A client that lied
 * about any of it would be lying to something that does not consult it.
 *
 * ## The handshake
 *
 * The first call is `get_status`, which returns the host's `runtimeId`. Every
 * subsequent command carries it back, and the host refuses one that does not
 * match. That is a **generation check, not authentication**: the id is not
 * secret, it travels in a response, and it proves nothing about who is
 * calling. What it does prove is that the client and the host are the same
 * generation — so a browser tab left open across a server restart is told
 * `runtime_disconnected` and reattaches, rather than silently addressing
 * sessions that no longer exist.
 *
 * Authentication, where a deployment has it, is the session cookie the
 * transport already carries; ownership is the host's business. See
 * ./host.ts.
 *
 * ## Why there is no cache
 *
 * A status this client remembered could be wrong the moment after it was
 * taken — a provider can fail, a session can end, an approval can expire.
 * The future command centre polls or subscribes; it does not read a stale
 * copy out of here.
 */

export const RUNTIME_ENDPOINT = "/api/agents/control";

/**
 * How long each command may take before the client gives up and answers
 * `timeout` (Agent Authentication & Runtime).
 *
 * Every command is bounded, so no button and no status can wait forever on a
 * request that will never come back — the other half of the "stuck on
 * Connecting" fix (the host half is `settleConnects`). Each bound sits above
 * the server's own bound for the same work, so a slow-but-finishing answer is
 * not cut off early:
 *
 *   - `connect_provider` starts an agent to ask whether it is signed in (ACP:
 *     launch + two 30 s handshakes; Claude: a 20 s status check).
 *   - `authenticate_provider` waits on a person signing in in a browser — the
 *     agents' own sign-in waits are 10 minutes.
 *   - `create_session` launches an agent and settles its mode.
 *
 * A reply that arrives after its deadline is dropped. The host still
 * finished the work, and the next status read shows it.
 */
export const COMMAND_TIMEOUT_MS: Readonly<Record<RuntimeCommandName, number>> = {
  get_status: 20_000,
  list_sessions: 20_000,
  get_session: 20_000,
  get_events: 20_000,
  authorize_projects: 20_000,
  create_session: 120_000,
  resume_session: 120_000,
  send_message: 60_000,
  cancel_run: 30_000,
  attach_context: 20_000,
  detach_context: 20_000,
  respond_to_approval: 30_000,
  dispose_session: 30_000,
  link_observation: 20_000,
  detect_providers: 30_000,
  connect_provider: 120_000,
  authenticate_provider: 11 * 60_000,
  disconnect_provider: 30_000,
  sync_session_context: 20_000,
  complete_context_action: 20_000,
  list_history: 20_000,
  get_history: 20_000,
  record_workspace_change: 20_000,
  record_workspace_undo: 20_000,
  prepare_handoff: 20_000,
  // Starts the target agent's session (create_session's bound) and delivers the handoff.
  start_handoff: 150_000,
};

export type RuntimeClientOptions = {
  endpoint?: string;
  /** Injected so tests need no network and no global. */
  fetch?: typeof fetch;
  /**
   * Delivers a request by some other means than HTTP, and returns the parsed
   * reply (Phase J.1).
   *
   * The desktop app has no HTTP route: its runtime is a sidecar the Tauri
   * shell relays to. Everything above the transport — the handshake, the
   * runtime-id generation check, the reply validation — is unchanged, so the
   * UI cannot tell which shell it is in.
   */
  post?: (request: RuntimeRequest) => Promise<unknown>;
  /** Overrides `COMMAND_TIMEOUT_MS`, per command. For tests. */
  timeouts?: Partial<Record<RuntimeCommandName, number>>;
};

/** What `post` resolves to when the deadline passed first. Never a value the host can send. */
const TIMED_OUT = Symbol("timed-out");

export type RuntimeClient = {
  /** The host identity this client is currently addressing, once it has one. */
  runtimeId(): string | undefined;

  /**
   * Sends one command.
   *
   * A transport failure — offline, a non-JSON response, a route that is not
   * there because this is a static desktop build — becomes
   * `runtime_disconnected` rather than a thrown error, so a caller has one
   * shape to handle and never an exception from a background poll.
   */
  send<N extends RuntimeCommandName>(
    command: Extract<RuntimeCommand, { name: N }>
  ): Promise<RuntimeCommandResult<N>>;

  /** The handshake. Records the host's identity for subsequent commands. */
  status(): Promise<RuntimeCommandResult<"get_status">>;

  /** Forgets the current host identity, so the next command re-handshakes. */
  reset(): void;
};

export function createRuntimeClient(options: RuntimeClientOptions = {}): RuntimeClient {
  const endpoint = options.endpoint ?? RUNTIME_ENDPOINT;
  const transport = options.fetch ?? ((...args: Parameters<typeof fetch>) => fetch(...args));

  let runtimeId: string | undefined;

  async function post(request: RuntimeRequest, signal: AbortSignal): Promise<unknown> {
    if (options.post) return options.post(request);
    const response = await transport(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Same-origin only, and credentials travel so a deployment with
      // accounts can identify the actor. Nothing else is sent: no token, no
      // path, no environment.
      credentials: "same-origin",
      body: JSON.stringify(request),
      signal,
    });

    return response.json();
  }

  /** `post`, bounded by the command's deadline. Resolves `TIMED_OUT` rather than hanging. */
  async function postWithin(request: RuntimeRequest, ms: number): Promise<unknown> {
    const abort = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<typeof TIMED_OUT>((resolve) => {
      timer = setTimeout(() => {
        abort.abort();
        resolve(TIMED_OUT);
      }, ms);
    });
    try {
      return await Promise.race([post(request, abort.signal), deadline]);
    } finally {
      if (timer !== undefined) clearTimeout(timer);
    }
  }

  async function send<N extends RuntimeCommandName>(
    command: Extract<RuntimeCommand, { name: N }>
  ): Promise<RuntimeCommandResult<N>> {
    const request: RuntimeRequest =
      runtimeId && !isHandshakeCommand(command.name) ? { runtimeId, command } : { command };

    let body: unknown;
    try {
      body = await postWithin(request, options.timeouts?.[command.name] ?? COMMAND_TIMEOUT_MS[command.name]);
    } catch {
      // The thrown value is deliberately not read. A network error's message
      // can carry a URL, and a URL can carry a host and a port.
      return runtimeFailure<never>("runtime_disconnected") as RuntimeCommandResult<N>;
    }

    if (body === TIMED_OUT) return runtimeFailure<never>("timeout") as RuntimeCommandResult<N>;

    if (!body || typeof body !== "object" || !("ok" in body)) {
      return runtimeFailure<never>("runtime_disconnected") as RuntimeCommandResult<N>;
    }

    const result = body as RuntimeCommandResult<N>;

    if (result.ok && command.name === "get_status") {
      runtimeId = (result.value as RuntimeStatus).runtimeId;
    }

    // A host that has restarted answers this and nothing else. Forgetting the
    // id here is what makes the next call re-handshake without the caller
    // having to know the rule.
    if (!result.ok && result.error.code === "runtime_disconnected") runtimeId = undefined;

    return result;
  }

  return {
    runtimeId: () => runtimeId,
    send,
    status: () => send({ name: "get_status" }),
    reset: () => {
      runtimeId = undefined;
    },
  };
}
