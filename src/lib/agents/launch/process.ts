import "server-only";
import { spawn } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import nodePath from "node:path";
import { validateProjectPath } from "@/lib/agents/control/projects";
import { launchEntryFor } from "./allowlist";
import { agentEnvironment } from "./env";
import { detectProviders } from "./detect";
import { resolveExecutable } from "./resolve";
import type { AcpLauncher } from "@/lib/agents/control/providers/acp/launcher";
import type { AcpCloseReason, AcpTransport } from "@/lib/agents/control/providers/acp/rpc";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { ProviderDetection } from "@/lib/agents/runtime/protocol";
import type { ResolverFs } from "./resolve";

/**
 * The one module in TabDump that starts an agent process over ACP.
 *
 * ## The whole contract, in the order it is enforced
 *
 *   1. **The provider must have an ACP entry in the allowlist.** Anything
 *      else is refused before PATH is even consulted.
 *   2. **The executable is resolved by name from that entry** — never from a
 *      request — and a Windows npm shim is followed only to an allowlisted
 *      package's own script. See ./resolve.ts.
 *   3. **The arguments are the entry's literal array.** Nothing is appended.
 *   4. **The working directory is revalidated here.** The service has already
 *      checked the project; this checks again with the same validator,
 *      because a path handed to `spawn` is the last point at which a mistake
 *      upstream could become a process running in the wrong place. With no
 *      project, the agent gets a fresh empty directory that is deleted when
 *      the session ends.
 *   5. **`shell: false`, always.** There is no code path with a shell.
 *   6. **The environment is an allowlist.** See ./env.ts.
 *
 * stderr is drained and discarded — it is the agent's diagnostic channel,
 * it may echo anything, and nothing in TabDump displays it.
 */

const MAX_STDERR_BYTES = 64 * 1024;
const MAX_BUFFER_BYTES = 2 * 1024 * 1024;

export const realResolverFs: ResolverFs = {
  isFile(candidate) {
    try {
      return statSync(candidate).isFile();
    } catch {
      return false;
    }
  },
  readText(candidate) {
    try {
      return readFileSync(candidate, "utf8");
    } catch {
      return undefined;
    }
  },
};

/** What is installed here. Paths are resolved and then discarded. */
export function detectLocalProviders(
  env: Readonly<Record<string, string | undefined>>
): ProviderDetection[] {
  return detectProviders({
    env,
    platform: process.platform,
    homeDirectory: safeHome(),
    fs: realResolverFs,
  });
}

function safeHome(): string | undefined {
  try {
    return homedir();
  } catch {
    return undefined;
  }
}

/** Lines out of a byte stream. Bounded: a line that never ends is discarded. */
function lineSplitter(onLine: (line: string) => void) {
  let buffer = "";
  return (chunk: Buffer | string) => {
    buffer += typeof chunk === "string" ? chunk : chunk.toString("utf8");
    let index = buffer.indexOf("\n");
    while (index !== -1) {
      const line = buffer.slice(0, index).replace(/\r$/, "");
      buffer = buffer.slice(index + 1);
      if (line) onLine(line);
      index = buffer.indexOf("\n");
    }
    if (buffer.length > MAX_BUFFER_BYTES) buffer = "";
  };
}

/* ------------------------------------------------------------------ *
 * An SDK-driven agent's own CLI (Phase J.1)
 * ------------------------------------------------------------------ */

/**
 * The installed executable of an agent TabDump drives through its SDK.
 *
 * Resolved by name from the allowlist, like everything else here. A shim is
 * not followed for these: an SDK needs a real binary to hand to its own
 * spawner, and Claude Code installs one.
 */
export function resolveNativeExecutable(
  provider: AgentProviderId,
  env: Readonly<Record<string, string | undefined>>
): string | undefined {
  const entry = launchEntryFor(provider)?.native;
  if (!entry) return undefined;
  for (const name of entry.executables) {
    const resolved = resolveExecutable(name, { env, platform: process.platform, fs: realResolverFs });
    if (resolved?.kind === "native") return resolved.file;
  }
  return undefined;
}

/** What may be asked of an agent's own CLI. An operation, never an argument list. */
export type NativeOperation = { kind: "status" } | { kind: "login"; methodId: string };

export type NativeRunResult =
  | { ok: true; exitCode: number | null; stdout: string }
  | { ok: false; reason: "not-installed" | "unknown-operation" | "failed" | "timeout" };

const MAX_NATIVE_STDOUT = 64 * 1024;

/**
 * Runs one allowlisted operation of an agent's own CLI and waits for it.
 *
 * The caller names the provider and the operation; the argument list comes
 * from the allowlist's literal table, so there is no parameter through which
 * text could reach argv. Same rules as `createAcpProcessLauncher`: `shell:
 * false`, allowlisted environment, a scratch working directory. stdout is
 * returned bounded (the status command answers in JSON); stderr is drained
 * and discarded.
 */
