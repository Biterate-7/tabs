import "server-only";
import { createAcpControlAdapter } from "@/lib/agents/control/providers/acp/adapter";
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter";
import { ACP_PROVIDERS, launchEntryFor } from "@/lib/agents/launch/allowlist";
import { createMcpLinker } from "@/lib/agents/launch/mcp-link";
import { createAcpProcessLauncher, detectLocalProviders } from "@/lib/agents/launch/process";
import { getMcpTokenStore } from "@/lib/mcp/tokens-postgres";
import { createRemoteClaudeRuntime } from "@/lib/agents/control/providers/claude-code/remote-runtime";
import { createSdkClaudeRuntime } from "@/lib/agents/control/providers/claude-code/sdk-runtime";
import { createRemoteBindings } from "@/lib/agents/remote/bindings";
import { hasPlatformOidcToken } from "@/lib/agents/remote/platform-identity";
import { createVercelSandboxService } from "@/lib/agents/remote/sandbox-vercel";
import { createPostgresRemoteStore } from "@/lib/agents/remote/store-postgres";
import { resolveProviderCredential } from "@/lib/agents/credentials/server";
import { assertExecutionAllowed, denyRemoteExecution } from "./gate";
import { createRuntimeHost } from "./host";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { ClaudeCredentialSource } from "@/lib/agents/control/providers/claude-code/runtime";
import type { AgentControlAdapter } from "@/lib/agents/control/types";
import type { AcpMcpLinker } from "@/lib/agents/control/providers/acp/launcher";
import type { ProviderDetection } from "./protocol";
import type { RemoteSandboxService } from "@/lib/agents/remote/sandbox";
import type { RemoteStore } from "@/lib/agents/remote/store";
import type { ExecutionGateResult } from "./gate";
import type { RuntimeActor, RuntimeHost } from "./host";

/**
 * The process's runtime host, and everything that makes it real.
 *
 * ## Why this module is separate from ./host.ts
 *
 * `host.ts` is pure: it takes a gate decision, an adapter resolver and a
 * clock, and it can be driven exhaustively by tests with none of those being
 * real. This module is where the real ones are supplied — the actual
 * environment, the actual SDK-backed Claude runtime, the actual sandbox
 * platform and the actual database — and it is `server-only` for that reason.
 * The split is what lets the whole runtime be tested without a Claude
 * installation, without a cloud account, without a database, and without the
 * possibility that a test accidentally starts a process or spends money.
 *
 * ## The gate is read exactly once, here
 *
 * `process.env` is consulted on the first call and never again. That is the
 * single place in TabDump where the real environment meets the execution
 * decision, and `security.test.ts` asserts that no other module reads it for
 * this purpose. A decision taken once cannot be influenced by a request.
 *
 * ## Two shapes of host, because there are two shapes of deployment
 *
 * **Local** is what it always was: one host for the process, built on first
 * use, holding live sessions in memory because the process outlives the
 * requests made to it. Nothing about that path has changed.
 *
 * **Remote** is built per request and bound to one actor. Two reasons, and
 * both are forced rather than chosen:
 *
 *   - a serverless instance holds no useful state between requests anyway, so
 *     a cached host would be a cache that is always cold;
 *   - the remote runtime is constructed *with* an owner id, which is what
 *     makes cross-account access structurally impossible rather than merely
 *     checked. One host per actor means account A's adapter was built with a
 *     store view that can only see account A's sandboxes, and there is no
 *     argument any request can carry that changes it.
 */

/** Providers this runtime reports on. A provider joins when it has a runtime, not when it has a name. */
const REPORTED_PROVIDERS: readonly AgentProviderId[] = ["claude-code"];

/**
 * A local runtime also drives every ACP agent in the launch allowlist
 * (Phase J). Remote does not: the ACP agents run on the user's own machine,
 * with the user's own native sign-in, and a sandbox has neither.
 */
const LOCAL_REPORTED_PROVIDERS: readonly AgentProviderId[] = [...REPORTED_PROVIDERS, ...ACP_PROVIDERS];

/* ------------------------------------------------------------------ *
 * The decision
 * ------------------------------------------------------------------ */

