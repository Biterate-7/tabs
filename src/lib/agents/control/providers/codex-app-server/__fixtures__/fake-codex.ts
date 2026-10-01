import type { AcpCloseReason, AcpTransport } from "../../acp/rpc";
import type { AppServerLaunchFailure, AppServerLaunchRequest, AppServerLauncher } from "../launcher";

/**
 * A scripted `codex app-server` on an in-memory transport.
 *
 * It speaks the wire exactly — newline-delimited JSON-RPC — with the shapes
 * verified against Codex 0.159.0, so the peer, the protocol readers and the
 * adapter are exercised as they would be against the real server. Tests
 * script it per method; a handler can push notifications and make
 * server-to-client requests (approvals, elicitations) before answering.
 */

type Message = Record<string, unknown>;

export type FakeCodexContext = {
  notify(method: string, params: unknown): void;
  /** Makes a server-to-client request; resolves with the client's reply. */
  ask(method: string, params: unknown): Promise<{ result?: unknown; error?: unknown }>;
};

export type FakeCodexHandler = (params: Record<string, unknown>, context: FakeCodexContext) => unknown | Promise<unknown>;

export class CodexError extends Error {
  constructor(readonly code: number) {
    super(`codex error ${code}`);
  }
}

export const THREAD_ID = "thread-1";
export const TURN_ID = "turn-1";

/** `thread/start` as Codex 0.159.0 answers the settings Hubble sends. */
export function askingThread(threadId = THREAD_ID) {
  return {
    thread: { id: threadId },
    model: "gpt-5-codex",
    modelProvider: "openai",
    cwd: "C:/work/research",
    approvalPolicy: "untrusted",
    approvalsReviewer: "user",
    sandbox: { type: "readOnly", networkAccess: false },
    reasoningEffort: null,
  };
}

export const DEFAULT_HANDLERS: Record<string, FakeCodexHandler> = {
  initialize: () => ({
    userAgent: "hubble/0.159.0 (Windows 10.0.26200; x86_64) (hubble; 1.0.0)",
    codexHome: "C:/Users/me/AppData/Local/Hubble/codex",
    platformFamily: "windows",
    platformOs: "windows",
  }),
  "account/read": () => ({ account: { type: "chatgpt", email: "me@example.com", planType: "plus" }, requiresOpenaiAuth: true }),
  "thread/start": () => askingThread(),
  "turn/start": () => ({ turn: { id: TURN_ID, items: [], status: "inProgress", error: null } }),
  "turn/interrupt": () => ({}),
};

export type FakeCodex = {
  received: Message[];
  launches: AppServerLaunchRequest[];
  launcher: AppServerLauncher;
  /** The current connection's context, once one is open. */
  context(): FakeCodexContext;
  crash(): void;
  released: number;
  closed: number;
};

export function createFakeCodex(
  handlers: Record<string, FakeCodexHandler> = {},
  options: { fail?: AppServerLaunchFailure } = {}
): FakeCodex {
  const received: Message[] = [];
  const launches: AppServerLaunchRequest[] = [];
  let current: { context: FakeCodexContext; crash: () => void } | undefined;
  const all = { ...DEFAULT_HANDLERS, ...handlers };

  const codex: FakeCodex = {
    received,
    launches,
    released: 0,
    closed: 0,
    context: () => {
      if (!current) throw new Error("no connection");
      return current.context;
    },
    crash: () => current?.crash(),
    launcher: async (request) => {
      launches.push(request);
      if (options.fail) return { ok: false, reason: options.fail };

      const lineListeners = new Set<(line: string) => void>();
      const closeListeners = new Set<(reason: AcpCloseReason) => void>();
      let open = true;
      let nextServerId = 0;
      const waiting = new Map<number, (message: Message) => void>();

      function toClient(message: Message): void {
        if (!open) return;
        // Codex's own lines carry no "jsonrpc" member; the reader must not need one.
        const line = JSON.stringify(message);
        queueMicrotask(() => {
          if (open) for (const listener of [...lineListeners]) listener(line);
        });
      }

      function close(reason: AcpCloseReason): void {
        if (!open) return;
        open = false;
        for (const listener of [...closeListeners]) listener(reason);
      }

      const context: FakeCodexContext = {
        notify(method, params) {
          toClient({ method, params });
        },
        ask(method, params) {
          const id = nextServerId++;
          return new Promise((resolve) => {
            waiting.set(id, (message) => resolve({ result: message.result, error: message.error }));
            toClient({ id, method, params });
          });
        },
      };
      current = { context, crash: () => close("exited") };

      async function handle(message: Message): Promise<void> {
        const method = message.method as string;
        const handler = all[method];
        if (!handler) {
          if (message.id !== undefined) toClient({ id: message.id, error: { code: -32601, message: "nope" } });
          return;
        }
        try {
          const result = await handler((message.params ?? {}) as Record<string, unknown>, context);
          if (message.id !== undefined) toClient({ id: message.id, result: result ?? null });
        } catch (error) {
          const code = error instanceof CodexError ? error.code : -32603;
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
        close: () => {
          if (open) codex.closed += 1;
          close("closed");
        },
      };

      return {
        ok: true,
        transport,
        cwd: request.projectPath ?? "C:/scratch/tabdump-agent-1",
        release: () => {
          codex.released += 1;
        },
      };
    },
  };
  return codex;
}

/** Lets queued microtasks and resolved promises settle. */
export async function flush(times = 10): Promise<void> {
  for (let i = 0; i < times; i++) await new Promise((resolve) => setTimeout(resolve, 0));
}

/* Notification builders, in Codex 0.159.0's shapes. */

export function commandItem(id: string, status: string, extra: Record<string, unknown> = {}) {
  return {
    type: "commandExecution",
    id,
    pluginId: null,
    scriptPath: null,
    command: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content notes.txt'",
    cwd: "C:\\work\\research",
    processId: null,
    source: "agent",
    status,
    commandActions: [],
    aggregatedOutput: null,
    exitCode: null,
    durationMs: null,
    ...extra,
  };
}

export function itemNote(method: "item/started" | "item/completed", item: Record<string, unknown>, threadId = THREAD_ID) {
  return [method, { item, threadId, turnId: TURN_ID, startedAtMs: 1, completedAtMs: 2 }] as const;
}

export function commandApproval(itemId: string, extra: Record<string, unknown> = {}) {
  return {
    kind: "command",
    threadId: THREAD_ID,
    turnId: TURN_ID,
    itemId,
    startedAtMs: 1,
    environmentId: "local",
    command: "\"C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe\" -Command 'Get-Content notes.txt'",
    cwd: "C:\\work\\research",
    commandActions: [{ type: "read", command: "Get-Content notes.txt", name: "notes.txt", path: "C:\\work\\research\\notes.txt" }],
    proposedExecpolicyAmendment: ["Get-Content", "notes.txt"],
    availableDecisions: ["accept", { acceptWithExecpolicyAmendment: { execpolicy_amendment: ["Get-Content"] } }, "cancel"],
    ...extra,
  };
}

export function turnCompleted(status: "completed" | "interrupted" | "failed", error: unknown = null, threadId = THREAD_ID) {
  return { threadId, turn: { id: TURN_ID, items: [], status, error } };
}