export async function runNativeOperation(
  provider: AgentProviderId,
  operation: NativeOperation,
  options: { env: Readonly<Record<string, string | undefined>>; timeoutMs: number }
): Promise<NativeRunResult> {
  const entry = launchEntryFor(provider)?.native;
  if (!entry) return { ok: false, reason: "not-installed" };

  const args =
    operation.kind === "status"
      ? entry.statusArgs
      : Object.prototype.hasOwnProperty.call(entry.loginArgs, operation.methodId)
        ? entry.loginArgs[operation.methodId]
        : undefined;
  if (!args) return { ok: false, reason: "unknown-operation" };

  const file = resolveNativeExecutable(provider, options.env);
  if (!file) return { ok: false, reason: "not-installed" };

  return new Promise<NativeRunResult>((resolve) => {
    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, [...args], {
        cwd: tmpdir(),
        env: agentEnvironment(options.env) as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch {
      resolve({ ok: false, reason: "failed" });
      return;
    }

    let stdout = "";
    let settled = false;
    const done = (result: NativeRunResult) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(result);
    };
    const timer = setTimeout(() => {
      child.kill();
      done({ ok: false, reason: "timeout" });
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      if (stdout.length < MAX_NATIVE_STDOUT) stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", () => {});
    child.on("error", () => done({ ok: false, reason: "failed" }));
    child.on("exit", (code) => done({ ok: true, exitCode: code, stdout: stdout.slice(0, MAX_NATIVE_STDOUT) }));
  });
}

export type ProcessLauncherOptions = {
  provider: AgentProviderId;
  /** The server's environment. Read for PATH and the allowlist in ./env.ts only. */
  env: Readonly<Record<string, string | undefined>>;
};

export function createAcpProcessLauncher(options: ProcessLauncherOptions): AcpLauncher {
  return async (request) => {
    const entry = launchEntryFor(options.provider)?.acp;
    if (!entry) return { ok: false, reason: "not-installed" };

    let resolved: ReturnType<typeof resolveExecutable>;
    for (const name of entry.executables) {
      resolved = resolveExecutable(name, {
        env: options.env,
        platform: process.platform,
        fs: realResolverFs,
        ...(entry.npmPackages ? { npmPackages: entry.npmPackages } : {}),
      });
      if (resolved) break;
    }
    if (!resolved) return { ok: false, reason: "not-installed" };

    let cwd: string;
    let scratch: string | undefined;
    if (request.projectPath !== undefined) {
      const checked = validateProjectPath(request.projectPath);
      if (!checked.ok || !existsSync(request.projectPath)) return { ok: false, reason: "failed" };
      cwd = nodePath.resolve(request.projectPath);
    } else {
      scratch = mkdtempSync(nodePath.join(tmpdir(), "tabdump-agent-"));
      cwd = scratch;
    }

    let exited = false;
    let releaseRequested = false;
    const removeScratch = () => {
      if (!scratch) return;
      const target = scratch;
      scratch = undefined;
      try {
        rmSync(target, { recursive: true, force: true, maxRetries: 3 });
      } catch {
        // A scratch directory left behind is litter in the temp folder, not a risk.
      }
    };
    // On Windows a directory cannot be removed while a process is running in
    // it, so removal waits for the agent to have actually exited.
    const release = () => {
      releaseRequested = true;
      if (exited) removeScratch();
    };

    const file = resolved.kind === "native" ? resolved.file : process.execPath;
    const args = resolved.kind === "native" ? [...entry.args] : [resolved.script, ...entry.args];

    let child: ReturnType<typeof spawn>;
    try {
      child = spawn(file, args, {
        cwd,
        // The allowlisted set and nothing else. `NODE_ENV` is deliberately
        // among the things an agent does not inherit.
        env: agentEnvironment(options.env) as NodeJS.ProcessEnv,
        shell: false,
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
    } catch {
      exited = true;
      release();
      return { ok: false, reason: "failed" };
    }

    const lineListeners = new Set<(line: string) => void>();
    const closeListeners = new Set<(reason: AcpCloseReason) => void>();
    let closed = false;

    function finish(reason: AcpCloseReason): void {
      if (closed) return;
      closed = true;
      for (const listener of [...closeListeners]) listener(reason);
      lineListeners.clear();
      closeListeners.clear();
    }

    child.stdout?.on("data", lineSplitter((line) => {
      for (const listener of [...lineListeners]) listener(line);
    }));
    let stderrBytes = 0;
    child.stderr?.on("data", (chunk: Buffer) => {
      // Drained so the pipe never fills and stalls the agent. Never read.
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) stderrBytes = MAX_STDERR_BYTES;
    });
    child.stdin?.on("error", () => finish("error"));
    child.on("error", () => {
      exited = true;
      finish("error");
      if (releaseRequested) removeScratch();
    });
    child.on("exit", () => {
      exited = true;
      finish("exited");
      if (releaseRequested) removeScratch();
    });

    const transport: AcpTransport = {
      send(line) {
        if (closed || !child.stdin?.writable) return;
        child.stdin.write(`${line}\n`);
      },
      onLine(listener) {
        lineListeners.add(listener);
        return () => lineListeners.delete(listener);
      },
      onClose(listener) {
        closeListeners.add(listener);
        return () => closeListeners.delete(listener);
      },
      close() {
        if (closed) return;
        child.stdin?.end();
        child.kill();
        finish("closed");
      },
    };

    // A process that could not be started reports it on the next tick; wait
    // for that tick so a missing binary is "not installed", not a hang.
    await new Promise((resolve) => setImmediate(resolve));
    if (closed) {
      release();
      return { ok: false, reason: "failed" };
    }

    return { ok: true, transport, cwd, release };
  };
}
