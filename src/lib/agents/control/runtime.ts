/**
 * The local-execution boundary.
 *
 * ## The question this module answers
 *
 * "May this process start an agent that touches a filesystem?"
 *
 * It is the most consequential question in the control plane, because the
 * same TabDump frontend is served from a user's own machine *and* from a
 * hosted deployment. On the user's machine, running an agent against their
 * project is the product. On a hosted deployment, running an agent against
 * *the server's* filesystem — on behalf of any visitor who loads the page —
 * is a remote code execution hole with a friendly UI.
 *
 * ## Why every obvious signal is refused
 *
 * Each of these is either forgeable by the client or true on a server that is
 * not the user's:
 *
 *   - **`Host: localhost` / a loopback remote address** — set by whoever made
 *     the request. A hosted server behind a proxy sees loopback for every
 *     visitor.
 *   - **User agent** — a string the client chooses.
 *   - **`window.__TAURI_INTERNALS__`** — a browser global. It is the right
 *     signal for *rendering* decisions (see lib/platform/detect.ts) and the
 *     wrong one here, because the decision must not be made in the browser at
 *     all.
 *   - **"the `claude` binary exists on PATH"** — true on any developer's
 *     hosted box. Presence of a tool is not authorization to run it.
 *   - **`NODE_ENV !== "production"`** — a build flag, not a statement about
 *     whose machine this is.
 *
 * None of them appear below, and `security.test.ts` asserts that none of them
 * appear below.
 *
 * ## What is actually required
 *
 * Exactly one of:
 *
 *   1. **The desktop shell.** A Tauri build executes through Rust commands on
 *      the machine the user launched. It is local by construction, and the
 *      decision is made in Rust rather than here.
 *   2. **A deliberate operator opt-in**, as a server-side environment
 *      variable that must be set to a single exact value, on a process that
 *      shows no sign of being a hosted platform.
 *
 * Everything else — including "no information at all" — denies. The default
 * answer is no.
 */

/** Where the control plane believes it is executing. */
export type AgentRuntimeKind =
  /** The Tauri desktop shell. Local by construction. */
  | "local-desktop"
  /** A Node process the operator explicitly marked as their own machine. */
  | "local-server"
  /** A managed hosting platform. Never permitted to execute locally. */
  | "hosted"
  /** Could not be established. Treated exactly as `hosted`. */
  | "unknown";

/** Why local execution was refused. Every value is a reason to say no. */
export type RuntimeDenialReason =
  /** The opt-in was absent or not the exact expected value. */
  | "not-opted-in"
  /** A hosted-platform marker was present. The opt-in cannot override this. */
  | "hosted-platform"
  /** The question was asked somewhere it cannot be answered — a browser, a build step. */
  | "no-server-context";

export type RuntimeDecision =
  | { allowed: true; kind: "local-desktop" | "local-server" }
  | { allowed: false; kind: AgentRuntimeKind; reason: RuntimeDenialReason };

/**
 * The opt-in variable, and the only value that counts.
 *
 * A single exact string rather than a truthiness check, so that a variable
 * left as `0`, `false`, `no` or an empty string does not enable execution
 * through JavaScript's idea of truthy. It is deliberately verbose: nobody
 * sets this by accident, and anybody reading a deployment config can see what
 * it does.
 */
export const LOCAL_RUNTIME_ENV_VAR = "TABDUMP_LOCAL_AGENT_RUNTIME";
export const LOCAL_RUNTIME_ENV_VALUE = "i-am-running-tabdump-on-my-own-machine";

/**
 * Environment variables that managed platforms set on their own.
 *
 * Their presence is treated as proof of a hosted environment and **cannot be
 * overridden by the opt-in**. That ordering is the point: an operator who
 * copies the opt-in into their Vercel dashboard — the exact mistake most
 * likely to happen — still gets a refusal.
 *
 * The list is not exhaustive and cannot be. It does not need to be, because
 * it is a *veto* layered on top of a default of no, not the thing that
 * produces the no.
 */
export const HOSTED_PLATFORM_MARKERS: readonly string[] = [
  "VERCEL",
  "VERCEL_ENV",
  "NETLIFY",
  "AWS_LAMBDA_FUNCTION_NAME",
  "AWS_EXECUTION_ENV",
  "LAMBDA_TASK_ROOT",
  "FUNCTION_TARGET",
  "K_SERVICE",
  "GOOGLE_CLOUD_PROJECT",
  "DYNO",
  "RENDER",
  "RAILWAY_ENVIRONMENT",
  "FLY_APP_NAME",
  "CF_PAGES",
  "WEBSITE_INSTANCE_ID",
  "CODESPACES",
  "GITPOD_WORKSPACE_ID",
] as const;

/**
 * A read-only view of the environment.
 *
 * Taken as an argument rather than read from `process.env` inside, so the
 * decision is a pure function that tests can drive exhaustively — and so that
 * nothing in this module reaches for a global that a browser bundle might
 * shim. The single caller that supplies `process.env` lives on the server.
 */
export type RuntimeEnvironment = Readonly<Record<string, string | undefined>>;

/** Whether any managed-platform marker is set. */
export function looksHosted(env: RuntimeEnvironment): boolean {
  return HOSTED_PLATFORM_MARKERS.some((marker) => {
    const value = env[marker];
    return typeof value === "string" && value.length > 0;
  });
}

/**
 * Decides whether a **server** process may execute agents locally.
 *
 * Order matters and is deliberate:
 *
 *   1. a hosted marker vetoes, whatever else is set;
 *   2. then, and only then, the exact opt-in permits;
 *   3. anything else denies.
 */
export function decideServerRuntime(env: RuntimeEnvironment): RuntimeDecision {
  if (looksHosted(env)) {
    return { allowed: false, kind: "hosted", reason: "hosted-platform" };
  }

  if (env[LOCAL_RUNTIME_ENV_VAR] === LOCAL_RUNTIME_ENV_VALUE) {
    return { allowed: true, kind: "local-server" };
  }

  return { allowed: false, kind: "unknown", reason: "not-opted-in" };
}

/**
 * The decision for a context that is not a server at all.
 *
 * A browser bundle, a static export, a prerender. There is no environment to
 * consult and no process to execute in, so the answer is a flat no — and it
 * is a *distinct* reason, so a UI can say "this build cannot run agents"
 * rather than "you have not configured it".
 */
export function denyNonServerRuntime(): RuntimeDecision {
  return { allowed: false, kind: "unknown", reason: "no-server-context" };
}

/**
 * The decision for the desktop shell.
 *
 * Takes an explicit assertion from the shell rather than sniffing for one.
 * The Tauri side knows it is Tauri; this function exists so that the *shape*
 * of the answer is the same on both paths, not so that the web bundle can
 * claim to be desktop. The caller is the desktop adapter, and
 * `security.test.ts` asserts no other module calls it.
 */
export function allowDesktopRuntime(): RuntimeDecision {
  return { allowed: true, kind: "local-desktop" };
}

export const RUNTIME_DENIAL_MESSAGES: Record<RuntimeDenialReason, string> = {
  "not-opted-in":
    "This TabDump server is not configured to run agents on this machine.",
  "hosted-platform":
    "Agents cannot run on a hosted TabDump deployment. Run TabDump on your own machine.",
  "no-server-context":
    "This build of TabDump cannot run agents.",
};

/** The sentence a UI shows for a refusal. Never interpolates anything from a request. */
export function describeRuntimeDenial(decision: RuntimeDecision): string | null {
  return decision.allowed ? null : RUNTIME_DENIAL_MESSAGES[decision.reason];
}
