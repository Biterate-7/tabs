import "server-only";
import { AGENT_BRIDGE_SOURCE } from "./bridge";
import { sandboxFailure } from "./sandbox";
import {
  REMOTE_CONTROL_ROOT,
  REMOTE_EVENT_LOG,
  REMOTE_INBOX_DIR,
  REMOTE_LIMITS,
  REMOTE_WORKSPACE_ROOT,
} from "./types";
import type {
  EnsureSandboxInput,
  RemoteSandboxService,
  SandboxDrain,
  SandboxError,
  SandboxFile,
  SandboxResult,
  SandboxState,
  StartBridgeInput,
} from "./sandbox";
import type { RemoteSandboxStatus } from "./types";

/**
 * The real remote plane, on `@vercel/sandbox`.
 *
 * **The only module in TabDump that imports the sandbox SDK.** Everything
 * else works against the narrow interface in ./sandbox.ts, so the platform's
 * types never leak and replacing it is one file — the same discipline
 * `providers/claude-code/sdk-runtime.ts` applies to the Claude SDK.
 *
 * ## server-only, and the dynamic import
 *
 * The first line makes this a build error if it is ever reached from a client
 * component: this module can create compute and spend money, and a bundler
 * that pulled it into the browser graph would ship the shape of that
 * capability to every visitor.
 *
 * The SDK itself is reached through a **dynamic** import inside the function
 * that needs it, because this module is imported by a route that must be able
 * to *load* on a deployment with no sandbox support in order to refuse
 * cleanly.
 *
 * ## The one command
 *
 * `startBridge` is the only method that runs anything, and what it runs is
 * assembled entirely from constants in this file and in ./types.ts. No
 * argument to any method below becomes part of a command line. The security
 * suite asserts it by driving every method with hostile strings and checking
 * what reached the fake platform.
 */

/** Where the bridge's own dependencies are installed. Outside the project, so an agent editing its workspace cannot reach them. */
const BRIDGE_PACKAGE = "@anthropic-ai/claude-agent-sdk";

/**
 * The image to boot.
 *
 * Vercel's managed universal image ships a current Node LTS and the common
 * toolchain, which is what the bridge's `npm install` needs. Named explicitly
 * rather than relying on the default, so an upstream change to what "default"
 * means is a deliberate edit here rather than a surprise in production.
 */
const SANDBOX_IMAGE = "vercel/sandbox/universal";

type SdkSandbox = {
  name: string;
  status: string;
  expiresAt?: Date;
  runCommand(input: Record<string, unknown>): Promise<{ cmdId: string; exitCode: number | null }>;
  getCommand(cmdId: string): Promise<{ exitCode: number | null }>;
  writeFiles(files: { path: string; content: Buffer; mode?: number }[]): Promise<void>;
  readFileToBuffer(file: { path: string }): Promise<Buffer | null>;
  mkDir(path: string): Promise<void>;
  extendTimeout(ms: number): Promise<void>;
  stop(): Promise<unknown>;
  delete(): Promise<void>;
};

type SdkModule = {
  Sandbox: {
    getOrCreate(input: Record<string, unknown>): Promise<SdkSandbox>;
    get(input: Record<string, unknown>): Promise<SdkSandbox>;
  };
};

/**
 * Maps the platform's status vocabulary onto ours.
 *
 * An unrecognised status becomes `failed` rather than being passed through or
 * optimistically read as ready. The fail-open reading of "a status I have
 * never seen" is "sure, dispatch into it", and that is the one answer this
 * function must never give.
 */
function toStatus(value: string): RemoteSandboxStatus {
  switch (value) {
    case "pending":
      return "creating";
    case "running":
      return "running";
    case "stopping":
      return "stopping";
    case "stopped":
      return "stopped";
    case "failed":
      return "failed";
    default:
      return "failed";
  }
}

/**
 * Classifies a thrown value without letting its text escape.
 *
 * The message is read only to choose a *code*; the raw string goes into
 * `detail`, which is used for diagnosis and never rendered. Same discipline
 * as `classify` in the Claude SDK runtime, and for the same reason: a cloud
 * platform must not get to choose what a user reads.
 */