/**
 * What this process resolved to, as a closed union.
 *
 * ## Why a union rather than a gate plus two optional fields
 *
 * The earlier shape was `{ gate, store?, sandbox? }`, and the remote branch
 * read `gate.allowed && gate.environment === "remote" && store && sandbox`.
 * Every one of those conjuncts was true in practice — but the *shape* allowed
 * a fourth state nobody wanted: an allowing remote gate with no
 * infrastructure. A caller that hit it fell through to the local branch and
 * built a host carrying that same allowing gate, which then reported
 * `executable: true` while holding a resolver that returns `undefined` for
 * every provider.
 *
 * That is the precise failure mode the whole phase is meant to preclude: a
 * runtime saying `REMOTE · Ready` and refusing every command. It was
 * unreachable by argument, and an argument is the wrong thing to be relying on
 * here.
 *
 * So the union makes it unrepresentable. `mode: "remote"` *carries* the store
 * and the sandbox, so the remote branch cannot be entered without them and
 * there is no `&&` chain whose failure has somewhere to fall through to.
 * Anything that is not a working remote plane is `refused`, with a gate that
 * says `executable: false` — which is the honest answer and the only safe one.
 */
type Resolved =
  | {
      mode: "remote";
      gate: ExecutionGateResult;
      store: RemoteStore;
      sandbox: RemoteSandboxService;
    }
  | { mode: "local"; gate: ExecutionGateResult }
  | { mode: "refused"; gate: ExecutionGateResult };

let resolved: Promise<Resolved> | undefined;

/**
 * The gate, plus the infrastructure it decided about.
 *
 * Cached as a *promise* rather than as the resolved value, for the same
 * reason the auth pool is: two concurrent cold requests would otherwise both
 * find the cache empty, both await the store construction, and both build one.
 *
 * The store is constructed *before* the gate is taken, because whether one
 * exists is an input to the decision. A deployment with sandbox credentials
 * and no database is refused with `no-durable-store`, which is a sentence an
 * operator can act on — rather than being allowed to create sandboxes it
 * would immediately lose track of.
 *
 * ## The second check, after the decision
 *
 * The gate reasons from the environment, which is all it can see. Building the
 * platform client can still fail — a package that will not load, a credential
 * the platform rejects — and that is something only this function learns. When
 * it does, the decision is **downgraded to a refusal** rather than carried
 * forward with a missing piece. Never a fallback to local: a deployment that
 * cannot reach a sandbox has not thereby earned the right to touch a
 * filesystem.
 */
async function resolveRuntime(): Promise<Resolved> {
  resolved ??= (async () => {
    const store = await createPostgresRemoteStore().catch(() => undefined);
    const gate = assertExecutionAllowed(process.env, {
      durableStore: store !== undefined,
      platformOidc: hasPlatformOidcToken(),
    });

    if (!gate.allowed) return { mode: "refused" as const, gate };
    if (gate.environment === "local") return { mode: "local" as const, gate };

    // Remote was decided. Now prove the infrastructure is actually there.
    if (!store) return { mode: "refused" as const, gate: denyRemoteExecution("no-durable-store") };

    const sandbox = createVercelSandboxService();
    if (!(await sandbox.isAvailable())) {
      // The platform client would not load, or this process cannot address it.
      // `no-sandbox-credentials` is the sentence that sends an operator to the
      // right half of the configuration.
      return { mode: "refused" as const, gate: denyRemoteExecution("no-sandbox-credentials") };
    }

    return { mode: "remote" as const, gate, store, sandbox };
  })().catch((error) => {
    // A failed construction is not cached: the next request gets a fresh
    // attempt rather than inheriting one bad startup forever.
    resolved = undefined;
    throw error;
  });

  return resolved;
}

/* ------------------------------------------------------------------ *
 * Local
 * ------------------------------------------------------------------ */

let localHost: RuntimeHost | undefined;

