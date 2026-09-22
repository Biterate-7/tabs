import { sandboxFailure } from "../sandbox";
import { REMOTE_LIMITS } from "../types";
import type {
  EnsureSandboxInput,
  RemoteSandboxService,
  SandboxDrain,
  SandboxErrorCode,
  SandboxFile,
  SandboxResult,
  SandboxState,
  StartBridgeInput,
} from "../sandbox";
import type { RemoteSandboxStatus } from "../types";

/**
 * A deterministic stand-in for the sandbox platform.
 *
 * ## Why this is a real implementation rather than a mock
 *
 * It implements `RemoteSandboxService` — the same contract
 * `sandbox-vercel.ts` implements — so the lifecycle the tests exercise is the
 * lifecycle the production path has, and a change to the seam breaks both at
 * once. A `vi.mock` of `@vercel/sandbox` would instead test our idea of
 * somebody else's module, and would keep passing after the seam moved.
 *
 * It also records everything it was asked to do, which is what lets the
 * security suite assert the *absence* of things: that no caller-supplied
 * string ever reached a command, that no path escaped the workspace root, and
 * that the credential went only where it was supposed to.
 */

export type SandboxCall =
  | { kind: "ensure"; input: EnsureSandboxInput }
  | { kind: "state"; sandboxName: string }
  | { kind: "writeWorkspace"; sandboxName: string; paths: string[] }
  | { kind: "writeBridgeConfig"; sandboxName: string; config: unknown }
  | { kind: "startBridge"; input: StartBridgeInput }
  | { kind: "writeInbox"; sandboxName: string; name: string; payload: unknown }
  | { kind: "drain"; sandboxName: string; cursor: number }
  | { kind: "extend"; sandboxName: string; byMs: number }
  | { kind: "stop"; sandboxName: string }
  | { kind: "destroy"; sandboxName: string };

type Box = {
  status: RemoteSandboxStatus;
  expiresAt?: number;
  files: Map<string, Uint8Array>;
  /** Lines the fake bridge has "written". Tests append to this to drive a run. */
  log: string[];
  bridgeRunning: boolean;
  commandId?: string;
  config?: unknown;
  allowedHosts: readonly string[];
  env?: Readonly<Record<string, string>>;
};

export type FakeSandboxService = RemoteSandboxService & {
  readonly calls: SandboxCall[];
  /** Every inbox item written, in order. The control plane's outbound channel. */
  readonly inbox: { sandboxName: string; payload: unknown }[];
  /** Appends a line to a sandbox's event log, as the bridge would. */
  emit(sandboxName: string, line: unknown): void;
  /** The sandbox's current state, for assertions. */
  peek(sandboxName: string): Box | undefined;
  /** Makes the next call of this kind fail. One shot. */
  failNext(kind: SandboxCall["kind"], code: SandboxErrorCode): void;
  /** Marks the bridge process as exited. */
  killBridge(sandboxName: string): void;
  setAvailable(available: boolean): void;
};