function classify(error: unknown): SandboxError {
  const detail = error instanceof Error ? error.message : String(error);
  const lowered = detail.toLowerCase();

  if (lowered.includes("not found") || lowered.includes("404")) {
    return { code: "not-found", detail };
  }
  if (
    lowered.includes("unauthorized") ||
    lowered.includes("forbidden") ||
    lowered.includes("401") ||
    lowered.includes("403") ||
    lowered.includes("token")
  ) {
    return { code: "authentication", detail };
  }
  if (lowered.includes("timeout") || lowered.includes("timed out")) {
    return { code: "timeout", detail };
  }
  return { code: "failed", detail };
}

export type VercelSandboxServiceOptions = {
  /** Overrides the module specifier. Exists so an opt-in integration test can point at the installed package. */
  moduleSpecifier?: string;
  /** The process environment, injected so the credential read is testable without one. */
  env?: Readonly<Record<string, string | undefined>>;
};

export function createVercelSandboxService(
  options: VercelSandboxServiceOptions = {}
): RemoteSandboxService {
  const specifier = options.moduleSpecifier ?? "@vercel/sandbox";
  const env = options.env ?? process.env;

  async function loadSdk(): Promise<SdkModule | null> {
    try {
      // Dynamic, and the specifier is a constant from this module — never a
      // caller-supplied string, so this cannot become an arbitrary-module
      // loader.
      return (await import(/* webpackIgnore: true */ specifier)) as unknown as SdkModule;
    } catch {
      return null;
    }
  }

  /**
   * The explicit credentials, when this process is not running on the
   * platform that issues its own.
   *
   * Returns an empty object under OIDC, which is the case on Vercel: the SDK
   * reads `VERCEL_OIDC_TOKEN` itself, and passing a token we had copied out
   * of the environment would add a second place for one to be logged.
   */
  function credentials(): Record<string, string> {
    if (env.VERCEL_OIDC_TOKEN) return {};
    const teamId = env.VERCEL_TEAM_ID;
    const projectId = env.VERCEL_PROJECT_ID;
    const token = env.VERCEL_TOKEN;
    if (!teamId || !projectId || !token) return {};
    return { teamId, projectId, token };
  }

  /** Reattaches to a sandbox without waking it. `resume: false` matters: `state` must be a read, not a start. */
  async function peek(sandboxName: string): Promise<SandboxResult<SdkSandbox>> {
    const sdk = await loadSdk();
    if (!sdk) return sandboxFailure("unavailable");
    try {
      const sandbox = await sdk.Sandbox.get({
        name: sandboxName,
        resume: false,
        ...credentials(),
      });
      return { ok: true, value: sandbox };
    } catch (error) {
      return { ok: false, error: classify(error) };
    }
  }

  /** Reattaches and resumes. For the operations that genuinely need a live VM. */
  async function wake(sandboxName: string): Promise<SandboxResult<SdkSandbox>> {
    const sdk = await loadSdk();
    if (!sdk) return sandboxFailure("unavailable");
    try {
      const sandbox = await sdk.Sandbox.get({
        name: sandboxName,
        resume: true,
        ...credentials(),
      });
      return { ok: true, value: sandbox };
    } catch (error) {
      return { ok: false, error: classify(error) };
    }
  }

  function stateOf(sandbox: SdkSandbox): SandboxState {
    const expiresAt = sandbox.expiresAt?.getTime();
    return {
      status: toStatus(sandbox.status),
      ...(typeof expiresAt === "number" && Number.isFinite(expiresAt) ? { expiresAt } : {}),
    };
  }

  return {
    async isAvailable(): Promise<boolean> {
      return (await loadSdk()) !== null;
    },

    async ensure(input: EnsureSandboxInput): Promise<SandboxResult<SandboxState>> {
      const sdk = await loadSdk();
      if (!sdk) return sandboxFailure("unavailable");

      try {
        const sandbox = await sdk.Sandbox.getOrCreate({
          name: input.sandboxName,
          image: SANDBOX_IMAGE,
          timeout: input.timeoutMs,
          resources: { vcpus: REMOTE_LIMITS.vcpus },
          // Persistence is what makes a remote project a *project* rather
          // than a one-shot: the filesystem is snapshotted on stop, so the
          // files and the installed dependencies are still there next time.
          persistent: true,
          // Deny by default, allow by name. Without this an agent inside the
          // microVM could reach anything on the internet, including this
          // deployment's own API — which is precisely the reach the trust
          // boundary exists to prevent.
          networkPolicy: { allow: [...input.allowedHosts] },
          ...(input.tags ? { tags: { ...input.tags } } : {}),
          ...credentials(),
          // Runs only on the create path, never on resume. The workspace and
          // control directories have to exist before anything is written into
          // them, and a resumed sandbox already has them.
          onCreate: async (created: SdkSandbox) => {
            await created.mkDir(REMOTE_WORKSPACE_ROOT);
            await created.mkDir(REMOTE_INBOX_DIR);
          },
        });

        return { ok: true, value: stateOf(sandbox) };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async state(sandboxName: string): Promise<SandboxResult<SandboxState>> {
      const peeked = await peek(sandboxName);
      return peeked.ok ? { ok: true, value: stateOf(peeked.value) } : peeked;
    },

    async writeWorkspace(
      sandboxName: string,
      files: readonly SandboxFile[]
    ): Promise<SandboxResult<void>> {
      const woken = await wake(sandboxName);
      if (!woken.ok) return woken;

      try {
        await woken.value.mkDir(REMOTE_WORKSPACE_ROOT);
        await woken.value.writeFiles(
          files.map((file) => ({
            // Joined to a constant root. `file.path` was rebuilt from
            // validated segments by ./upload.ts and cannot be absolute, cannot
            // traverse and cannot carry a drive letter, so this join has
            // nowhere else it could land.
            path: `${REMOTE_WORKSPACE_ROOT}/${file.path}`,
            content: Buffer.from(file.content),
          }))
        );
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async writeBridgeConfig(
      sandboxName: string,
      config: unknown
    ): Promise<SandboxResult<void>> {
      const woken = await wake(sandboxName);
      if (!woken.ok) return woken;

      try {
        await woken.value.mkDir(REMOTE_CONTROL_ROOT);
        await woken.value.writeFiles([
          {
            // A constant path. The bridge reads exactly this file and nothing
            // else, so there is no name here for a caller to influence.
            path: `${REMOTE_CONTROL_ROOT}/config.json`,
            content: Buffer.from(JSON.stringify(config), "utf8"),
          },
        ]);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async startBridge(
      input: StartBridgeInput
    ): Promise<SandboxResult<{ commandId: string }>> {
      const woken = await wake(input.sandboxName);
      if (!woken.ok) return woken;
      const sandbox = woken.value;

      try {
        await sandbox.mkDir(REMOTE_CONTROL_ROOT);
        await sandbox.mkDir(REMOTE_INBOX_DIR);

        // The bridge and a package manifest for it. Both are constants; the
        // only per-session value in this sandbox is `config.json`, which the
        // caller wrote before calling here and which the bridge *reads* as
        // data rather than executing.
        await sandbox.writeFiles([
          {
            path: `${REMOTE_CONTROL_ROOT}/agent-bridge.mjs`,
            content: Buffer.from(AGENT_BRIDGE_SOURCE, "utf8"),
          },
          {
            path: `${REMOTE_CONTROL_ROOT}/package.json`,
            content: Buffer.from(
              JSON.stringify({ name: "tabdump-bridge", private: true, type: "module" }),
              "utf8"
            ),
          },
        ]);

        // Installed into the control directory rather than globally, so module
        // resolution is the boring default and the agent's own workspace is
        // untouched by TabDump's dependencies. Idempotent across resumes: a
        // sandbox that already has it re-runs this in a second or two.
        const install = await sandbox.runCommand({
          cmd: "npm",
          args: ["install", "--no-audit", "--no-fund", BRIDGE_PACKAGE],
          cwd: REMOTE_CONTROL_ROOT,
        });

        if (install.exitCode !== 0) {
          return sandboxFailure("failed", "bridge dependency install failed");
        }

        const started = await sandbox.runCommand({
          cmd: "node",
          args: [`${REMOTE_CONTROL_ROOT}/agent-bridge.mjs`],
          cwd: REMOTE_CONTROL_ROOT,
          // The credential's only home outside this deployment's environment.
          // Handed to the platform over TLS, held in one process's env inside
          // one microVM, and never written to a file that a snapshot would
          // preserve.
          env: { ...input.env },
          detached: true,
        });

        return { ok: true, value: { commandId: started.cmdId } };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async isBridgeRunning(sandboxName: string, commandId: string): Promise<boolean> {
      const peeked = await peek(sandboxName);
      if (!peeked.ok) return false;
      try {
        const command = await peeked.value.getCommand(commandId);
        // `null` means still running. A finished command has a number, and
        // "finished" is the answer whatever the number is.
        return command.exitCode === null;
      } catch {
        return false;
      }
    },

    async writeInbox(
      sandboxName: string,
      name: string,
      payload: unknown
    ): Promise<SandboxResult<void>> {
      const woken = await wake(sandboxName);
      if (!woken.ok) return woken;

      // Slugged, not trusted. The caller's label becomes at most 48 characters
      // of `[a-z0-9-]` and is then joined to the fixed inbox directory, so a
      // label containing a slash, a `..` or a NUL cannot name a file anywhere
      // else. The uniqueness suffix is ours.
      const slug = name.replace(/[^a-z0-9-]/gi, "").toLowerCase().slice(0, 48) || "item";
      const file = `${REMOTE_INBOX_DIR}/${Date.now()}-${slug}.json`;

      try {
        await woken.value.writeFiles([
          { path: file, content: Buffer.from(JSON.stringify(payload), "utf8") },
        ]);
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async drain(sandboxName: string, cursor: number): Promise<SandboxResult<SandboxDrain>> {
      const peeked = await peek(sandboxName);
      if (!peeked.ok) return peeked;

      try {
        // Reads the whole log and slices. The platform offers no ranged read,
        // and the alternative — running `tail` — would mean building a command
        // line, which this module does not do for anything but the bridge. The
        // log is bounded in practice by the sandbox's own lifetime; see
        // docs/agent-remote-runtime.md on the cost and when it would matter.
        const buffer = await peeked.value.readFileToBuffer({ path: REMOTE_EVENT_LOG });
        if (!buffer) return { ok: true, value: { lines: [], cursor, truncated: false } };

        if (cursor >= buffer.byteLength) {
          // A log shorter than the cursor means the sandbox was recreated and
          // its log started over. Rewinding to zero would replay the whole
          // conversation; the journal would dedupe it, but the honest reading
          // is that this is a different log, so the cursor resets with it.
          return { ok: true, value: { lines: [], cursor: buffer.byteLength, truncated: false } };
        }

        const available = buffer.subarray(cursor);
        const truncated = available.byteLength > REMOTE_LIMITS.maxDrainBytes;
        const slice = truncated ? available.subarray(0, REMOTE_LIMITS.maxDrainBytes) : available;

        const text = slice.toString("utf8");
        const lastNewline = text.lastIndexOf("\n");

        // Nothing complete yet. The cursor does not move, so a line the bridge
        // is mid-way through writing is read whole on the next drain rather
        // than split across two.
        if (lastNewline === -1) return { ok: true, value: { lines: [], cursor, truncated } };

        const complete = text.slice(0, lastNewline);
        const consumed = Buffer.byteLength(complete, "utf8") + 1;

        return {
          ok: true,
          value: {
            lines: complete.split("\n").filter((line) => line.trim().length > 0),
            cursor: cursor + consumed,
            truncated,
          },
        };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async extend(sandboxName: string, byMs: number): Promise<SandboxResult<SandboxState>> {
      const woken = await wake(sandboxName);
      if (!woken.ok) return woken;
      try {
        await woken.value.extendTimeout(byMs);
        return { ok: true, value: stateOf(woken.value) };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async stop(sandboxName: string): Promise<SandboxResult<void>> {
      const peeked = await peek(sandboxName);
      // Already gone is the outcome stopping was for. Reported as success so
      // a cleanup sweep is idempotent rather than retrying forever.
      if (!peeked.ok) {
        return peeked.error.code === "not-found" ? { ok: true, value: undefined } : peeked;
      }
      try {
        await peeked.value.stop();
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },

    async destroy(sandboxName: string): Promise<SandboxResult<void>> {
      const peeked = await peek(sandboxName);
      if (!peeked.ok) {
        return peeked.error.code === "not-found" ? { ok: true, value: undefined } : peeked;
      }
      try {
        await peeked.value.delete();
        return { ok: true, value: undefined };
      } catch (error) {
        return { ok: false, error: classify(error) };
      }
    },
  };
}
