import "server-only";
import { spawn } from "node:child_process";
import { readFileSync, statSync } from "node:fs";
import nodePath from "node:path";
import { validateProjectPath } from "@/lib/agents/control/projects";
import { agentEnvironment } from "@/lib/agents/launch/env";
import { resolveExecutable } from "@/lib/agents/launch/resolve";
import { parseGitStatusPorcelain, scriptForCheck } from "@/lib/agents/project/checks";
import type { ResolverFs } from "@/lib/agents/launch/resolve";
import type { ProjectCheckId } from "@/lib/agents/project/checks";
import type { CheckRunResult, ProjectCheckRunner } from "@/lib/agents/project/seam";

/**
 * Runs a project check (Hubble 1.6) — the second and last place Hubble starts
 * a process of its own, after the agent launcher.
 *
 * ## The rules, and where each is kept
 *
 *   - **Two programs, literal arguments.** `npm run <script>` for the four
 *     script checks, where `<script>` is re-read from the project's own
 *     `package.json` here, at the moment it runs, and must be a plain name;
 *     `git … status --porcelain` for Git status. Nothing a client or an agent
 *     sends reaches an argument list — the request names a check id and
 *     nothing else.
 *   - **No shell.** `shell: false`; npm's own CLI is run by the Node binary
 *     already running Hubble, the same way the agent launcher follows npm
 *     shims (`resolveExecutable`).
 *   - **The agents' environment.** `agentEnvironment` — no key, token or
 *     Hubble secret — plus `CI=1` so a test runner runs once instead of
 *     watching.
 *   - **Git cannot run hooks or monitors on our behalf.** `core.fsmonitor` is
 *     forced off and optional locks are skipped, so reading status changes
 *     nothing and starts nothing the repository configured.
 *   - **Nothing is kept.** Output is drained and discarded (Git's is counted,
 *     never stored); the result is an outcome, an exit code and a duration.
 *   - **Bounded.** A check that runs past its limit is stopped, with its
 *     whole process tree.
 *
 * A project's scripts are code — possibly code an agent just changed — which
 * is why a check only ever runs when the person presses its button, having
 * seen the command (`ProjectCheck.command`).
 */

export const CHECK_TIMEOUT_MS = 10 * 60 * 1000;
const STOP_GRACE_MS = 5_000;
const MAX_GIT_OUTPUT = 1024 * 1024;

const resolverFs: ResolverFs = {
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

function readManifest(root: string): unknown {
  try {
    const file = nodePath.join(root, "package.json");
    if (statSync(file).size > 256 * 1024) return undefined;
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return undefined;
  }
}

/** Ends a check and everything it started. */
function stopTree(pid: number | undefined, platform: NodeJS.Platform, env: Readonly<Record<string, string | undefined>>): void {
  if (!pid) return;
  try {
    if (platform === "win32") {
      const systemRoot = env.SystemRoot ?? env.SYSTEMROOT ?? "C:\\Windows";
      const taskkill = nodePath.win32.join(systemRoot, "System32", "taskkill.exe");
      // A fixed system program with a numeric argument — see the module note.
      spawn(/*turbopackIgnore: true*/ taskkill, ["/pid", String(pid), "/T", "/F"], { shell: false, windowsHide: true, stdio: "ignore" });
    } else {
      process.kill(-pid, "SIGKILL");
    }
  } catch {
    // Already gone.
  }
}

export function createProjectCheckRunner(options: {
  env: Readonly<Record<string, string | undefined>>;
  platform?: NodeJS.Platform;
  /** The Node binary that runs npm's CLI. Defaults to the one running Hubble. */
  nodeBinary?: string;
}): ProjectCheckRunner {
  const platform = options.platform ?? process.platform;
  const nodeBinary = options.nodeBinary ?? process.execPath;

  /** The program and literal arguments for a check, or why it cannot run. */
  function commandFor(root: string, check: ProjectCheckId): { file: string; args: string[] } | "unavailable" {
    if (check === "git_status") {
      const git = resolveExecutable("git", { env: options.env, platform, fs: resolverFs });
      if (!git || git.kind !== "native") return "unavailable";
      return {
        file: git.file,
        args: ["-c", "core.fsmonitor=false", "-c", "core.untrackedCache=false", "--no-optional-locks", "status", "--porcelain=v1", "--untracked-files=normal"],
      };
    }
    // Re-read here, from the project, never from the request.
    const script = scriptForCheck(readManifest(root), check);
    if (!script) return "unavailable";
    const npm = resolveExecutable("npm", { env: options.env, platform, fs: resolverFs, npmPackages: ["npm"] });
    if (!npm) return "unavailable";
    return npm.kind === "node-script" ? { file: nodeBinary, args: [npm.script, "run", script.name] } : { file: npm.file, args: ["run", script.name] };
  }

  return {
    run(root, check, runOptions = {}) {
      const started = Date.now();
      const elapsed = () => Date.now() - started;
      if (!validateProjectPath(root).ok) return Promise.resolve({ outcome: "unavailable", durationMs: 0 });
      const command = commandFor(root, check);
      if (command === "unavailable") return Promise.resolve({ outcome: "unavailable", durationMs: 0 });

      const env: Record<string, string> = { ...agentEnvironment(options.env), CI: "1" };
      if (check === "git_status") {
        env.GIT_OPTIONAL_LOCKS = "0";
        env.GIT_TERMINAL_PROMPT = "0";
      }

      return new Promise((resolve) => {
        let child: ReturnType<typeof spawn>;
        try {
          // A machine-local program (npm's CLI under Hubble's own Node, or Git), never a project file.
          child = spawn(/*turbopackIgnore: true*/ command.file, command.args, {
            cwd: root,
            env: env as NodeJS.ProcessEnv,
            shell: false,
            windowsHide: true,
            detached: platform !== "win32",
            stdio: ["ignore", "pipe", "pipe"],
          });
        } catch {
          resolve({ outcome: "error", durationMs: elapsed() });
          return;
        }

        let settled = false;
        let gitOutput = "";
        const settle = (result: CheckRunResult) => {
          if (settled) return;
          settled = true;
          if (!timedOut) clearTimeout(timer);
          resolve(result);
        };
        let timedOut = false;
        const timer = setTimeout(() => {
          // Stopped, and reported only once it has actually exited (or after a grace
          // period): "timed out" must never describe a check that is still running.
          timedOut = true;
          stopTree(child.pid, platform, options.env);
          setTimeout(() => settle({ outcome: "timed_out", durationMs: elapsed() }), STOP_GRACE_MS).unref?.();
        }, runOptions.timeoutMs ?? CHECK_TIMEOUT_MS);

        child.stdout?.on("data", (chunk: Buffer) => {
          if (check === "git_status" && gitOutput.length < MAX_GIT_OUTPUT) gitOutput += chunk.toString("utf8");
        });
        // Drained so the child never blocks on a full pipe; never kept.
        child.stderr?.on("data", () => undefined);
        child.on("error", () => settle({ outcome: "error", durationMs: elapsed() }));
        child.on("close", (code) => {
          const durationMs = elapsed();
          if (timedOut) return settle({ outcome: "timed_out", durationMs });
          if (code === null) return settle({ outcome: "error", durationMs });
          if (check === "git_status") {
            return settle(code === 0 ? { outcome: "passed", exitCode: 0, durationMs, git: parseGitStatusPorcelain(gitOutput) } : { outcome: "failed", exitCode: code, durationMs });
          }
          settle({ outcome: code === 0 ? "passed" : "failed", exitCode: code, durationMs });
        });
      });
    },
  };
}
