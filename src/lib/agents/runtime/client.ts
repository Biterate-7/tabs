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

export type RuntimeClientOptions = {
  endpoint?: string;
  /** Injected so tests need no network and no global. */
  fetch?: typeof fetch;
};

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

  async function post(request: RuntimeRequest): Promise<unknown> {
    const response = await transport(endpoint, {
      method: "POST",
      headers: { "content-type": "application/json" },
      // Same-origin only, and credentials travel so a deployment with
      // accounts can identify the actor. Nothing else is sent: no token, no
      // path, no environment.
      credentials: "same-origin",
      body: JSON.stringify(request),
    });

    return response.json();
  }

  async function send<N extends RuntimeCommandName>(
    command: Extract<RuntimeCommand, { name: N }>
  ): Promise<RuntimeCommandResult<N>> {
    const request: RuntimeRequest =
      runtimeId && !isHandshakeCommand(command.name) ? { runtimeId, command } : { command };

    let body: unknown;
    try {
      body = await post(request);
    } catch {
      // The thrown value is deliberately not read. A network error's message
      // can carry a URL, and a URL can carry a host and a port.
      return runtimeFailure<never>("runtime_disconnected") as RuntimeCommandResult<N>;
    }

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