/**
 * One local Claude adapter per actor.
 *
 * ## Why this is no longer a single adapter
 *
 * It was, until provider credentials became per-user. An adapter now holds a
 * `ClaudeCredentialSource` closed over one owner, so a shared adapter would
 * be an adapter holding one user's credential resolver and handing it to
 * every session on the process. On a developer's own machine there is one
 * actor and the map has one entry; on a local server with accounts there are
 * several, and they are structurally separate rather than separated by a
 * check.
 *
 * Keyed by actor id and cached, because a local adapter owns child processes:
 * building a second one for the same actor would orphan the first one's
 * sessions. The map is cleared by `disposeRuntimeHost`.
 */
const localClaudeByActor = new Map<string, AgentControlAdapter>();

/**
 * This actor's credential, resolved fresh on every call.
 *
 * Deliberately a closure over `ownerId` rather than a parameter the runtime
 * passes: a runtime cannot ask for a credential it was not built to resolve,
 * so there is no argument any request could carry that would reach another
 * account's key.
 *
 * Resolved per `start()` rather than once, so revoking a connection stops the
 * next session rather than the next deployment.
 */
function credentialSourceFor(ownerId: string): ClaudeCredentialSource {
  return async () => {
    const resolution = await resolveProviderCredential(ownerId, "claude-code");
    // Restated into the provider seam's own vocabulary. The seam does not
    // import the credential domain — see the note on `ClaudeCredentialResolution`
    // — so this is the one adaptation point, and it carries the connection id
    // and the environment and nothing else.
    if (!resolution.ok) return { ok: false, reason: resolution.reason };
    return {
      ok: true,
      connectionId: resolution.credential.connectionId,
      env: resolution.credential.env,
    };
  };
}

/**
 * The local Claude control adapter for one actor, built once.
 *
 * `connect()` is fired and not awaited: it only settles the adapter's
 * reported connection status, and `connecting` is the honest answer while it
 * does. Awaiting it would make the first command of every cold process wait
 * on a module load it does not need.
 */
function localAdapter(ownerId: string): AgentControlAdapter {
  const existing = localClaudeByActor.get(ownerId);
  if (existing) return existing;

  const adapter = createClaudeCodeControlAdapter({
    runtime: createSdkClaudeRuntime({ credentials: credentialSourceFor(ownerId) }),
  });
  localClaudeByActor.set(ownerId, adapter);
  void adapter.connect();
  return adapter;
}

/* ------------------------------------------------------------------ *
 * Local ACP agents (Phase J)
 * ------------------------------------------------------------------ */

/**
 * One ACP adapter per provider per actor, for the same reason there is one
 * Claude adapter per actor: an adapter owns child processes, and a second one
 * for the same pair would orphan the first one's sessions.
 *
 * Deliberately **not** connected on construction. Connecting starts the
 * agent's process to learn how it signs in, and that happens when the user
 * presses Connect — never because a status request happened to list it.
 */
const localAcpByActor = new Map<string, AgentControlAdapter>();

const ACP_AGENT_NAMES: Partial<Record<AgentProviderId, string>> = {
  gemini: "Gemini CLI",
  grok: "Grok Build",
  "openai-codex": "Codex",
};

/**
 * TabDump's own MCP endpoint on this machine, for per-session links.
 *
 * Built from this process's own configuration, never from a request header:
 * a `Host` header is chosen by the caller, and a link built from one would
 * send a session's token to wherever the caller said.
 */
function localMcpUrl(): string {
  const explicit = process.env.TABDUMP_MCP_LOCAL_URL;
  if (explicit && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/api\/mcp$/.test(explicit)) return explicit;
  const port = /^\d{2,5}$/.test(process.env.PORT ?? "") ? process.env.PORT : "3000";
  return `http://127.0.0.1:${port}/api/mcp`;
}

/**
 * A per-session TabDump MCP link for a signed-in actor, when this server has
 * the token store. Signed-out local use has no account to scope a token to,
 * so it gets no link — and the session still runs, with attached context.
 */
async function mcpLinkerFor(provider: AgentProviderId, ownerId: string) {
  if (!ownerId.startsWith("account:")) return undefined;
  const store = await getMcpTokenStore().catch(() => undefined);
  if (!store) return undefined;
  return createMcpLinker({
    store,
    url: localMcpUrl(),
    userId: ownerId.slice("account:".length),
    agentName: ACP_AGENT_NAMES[provider] ?? provider,
  });
}

