/**
 * JSON-RPC 2.0 over newline-delimited lines — the wire the Agent Client
 * Protocol (ACP) runs on.
 *
 * ## Why this module knows nothing about processes
 *
 * The control plane is pure and its guard suite forbids any process, shell or
 * filesystem module inside it. So the peer speaks to an `AcpTransport` — three
 * functions and a close — and the thing that actually owns a child process
 * lives in `lib/agents/launch/`, server-only, behind its own guards. Tests
 * drive this peer with an in-memory transport and a scripted agent; nothing
 * here can tell the difference.
 *
 * ## Bounded in every direction
 *
 * A line longer than `MAX_ACP_LINE_LENGTH` is dropped rather than parsed, a
 * request that is never answered is failed after its timeout, and a closed
 * transport fails every outstanding request at once. None of those paths
 * surfaces the peer's own text: a failure is a code.
 */

/** One agent message is a line. Anything larger is not a message Hubble reads. */
export const MAX_ACP_LINE_LENGTH = 1_000_000;

/** How long a request may wait by default. A prompt turn overrides this — see the adapter. */
export const DEFAULT_ACP_REQUEST_TIMEOUT_MS = 60_000;

export type AcpCloseReason = "exited" | "error" | "closed";

/**
 * The byte pipe the peer runs over.
 *
 * `send` writes exactly one line (the peer adds no framing beyond the
 * newline); `onLine` delivers complete lines, already split. The transport
 * owns buffering, so the peer never sees a half message.
 */
export type AcpTransport = {
  send(line: string): void;
  onLine(listener: (line: string) => void): () => void;
  onClose(listener: (reason: AcpCloseReason) => void): () => void;
  close(): void;
};

export type RpcErrorKind =
  /** The agent answered with a JSON-RPC error. `code` is the agent's code. */
  | "remote"
  /** No answer arrived in time. */
  | "timeout"
  /** The transport closed with the request outstanding. */
  | "closed";

export type RpcFailure = { ok: false; kind: RpcErrorKind; code?: number };
export type RpcResult = { ok: true; value: unknown } | RpcFailure;

/** What the peer answers an agent-initiated request with. */
export type RpcReply = { result: unknown } | { error: { code: number; message: string } };

/** JSON-RPC's own code for a method the receiver does not implement. */
export const METHOD_NOT_FOUND = -32601;

export type JsonRpcPeerOptions = {
  transport: AcpTransport;
  /**
   * An agent-initiated request. Anything not answered by this handler is
   * refused as method-not-found — which is how Hubble declines `fs/*` and
   * `terminal/*` requests it never advertised support for.
   */
  onRequest: (method: string, params: unknown) => Promise<RpcReply> | RpcReply;
  onNotification: (method: string, params: unknown) => void;
  onClose?: (reason: AcpCloseReason) => void;
  /** Injected so tests do not wait on a real clock. */
  setTimer?: (callback: () => void, ms: number) => unknown;
  clearTimer?: (handle: unknown) => void;
};

export type JsonRpcPeer = {
  request(method: string, params: unknown, options?: { timeoutMs?: number }): Promise<RpcResult>;
  notify(method: string, params: unknown): void;
  /** Whether the transport is still open. */
  isOpen(): boolean;
  close(): void;
};

type Pending = { resolve: (result: RpcResult) => void; timer: unknown };

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

export function createJsonRpcPeer(options: JsonRpcPeerOptions): JsonRpcPeer {
  const { transport } = options;
  const setTimer = options.setTimer ?? ((callback, ms) => setTimeout(callback, ms));
  const clearTimer = options.clearTimer ?? ((handle) => clearTimeout(handle as ReturnType<typeof setTimeout>));

  const pending = new Map<number, Pending>();
  let nextId = 1;
  let open = true;

  function write(message: Record<string, unknown>): void {
    if (!open) return;
    transport.send(JSON.stringify({ jsonrpc: "2.0", ...message }));
  }

  function settle(id: number, result: RpcResult): void {
    const entry = pending.get(id);
    if (!entry) return;
    pending.delete(id);
    clearTimer(entry.timer);
    entry.resolve(result);
  }

  async function answer(id: unknown, method: string, params: unknown): Promise<void> {
    let reply: RpcReply;
    try {
      reply = await options.onRequest(method, params);
    } catch {
      // A handler that threw is an internal error, reported as a code. The
      // exception's own text never goes back over the wire.
      reply = { error: { code: -32603, message: "Internal error" } };
    }
    write({ id, ...reply });
  }

  function onLine(line: string): void {
    if (line.length > MAX_ACP_LINE_LENGTH) return;
    const trimmed = line.trim();
    if (!trimmed) return;

    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      // An agent may write a log line to stdout. It is not a message.
      return;
    }

    const message = asRecord(parsed);
    if (!message) return;

    const method = typeof message.method === "string" ? message.method : undefined;
    const hasId = typeof message.id === "number" || typeof message.id === "string";

    if (method && hasId) {
      void answer(message.id, method, message.params);
      return;
    }

    if (method) {
      options.onNotification(method, message.params);
      return;
    }

    if (typeof message.id !== "number") return;
    const error = asRecord(message.error);
    if (error) {
      settle(message.id, {
        ok: false,
        kind: "remote",
        ...(typeof error.code === "number" ? { code: error.code } : {}),
      });
      return;
    }
    settle(message.id, { ok: true, value: message.result });
  }

  function onClosed(reason: AcpCloseReason): void {
    if (!open) return;
    open = false;
    for (const id of [...pending.keys()]) settle(id, { ok: false, kind: "closed" });
    detachLine();
    detachClose();
    options.onClose?.(reason);
  }

  const detachLine = transport.onLine(onLine);
  const detachClose = transport.onClose(onClosed);

  return {
    request(method, params, requestOptions = {}) {
      if (!open) return Promise.resolve({ ok: false, kind: "closed" });
      const id = nextId++;
      const timeoutMs = requestOptions.timeoutMs ?? DEFAULT_ACP_REQUEST_TIMEOUT_MS;

      return new Promise<RpcResult>((resolve) => {
        const timer = setTimer(() => settle(id, { ok: false, kind: "timeout" }), timeoutMs);
        pending.set(id, { resolve, timer });
        write({ id, method, params });
      });
    },

    notify(method, params) {
      write({ method, params });
    },

    isOpen: () => open,

    close() {
      if (!open) return;
      transport.close();
      onClosed("closed");
    },
  };
}
