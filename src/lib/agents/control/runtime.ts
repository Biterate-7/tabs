/**
 * The execution boundary.
 *
 * ## The question this module answers
 *
 * "May this process start an agent, and *whose* filesystem would it touch?"
 *
 * It is the most consequential question in the control plane, because the
 * same TabDump frontend is served from a user's own machine *and* from a
 * hosted deployment. On the user's machine, running an agent against their
 * project is the product. On a hosted deployment, running an agent against
 * *the server's* filesystem — on behalf of any visitor who loads the page —
 * is a remote code execution hole with a friendly UI.
 *
 * ## Two planes, two decisions, one default of no
 *
 * Phase I adds a second execution plane, and the thing to understand about
 * it is that it did **not** weaken the first. `decideServerRuntime` below is
 * byte for byte the function it always was: a hosted marker still vetoes,
 * the opt-in still cannot override that veto, and a hosted deployment still
 * has no path whatsoever to the machine the browser is running on.
 *
 * What is new is `decideRemoteRuntime`, which answers a *different* question
 * — "can this process reach an isolated sandbox that is nobody's computer?"
 * — and whose yes authorizes something categorically different: execution
 * against a workspace that TabDump created, inside a microVM, with no route
 * to the host application's filesystem and none at all to the user's.
 *
 * The two never substitute for one another. `gate.ts` asks for local first
 * and remote second, and a refusal of one is never a reason to try the other
 * on a caller's behalf: a session is started in the environment the gate
 * settled, and there is deliberately no fallback edge between them.
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
  /**
   * An isolated remote sandbox this process can reach.
   *
   * Emphatically not a *local* kind. Nothing about this authorizes touching
   * the filesystem of the process that decided it, and nothing about it
   * authorizes touching the user's machine. It authorizes driving an agent
   * inside a microVM whose entire filesystem TabDump created.
   */
  | "remote-sandbox"
  /** A managed hosting platform. Never permitted to execute locally. */
  | "hosted"
  /** Could not be established. Treated exactly as `hosted`. */
  | "unknown";

/**
 * Which plane an allowed decision authorizes.
 *
 * The distinction a user is owed: "this agent is editing files on your
 * laptop" and "this agent is editing files in a container we made for you"
 * are different products, and a UI that said only *running* would be
 * concealing the one fact that decides whether the blast radius includes
 * their home directory.
 */
export type ExecutionEnvironment = "local" | "remote";

export function executionEnvironmentOf(kind: AgentRuntimeKind): ExecutionEnvironment | null {
  switch (kind) {
    case "local-desktop":
    case "local-server":
      return "local";
    case "remote-sandbox":
      return "remote";
    case "hosted":
    case "unknown":
      return null;
  }
}

/** Why local execution was refused. Every value is a reason to say no. */
export type RuntimeDenialReason =
  /** The opt-in was absent or not the exact expected value. */
  | "not-opted-in"
  /** A hosted-platform marker was present. The opt-in cannot override this. */
  | "hosted-platform"
  /** The question was asked somewhere it cannot be answered — a browser, a build step. */
  | "no-server-context";

export type RuntimeDecision =
  | { allowed: true; kind: "local-desktop" | "local-server" | "remote-sandbox" }
  | { allowed: false; kind: AgentRuntimeKind; reason: RuntimeDenialReason };

/**
 * Why the remote plane was refused.
 *
 * Separate from `RuntimeDenialReason` rather than folded into it, because
 * every value there is a statement about *this machine* and every value here
 * is a statement about *infrastructure*. Collapsing them would produce the
 * one failure the brief forbids by name: a deployment with no sandbox
 * credentials telling the user their agent is unavailable in the same words
 * as a laptop that never opted in.
 */
export type RemoteDenialReason =
  /** No Vercel Sandbox credentials — neither an OIDC token nor the access-token trio. */
  | "no-sandbox-credentials"
  /**
   * No durable store.
   *
   * A serverless control plane holds nothing between requests, so a remote
   * session with nowhere to record its sandbox identity is a sandbox that
   * would be created, used once and then leaked — unreachable, unstoppable
   * and still billing. Refusing is the only honest answer.
   */
  | "no-durable-store"
  /** Asked somewhere with no server environment at all — a browser, a static export. */
  | "no-server-context";

export type RemoteRuntimeDecision =
  | { allowed: true; credentials: SandboxCredentialKind }
  | { allowed: false; reason: RemoteDenialReason };

/** How this process proves to the sandbox platform that it is the deployment it claims to be. */
export type SandboxCredentialKind = "oidc" | "access-token";

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

/* ------------------------------------------------------------------ *
 * The remote plane
 * ------------------------------------------------------------------ */

/**
 * The token a Vercel deployment is handed for its own identity.
 *
 * Short-lived, rotated by the platform, and scoped to the project. Its
 * presence is the signal that this process can address the sandbox API as
 * itself — which is why it is *checked* here and never read: this module
 * decides, and the value belongs to the SDK that uses it.
 */
export const SANDBOX_OIDC_ENV_VAR = "VERCEL_OIDC_TOKEN";