function localAcpAdapter(provider: AgentProviderId, ownerId: string): AgentControlAdapter | undefined {
  const entry = launchEntryFor(provider)?.acp;
  if (!entry) return undefined;

  const key = `${provider}\u0000${ownerId}`;
  const existing = localAcpByActor.get(key);
  if (existing) return existing;

  // Resolved lazily, per session: the token store is a database connection
  // that a signed-out developer's runtime never needs to open.
  let linker: Promise<AcpMcpLinker | undefined> | undefined;
  const adapter = createAcpControlAdapter({
    provider,
    launch: createAcpProcessLauncher({ provider, env: process.env }),
    ...(entry.askingModeId ? { askingModeId: entry.askingModeId } : {}),
    mcpLink: async (request) => {
      linker ??= mcpLinkerFor(provider, ownerId);
      const resolved = await linker;
      return resolved ? resolved(request) : undefined;
    },
  });
  localAcpByActor.set(key, adapter);
  return adapter;
}

/* ------------------------------------------------------------------ *
 * Remote
 * ------------------------------------------------------------------ */

/**
 * This deployment's identity, for the client's generation check.
 *
 * ## Why this is not a fresh uuid on remote
 *
 * On a local runtime the id is per-process and that is exactly right: when
 * the process restarts, the sessions it held are genuinely gone, and a client
 * carrying the old id needs to be told rather than silently served by a host
 * holding none of its sessions.
 *
 * On a serverless deployment a fresh id per instance would mean the client is
 * told `runtime_disconnected` on almost every request, because almost every
 * request is a different instance — while the sessions it is asking about are
 * perfectly alive in a database and a set of microVMs that no instance owns.
 * So the generation is the *deployment*, which is the thing whose replacement
 * could genuinely invalidate what a client believes.
 */
function remoteRuntimeId(env: Readonly<Record<string, string | undefined>>): string {
  const stable = env.VERCEL_DEPLOYMENT_ID ?? env.VERCEL_GIT_COMMIT_SHA;
  return stable ? `remote-${stable}` : `remote-${processGeneration}`;
}

/** A last resort for a remote deployment with no platform identity. One per process. */
const processGeneration = crypto.randomUUID();

/* ------------------------------------------------------------------ *
 * The entry point
 * ------------------------------------------------------------------ */

/**
 * The runtime host for this request.
 *
 * A refused gate still produces a host — one that answers `get_status`
 * truthfully and refuses everything else — because a UI that cannot ask
 * "why not" can only show a blank screen.
 *
 * The actor is taken here rather than only at `execute` because a remote host
 * *is* the actor's: the adapter it holds was constructed against a store view
 * scoped to them. See the note at the top of this file on why that is a
 * stronger property than checking ownership afterwards.
 */
export async function getRuntimeHost(actor: RuntimeActor): Promise<RuntimeHost> {
  const resolution = await resolveRuntime();

  // An exhaustive switch over the union, so a fourth state cannot be added
  // without a type error here. There is deliberately no `default` and no
  // fallthrough: each arm builds exactly the host its mode describes, and
  // "remote but without infrastructure" is not a mode.
  switch (resolution.mode) {
    case "remote": {
      // One adapter for this request, bound to this actor. Not cached across
      // requests: it holds a live handle on one actor's sandboxes, and reusing
      // it for a different signed-in account is the one mistake this shape
      // makes impossible.
      const adapter = createClaudeCodeControlAdapter({
        runtime: createRemoteClaudeRuntime({
          sandbox: resolution.sandbox,
          store: resolution.store,
          ownerId: actor.id,
          // The same actor the store view is scoped to. One owner id, used
          // for both, so a sandbox this runtime can reach and a credential it
          // can resolve always belong to the same person.
          credentials: credentialSourceFor(actor.id),
        }),
      });
      void adapter.connect();

      return createRuntimeHost({
        gate: resolution.gate,
        resolveAdapter: (provider) => (provider === "claude-code" ? adapter : undefined),
        remote: createRemoteBindings({ store: resolution.store }),
        providers: REPORTED_PROVIDERS,
        runtimeId: remoteRuntimeId(process.env),
      });
    }

    case "local":
      // The resolver is consulted per command, with the owner the host
      // already knows, so one cached host serves every actor while each
      // still gets their own adapter and their own credential.
      return localHostWith(
        resolution.gate,
        (provider, ownerId) =>
          provider === "claude-code" ? localAdapter(ownerId) : localAcpAdapter(provider, ownerId),
        { providers: LOCAL_REPORTED_PROVIDERS, detect: () => detectLocalProviders(process.env) }
      );

    case "refused":
      // The resolver is withheld as well as the gate being refused. The host
      // checks before dispatching anyway, so this is belt and braces — but it
      // means a process that may not execute has no code path that could
      // construct a provider runtime at all.
      return localHostWith(resolution.gate, () => undefined);
  }
}