export function createFakeSandboxService(): FakeSandboxService {
  const boxes = new Map<string, Box>();
  const calls: SandboxCall[] = [];
  const inbox: { sandboxName: string; payload: unknown }[] = [];
  const failures = new Map<SandboxCall["kind"], SandboxErrorCode>();
  let available = true;
  let commandCounter = 0;

  /** Consumes a queued failure for this operation, if one was armed. */
  function armed(kind: SandboxCall["kind"]): SandboxErrorCode | undefined {
    const code = failures.get(kind);
    if (code) failures.delete(kind);
    return code;
  }

  function box(sandboxName: string): Box | undefined {
    return boxes.get(sandboxName);
  }

  return {
    calls,
    inbox,

    emit(sandboxName, line) {
      box(sandboxName)?.log.push(JSON.stringify(line));
    },

    peek: box,

    failNext(kind, code) {
      failures.set(kind, code);
    },

    killBridge(sandboxName) {
      const found = box(sandboxName);
      if (found) found.bridgeRunning = false;
    },

    setAvailable(next) {
      available = next;
    },

    async isAvailable() {
      return available;
    },

    async ensure(input: EnsureSandboxInput): Promise<SandboxResult<SandboxState>> {
      calls.push({ kind: "ensure", input });
      const fail = armed("ensure");
      if (fail) return sandboxFailure(fail);

      const existing = box(input.sandboxName);
      if (existing) {
        // Resuming: the filesystem survives, which is the whole point of a
        // persistent sandbox and the thing a remote *project* depends on.
        existing.status = "ready";
        existing.expiresAt = Date.now() + input.timeoutMs;
        return { ok: true, value: { status: existing.status, expiresAt: existing.expiresAt } };
      }

      const created: Box = {
        status: "ready",
        expiresAt: Date.now() + input.timeoutMs,
        files: new Map(),
        log: [],
        bridgeRunning: false,
        allowedHosts: input.allowedHosts,
      };
      boxes.set(input.sandboxName, created);
      return { ok: true, value: { status: created.status, expiresAt: created.expiresAt } };
    },

    async state(sandboxName: string): Promise<SandboxResult<SandboxState>> {
      calls.push({ kind: "state", sandboxName });
      const fail = armed("state");
      if (fail) return sandboxFailure(fail);

      const found = box(sandboxName);
      if (!found) return sandboxFailure("not-found");
      return {
        ok: true,
        value: {
          status: found.status,
          ...(found.expiresAt ? { expiresAt: found.expiresAt } : {}),
        },
      };
    },

    async writeWorkspace(
      sandboxName: string,
      files: readonly SandboxFile[]
    ): Promise<SandboxResult<void>> {
      calls.push({ kind: "writeWorkspace", sandboxName, paths: files.map((file) => file.path) });
      const fail = armed("writeWorkspace");
      if (fail) return sandboxFailure(fail);

      const found = box(sandboxName);
      if (!found) return sandboxFailure("not-found");
      for (const file of files) found.files.set(file.path, file.content);
      return { ok: true, value: undefined };
    },

    async writeBridgeConfig(sandboxName: string, config: unknown): Promise<SandboxResult<void>> {
      calls.push({ kind: "writeBridgeConfig", sandboxName, config });
      const fail = armed("writeBridgeConfig");
      if (fail) return sandboxFailure(fail);

      const found = box(sandboxName);
      if (!found) return sandboxFailure("not-found");
      found.config = config;
      return { ok: true, value: undefined };
    },

    async startBridge(input: StartBridgeInput): Promise<SandboxResult<{ commandId: string }>> {
      calls.push({ kind: "startBridge", input });
      const fail = armed("startBridge");
      if (fail) return sandboxFailure(fail);

      const found = box(input.sandboxName);
      if (!found) return sandboxFailure("not-found");

      found.bridgeRunning = true;
      found.commandId = `cmd-${++commandCounter}`;
      found.env = input.env;
      found.status = "running";
      return { ok: true, value: { commandId: found.commandId } };
    },

    async isBridgeRunning(sandboxName: string, commandId: string): Promise<boolean> {
      const found = box(sandboxName);
      return Boolean(found && found.bridgeRunning && found.commandId === commandId);
    },

    async writeInbox(
      sandboxName: string,
      name: string,
      payload: unknown
    ): Promise<SandboxResult<void>> {
      calls.push({ kind: "writeInbox", sandboxName, name, payload });
      const fail = armed("writeInbox");
      if (fail) return sandboxFailure(fail);

      const found = box(sandboxName);
      if (!found) return sandboxFailure("not-found");
      inbox.push({ sandboxName, payload });
      return { ok: true, value: undefined };
    },

    async drain(sandboxName: string, cursor: number): Promise<SandboxResult<SandboxDrain>> {
      calls.push({ kind: "drain", sandboxName, cursor });
      const fail = armed("drain");
      if (fail) return sandboxFailure(fail);

      const found = box(sandboxName);
      if (!found) return sandboxFailure("not-found");

      // The real service slices a byte buffer; this returns whole lines from
      // `cursor` onwards, which is the same contract at the granularity the
      // caller actually consumes.
      const text = found.log.join("\n");
      const bytes = Buffer.byteLength(text, "utf8");
      return {
        ok: true,
        value: {
          lines: cursor === 0 ? [...found.log] : [],
          cursor: bytes,
          truncated: bytes > REMOTE_LIMITS.maxDrainBytes,
        },
      };
    },

    async extend(sandboxName: string, byMs: number): Promise<SandboxResult<SandboxState>> {
      calls.push({ kind: "extend", sandboxName, byMs });
      const found = box(sandboxName);
      if (!found) return sandboxFailure("not-found");
      found.expiresAt = (found.expiresAt ?? Date.now()) + byMs;
      return { ok: true, value: { status: found.status, expiresAt: found.expiresAt } };
    },

    async stop(sandboxName: string): Promise<SandboxResult<void>> {
      calls.push({ kind: "stop", sandboxName });
      const fail = armed("stop");
      if (fail) return sandboxFailure(fail);

      const found = box(sandboxName);
      if (found) {
        found.status = "stopped";
        found.bridgeRunning = false;
      }
      return { ok: true, value: undefined };
    },

    async destroy(sandboxName: string): Promise<SandboxResult<void>> {
      calls.push({ kind: "destroy", sandboxName });
      const fail = armed("destroy");
      if (fail) return sandboxFailure(fail);

      boxes.delete(sandboxName);
      return { ok: true, value: undefined };
    },
  };
}
