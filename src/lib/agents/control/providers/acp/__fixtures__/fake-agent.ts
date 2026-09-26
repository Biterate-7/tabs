import type { AcpLaunchRequest, AcpLauncher } from "../launcher";
import type { AcpCloseReason, AcpTransport } from "../rpc";

/**
 * A scripted ACP agent on an in-memory transport.
 *
 * It speaks the wire exactly — newline-delimited JSON-RPC 2.0 — so the peer,
 * the protocol readers and the adapter are exercised as they would be against
 * a real agent's stdio, with no process involved. Tests script it per method:
 * a handler receives the params and a `session` helper that can push
 * `session/update` notifications and make agent-initiated requests (for
 * `session/request_permission`) before answering.
 */

type Message = Record<string, unknown>;

export type FakeAgentContext = {
  /** Sends a `session/update` notification. */
  update(sessionId: string, update: Record<string, unknown>): void;
  /** Makes an agent-to-client request and resolves with the client's result (or error). */
  ask(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }>;
};

export type FakeAgentHandler = (
  params: Record<string, unknown>,
  context: FakeAgentContext
) => unknown | Promise<unknown>;

/** Thrown from a handler to answer with a JSON-RPC error. */
export class AgentError extends Error {
  constructor(readonly code: number) {
    super(`agent error ${code}`);
  }
}

export type FakeAgent = {
  /** Every message the client sent, parsed, in order. */
  received: Message[];
  launches: AcpLaunchRequest[];
  /** The launcher an adapter is built with. */
  launcher: AcpLauncher;
  /** Closes the current connection from the agent's side, as a crash would. */
  crash(): void;
  released: number;
};

export function defaultInitialize(): unknown {
  return {
    protocolVersion: 1,
    agentCapabilities: { loadSession: false, mcpCapabilities: { http: true } },
    authMethods: [
      { id: "oauth-personal", name: "Sign in with Google", description: "Opens your browser" },
    ],
  };
}

export function createFakeAgent(
  handlers: Record<string, FakeAgentHandler>,
  options: { installed?: boolean } = {}
): FakeAgent {
  const received: Message[] = [];
  const launches: AcpLaunchRequest[] = [];
  let crashCurrent: (() => void) | undefined;

  const agent: FakeAgent = {
    received,
    launches,
    released: 0,
    crash: () => crashCurrent?.(),
    launcher: async (request) => {
      launches.push(request);
      if (options.installed === false) return { ok: false, reason: "not-installed" };

      const lineListeners = new Set<(line: string) => void>();
      const closeListeners = new Set<(reason: AcpCloseReason) => void>();
      let open = true;
      let nextAgentId = 1000;
      const waiting = new Map<number, (message: Message) => void>();

      function toClient(message: Message): void {
        if (!open) return;
        const line = JSON.stringify({ jsonrpc: "2.0", ...message });
        // Asynchronous, as a real pipe is.
        queueMicrotask(() => {
          if (open) for (const listener of [...lineListeners]) listener(line);
        });
      }

      function close(reason: AcpCloseReason): void {
        if (!open) return;
        open = false;
        for (const listener of [...closeListeners]) listener(reason);
      }
      crashCurrent = () => close("exited");

      const context: FakeAgentContext = {
        update(sessionId, update) {
          toClient({ method: "session/update", params: { sessionId, update } });
        },
        ask(method, params) {
          const id = nextAgentId++;
          return new Promise((resolve) => {
            waiting.set(id, (message) => resolve({ result: message.result, error: message.error }));
            toClient({ id, method, params });
          });
        },
      };

      async function handle(message: Message): Promise<void> {
        const method = message.method as string;
        const handler = handlers[method] ?? (method === "initialize" ? () => defaultInitialize() : undefined);
        if (!handler) {
          if (message.id !== undefined) toClient({ id: message.id, error: { code: -32601, message: "nope" } });
          return;
        }
        try {
          const result = await handler((message.params ?? {}) as Record<string, unknown>, context);
          if (message.id !== undefined) toClient({ id: message.id, result: result ?? null });
        } catch (error) {
          const code = error instanceof AgentError ? error.code : -32603;
          if (message.id !== undefined) toClient({ id: message.id, error: { code, message: "failed" } });
        }
      }

      const transport: AcpTransport = {
        send(line) {
          if (!open) return;
          const message = JSON.parse(line) as Message;
          received.push(message);
          if (typeof message.method === "string") {
            void handle(message);
          } else if (typeof message.id === "number") {
            waiting.get(message.id)?.(message);
            waiting.delete(message.id);
          }
        },
        onLine(listener) {
          lineListeners.add(listener);
          return () => lineListeners.delete(listener);
        },
        onClose(listener) {
          closeListeners.add(listener);
          return () => closeListeners.delete(listener);
        },
        close: () => close("closed"),
      };

      return {
        ok: true,
        transport,
        cwd: request.projectPath ?? "C:/scratch/tabdump-agent-1",
        release: () => {
          agent.released += 1;
        },
      };
    },
  };

  return agent;
}

/** Lets queued microtasks and resolved promises settle. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}