/**
 * The process's single non-remote host.
 *
 * Shared by the `local` and `refused` arms because both are per-process rather
 * than per-actor: neither holds anything scoped to one account. The gate they
 * carry is what differs, and it is what decides whether the resolver is ever
 * consulted.
 */
function localHostWith(
  gate: ExecutionGateResult,
  resolveAdapter: (provider: AgentProviderId, ownerId: string) => AgentControlAdapter | undefined,
  local?: { providers: readonly AgentProviderId[]; detect: () => readonly ProviderDetection[] }
): RuntimeHost {
  if (localHost) return localHost;

  localHost = createRuntimeHost({
    gate,
    resolveAdapter,
    providers: local?.providers ?? REPORTED_PROVIDERS,
    // Only a local runtime can say what is installed on the user's machine.
    ...(local ? { detect: local.detect } : {}),
  });
  registerShutdown();
  return localHost;
}

/** Whether a local host has been built. For a caller that wants to avoid building one. */
export function hasRuntimeHost(): boolean {
  return localHost !== undefined;
}

/**
 * Releases the local host and every provider process it holds.
 *
 * Exported so a test, or a shutdown path, can tear down deterministically.
 * Idempotent.
 *
 * Remote hosts are deliberately absent: they own no process, they are built
 * per request, and the thing that would need releasing — a sandbox — outlives
 * the request on purpose and is reclaimed by its own deadline.
 */
export async function disposeRuntimeHost(): Promise<void> {
  const current = localHost;
  localHost = undefined;

  // The gate goes too. It is cached against `process.env` as it was at first
  // use, so a host torn down and rebuilt inside one process — which is a test,
  // and is also a dev server reload — must re-decide rather than inherit a
  // decision taken under a different environment. Keeping it would make
  // `disposeRuntimeHost` a partial reset, which is the kind of thing that
  // makes one test's environment leak into the next one's answer.
  resolved = undefined;

  if (current) await current.dispose();

  // The adapters outlive the host by design — disposing them is what actually
  // releases the provider processes, so it happens last and only when the host
  // is going. Every actor's, not just the most recent: each holds its own
  // child processes.
  for (const adapter of localClaudeByActor.values()) adapter.dispose();
  localClaudeByActor.clear();
  for (const adapter of localAcpByActor.values()) adapter.dispose();
  localAcpByActor.clear();
}

let shutdownRegistered = false;

/**
 * Ties provider cleanup to the process ending.
 *
 * Without this, a `SIGINT` on a dev server leaves whatever Claude Code
 * processes were mid-run orphaned: the SDK spawns them as children, and a
 * parent that exits without draining its handles does not reliably take them
 * with it. Registered once, and `once` per signal so a second `SIGINT` still
 * ends the process rather than being swallowed by a handler that is already
 * awaiting.
 */
function registerShutdown(): void {
  if (shutdownRegistered) return;
  shutdownRegistered = true;

  for (const signal of ["SIGINT", "SIGTERM"] as const) {
    process.once(signal, () => {
      void disposeRuntimeHost().finally(() => {
        // Re-raise with the handler removed, so the default behaviour — and
        // the correct exit code — is what actually ends the process.
        process.kill(process.pid, signal);
      });
    });
  }

  // Covers a clean exit that never sends a signal, such as a dev server
  // reload. `beforeExit` can run more than once; `disposeRuntimeHost` is
  // idempotent, so that is safe.
  process.once("beforeExit", () => {
    void disposeRuntimeHost();
  });
}
