import type { RemoteSandboxStatus } from "./types";

/**
 * The remote execution plane's seam.
 *
 * ## What this interface is, and what it refuses to be
 *
 * It is the smallest surface the remote runtime needs, in TabDump's own
 * vocabulary — exactly the discipline `providers/claude-code/runtime.ts`
 * already applies to the Claude SDK, and for the same three reasons: the
 * platform's types do not leak through the codebase, a deterministic test
 * double is a real implementation of a real contract rather than a mock of
 * somebody else's module, and replacing the platform later is one file.
 *
 * **There is no `exec`, no `runCommand`, no `shell`, no `argv` and no path
 * parameter.** That is the single most important property of this file. The
 * underlying platform SDK offers a general-purpose "run this string in a
 * microVM" primitive, and exposing it here — even privately, even
 * server-side — would mean the remote plane's safety rested on every future
 * caller choosing not to pass user input into it. Instead every method below
 * names one *operation*, and the only caller-supplied values are opaque
 * blobs that are written to fixed locations the caller cannot choose.
 *
 * The one command this plane ever runs is the bridge, whose command line is a
 * constant in `sandbox-vercel.ts`. `security.test.ts` asserts that no
 * caller-reachable string ever becomes part of it.
 *
 * ## Provider neutrality
 *
 * Nothing here names Claude. A sandbox is a place to run *an* agent, and the
 * bridge it starts is chosen by the runtime that asked for it. When Codex or
 * Gemini get a remote runtime they use this same seam with a different bridge
 * and a different credential, and this file does not move.
 */

/* ------------------------------------------------------------------ *
 * Errors
 * ------------------------------------------------------------------ */

export type SandboxErrorCode =
  /** The platform SDK could not be loaded, or this process holds no credentials for it. */
  | "unavailable"
  /** The platform refused the credentials it was given. */
  | "authentication"
  /** The named sandbox is gone — reclaimed, deleted, or never created. */
  | "not-found"
  /** The sandbox exists but is not in a state that can accept this. */
  | "not-dispatchable"
  /** The platform accepted the request and it failed. */
  | "failed"
  /** The platform did not answer in time. */
  | "timeout";

/**
 * A sandbox failure, already reduced.
 *
 * `detail` is for diagnosis and is never rendered — the runtime maps `code`
 * onto the control plane's fixed error table. Keeping the raw text rather
 * than discarding it is what lets an operator debug without a cloud platform
 * getting to choose what a user reads, which is the same rule
 * `ClaudeRuntimeError` already follows.
 */
export type SandboxError = { code: SandboxErrorCode; detail?: string };

export type SandboxResult<T> = { ok: true; value: T } | { ok: false; error: SandboxError };

export function sandboxFailure<T = never>(
  code: SandboxErrorCode,
  detail?: string
): SandboxResult<T> {
  return { ok: false, error: detail === undefined ? { code } : { code, detail } };
}

/* ------------------------------------------------------------------ *
 * Values
 * ------------------------------------------------------------------ */

/** What the platform says about a sandbox right now. Re-read before dispatch, never cached into a decision. */
export type SandboxState = {
  status: RemoteSandboxStatus;
  /** When the platform will reclaim it, if it has said. */
  expiresAt?: number;
};

/**
 * One file going into a sandbox workspace.
 *
 * `path` is **relative to the workspace root and validated before it gets
 * here** — see `upload.ts`, which refuses absolute paths, traversal, drive
 * letters, NUL bytes and anything that normalizes outside the root. By the
 * time a value reaches this type it cannot name a location outside the
 * project directory, which is why the implementation may join it without a
 * second thought.
 */
export type SandboxFile = {
  path: string;
  content: Uint8Array;
};

/** A batch of lines the bridge has written since the caller's cursor. */
export type SandboxDrain = {
  /** Complete lines only. A partial trailing line is left for the next drain. */
  lines: readonly string[];
  /** The new byte offset. Advances only past complete lines. */
  cursor: number;
  /** Whether the log had more than one drain's worth waiting. */
  truncated: boolean;
};

export type StartBridgeInput = {
  sandboxName: string;
  /**
   * Environment for the bridge process.
   *
   * This is where the provider credential travels, and it is the only place
   * it ever exists outside the deployment's own environment: read from
   * `process.env` at the moment of the call, handed to the platform over TLS,
   * never written to a row, never put in a prompt, never emitted on an event
   * and never logged. The implementation does not inspect it.
   */
  env: Readonly<Record<string, string>>;
};

export type EnsureSandboxInput = {
  sandboxName: string;
  /** Milliseconds from now until the platform may reclaim it. */
  timeoutMs: number;
  /**
   * Hosts the sandbox may reach.
   *
   * An allowlist, applied as a deny-by-default egress policy. The brief asks
   * for this where the platform supports it, and it does: without it a
   * compromised or merely careless agent inside the microVM could reach
   * anything on the internet, including this deployment's own API.
   */
  allowedHosts: readonly string[];
  /** Key-value labels for the reclamation sweep and for support. Never secrets. */
  tags?: Readonly<Record<string, string>>;
};