/**
 * The off-platform alternative, which is all-or-nothing.
 *
 * Two of the three is not a partial credential, it is a misconfiguration, and
 * treating it as one avoids the failure where a deployment appears to offer
 * remote execution and then fails at the first sandbox create.
 */
export const SANDBOX_ACCESS_TOKEN_ENV_VARS: readonly string[] = [
  "VERCEL_TEAM_ID",
  "VERCEL_PROJECT_ID",
  "VERCEL_TOKEN",
] as const;

function isSet(env: RuntimeEnvironment, name: string): boolean {
  const value = env[name];
  return typeof value === "string" && value.trim().length > 0;
}

/**
 * Which sandbox credential this environment carries, if any.
 *
 * OIDC first, because on the platform it is the one that is rotated for you
 * and the one that cannot be copied into a repository. An access token is the
 * fallback for a deployment that is not on Vercel at all.
 */
export function sandboxCredentialKind(
  env: RuntimeEnvironment
): SandboxCredentialKind | null {
  if (isSet(env, SANDBOX_OIDC_ENV_VAR)) return "oidc";
  if (SANDBOX_ACCESS_TOKEN_ENV_VARS.every((name) => isSet(env, name))) return "access-token";
  return null;
}

export type RemoteRuntimeInput = {
  /**
   * Whether a durable store is configured and reachable.
   *
   * Passed in rather than detected, for the same reason the environment is:
   * this module must stay pure and importable from anywhere, and the module
   * that knows about Postgres is `server-only`. It is a *fact about
   * infrastructure* supplied by the one caller that has a server context.
   */
  durableStore: boolean;
};

/**
 * Decides whether this process may drive agents inside an isolated sandbox.
 *
 * ## What is deliberately absent, and why it is not an oversight
 *
 * There is **no hosted-platform veto here**, and that is the entire
 * distinction between this function and `decideServerRuntime`. The veto up
 * there exists because a hosted process executing *locally* would be running
 * an agent on the server's own filesystem on behalf of any visitor. That
 * hazard does not exist on this path: the execution target is a microVM with
 * no route to this process's filesystem, created per project, owned by one
 * account and destroyed on a timer.
 *
 * Being hosted is therefore not a reason to refuse here. It is, in fact, the
 * normal case — this plane exists precisely so that a deployment which can
 * never touch anybody's computer can still run a real agent.
 *
 * ## What is required
 *
 * Both, and neither is inferred:
 *
 *   1. **A sandbox credential.** Without one there is no plane to execute on.
 *   2. **A durable store.** Without one a sandbox could be created and then
 *      lost, which is worse than not creating it.
 *
 * `NODE_ENV` appears nowhere. A production build is not a statement about
 * whether this deployment has been given the infrastructure to run agents,
 * and `security.test.ts` asserts that this module never consults it.
 */
export function decideRemoteRuntime(
  env: RuntimeEnvironment,
  input: RemoteRuntimeInput
): RemoteRuntimeDecision {
  const credentials = sandboxCredentialKind(env);
  if (!credentials) return { allowed: false, reason: "no-sandbox-credentials" };
  if (!input.durableStore) return { allowed: false, reason: "no-durable-store" };
  return { allowed: true, credentials };
}

/**
 * The remote plane's decision, in the shape the control service consumes.
 *
 * A separate function from `decideRemoteRuntime` so that minting an
 * *allowing* `RuntimeDecision` takes a deliberate call, exactly as
 * `allowDesktopRuntime` does. The guard suite asserts that only `gate.ts`
 * calls it, which is what stops an adapter or a route from deciding on its
 * own that it is running remotely.
 */
export function allowRemoteRuntime(): RuntimeDecision {
  return { allowed: true, kind: "remote-sandbox" };
}

/** The refusal, in the same shape. `reason` is carried separately; see `REMOTE_DENIAL_MESSAGES`. */
export function denyRemoteRuntime(reason: RemoteDenialReason): RuntimeDecision {
  return {
    allowed: false,
    // A remote refusal is not a statement that this is a hosted platform —
    // it very often *is* one, and saying so would answer a question the user
    // did not ask while concealing the one they did.
    kind: "unknown",
    // Mapped onto the local vocabulary only so the shape stays uniform. The
    // sentence a user reads comes from `REMOTE_DENIAL_MESSAGES`, keyed by the
    // remote reason, which is why nothing is lost in this narrowing.
    reason: reason === "no-server-context" ? "no-server-context" : "not-opted-in",
  };
}

export const REMOTE_DENIAL_MESSAGES: Record<RemoteDenialReason, string> = {
  "no-sandbox-credentials":
    "This TabDump deployment is not configured to run agents in a remote sandbox.",
  "no-durable-store":
    "Remote agents need a database. This TabDump deployment does not have one configured.",
  "no-server-context": "This build of TabDump cannot run agents.",
};

export function describeRemoteDenial(decision: RemoteRuntimeDecision): string | null {
  return decision.allowed ? null : REMOTE_DENIAL_MESSAGES[decision.reason];
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