/* ------------------------------------------------------------------ *
 * The seam
 * ------------------------------------------------------------------ */

export type RemoteSandboxService = {
  /**
   * Whether this process can address the platform at all.
   *
   * Distinct from the gate's question. The gate asks whether this deployment
   * is *permitted* to use the remote plane; this asks whether the SDK loads
   * and the credentials work. Both must say yes, and the gate is checked
   * first — a deployment that may not use remote execution must never get as
   * far as authenticating to a cloud API.
   */
  isAvailable(): Promise<boolean>;

  /**
   * Gets the sandbox, creating or resuming it as needed.
   *
   * Idempotent by name, which is what makes it safe to call from a serverless
   * function that does not know whether a previous invocation already created
   * one. A resumed sandbox comes back with the filesystem it was snapshotted
   * with, so a project's files and installed dependencies survive a stop.
   */
  ensure(input: EnsureSandboxInput): Promise<SandboxResult<SandboxState>>;

  /** The platform's current view. The authority on whether a sandbox may be dispatched into. */
  state(sandboxName: string): Promise<SandboxResult<SandboxState>>;

  /** Unpacks files into the workspace root. Creates the directory tree as needed. */
  writeWorkspace(
    sandboxName: string,
    files: readonly SandboxFile[]
  ): Promise<SandboxResult<void>>;

  /**
   * Writes the bridge's configuration.
   *
   * Separate from `startBridge` because it is *data* and the bridge reads it
   * as such: the permission mode and tool lists derived from the user's grant,
   * written to a fixed path, parsed with `JSON.parse`. Keeping it out of the
   * start call is what stops it from ever being mistaken for something that
   * could influence a command line.
   */
  writeBridgeConfig(sandboxName: string, config: unknown): Promise<SandboxResult<void>>;

  /**
   * Installs the bridge and starts it, detached.
   *
   * Returns the platform's command id, which is what a *later* invocation
   * uses to find the same running agent instead of starting a second one.
   */
  startBridge(input: StartBridgeInput): Promise<SandboxResult<{ commandId: string }>>;

  /** Whether the bridge process this command id names is still running. */
  isBridgeRunning(sandboxName: string, commandId: string): Promise<boolean>;

  /**
   * Hands the bridge one instruction.
   *
   * `name` is a caller-chosen *label*, not a path: the implementation slugs
   * it and writes inside the fixed inbox directory, so nothing a caller
   * supplies can escape it. `payload` is JSON the bridge parses.
   */
  writeInbox(
    sandboxName: string,
    name: string,
    payload: unknown
  ): Promise<SandboxResult<void>>;

  /** Reads whatever the bridge has written since `cursor`. */
  drain(sandboxName: string, cursor: number): Promise<SandboxResult<SandboxDrain>>;

  /** Pushes the deadline out. Bounded by the caller, never unbounded. */
  extend(sandboxName: string, byMs: number): Promise<SandboxResult<SandboxState>>;

  /** Stops the sandbox, snapshotting it so the project's files survive. */
  stop(sandboxName: string): Promise<SandboxResult<void>>;

  /** Destroys the sandbox and its snapshots. Irreversible, and used only when a project is deleted. */
  destroy(sandboxName: string): Promise<SandboxResult<void>>;
};

/* ------------------------------------------------------------------ *
 * Naming
 * ------------------------------------------------------------------ */

/**
 * Mints a sandbox name.
 *
 * Random, and **not derived from the project id, the owner, or the name the
 * user chose**. That is a security property rather than a style preference:
 * a derived name would mean that anyone who learned a project id could
 * compute the handle that addresses the running microVM, and a name that
 * embedded an account id would leak one into every platform dashboard,
 * billing line and log aggregator that ever printed it.
 *
 * The `tabdump-` prefix is there so the reclamation sweep can list this
 * deployment's sandboxes without touching anything else in the same project.
 */
export function mintSandboxName(createId: () => string = () => crypto.randomUUID()): string {
  return `tabdump-${createId().replace(/[^a-z0-9]/gi, "").toLowerCase().slice(0, 24)}`;
}

/**
 * Whether a string is one of our sandbox names.
 *
 * Used on the way *out* of the store, not on the way in from a request —
 * nothing in the protocol can carry a sandbox name, so this is not an input
 * filter. It is a guard against a hand-edited or corrupted row sending the
 * reclamation sweep at something that is not ours.
 */
export function isSandboxName(value: unknown): value is string {
  return typeof value === "string" && /^tabdump-[a-z0-9]{8,24}$/.test(value);
}
