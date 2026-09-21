import "server-only";
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter";
import { createSdkClaudeRuntime } from "@/lib/agents/control/providers/claude-code/sdk-runtime";
import { assertLocalExecutionAllowed } from "./gate";
import { createRuntimeHost } from "./host";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { AgentControlAdapter } from "@/lib/agents/control/types";
import type { RuntimeHost } from "./host";

/**
 * The process's one runtime host, and everything that makes it real.
 *
 * ## Why this module is separate from ./host.ts
 *
 * `host.ts` is pure: it takes a gate decision, an adapter resolver and a
 * clock, and it can be driven exhaustively by tests with none of those being
 * real. This module is where the real ones are supplied — the actual
 * environment, the actual SDK-backed Claude runtime — and it is `server-only`
 * for that reason. The split is what lets the whole runtime be tested without
 * a Claude installation, without authentication, and without the possibility
 * that a test accidentally starts a process.
 *
 * ## The gate is read exactly once, here
 *
 * `process.env` is consulted on the first call and never again. That is the
 * single place in TabDump where the real environment meets the execution
 * decision, and `security.test.ts` asserts that no other module reads it for
 * this purpose. A decision taken once, at module scope, cannot be influenced
 * by a request — which is the entire point of taking it here rather than per
 * command.
 *
 * ## Why the adapter is built lazily and shared
 *
 * One Claude adapter per process, not per request: it owns the live provider
 * sessions, and a fresh one per request would be a fresh process per request
 * with no conversation between them. It is built on first use rather than at
 * import, so that a hosted deployment — which will never pass the gate — does
 * not construct a provider runtime merely to refuse.
 */

let host: RuntimeHost | undefined;
let claude: AgentControlAdapter | undefined;

/** Providers this runtime reports on. Codex is absent because no Codex adapter exists in this tree. */
const REPORTED_PROVIDERS: readonly AgentProviderId[] = ["claude-code"];

/**
 * The Claude control adapter, built once.
 *
 * `connect()` is fired and not awaited: it only settles the adapter's
 * reported connection status, and a status of `connecting` is the honest
 * answer while it does. Awaiting it here would make the first command of
 * every cold process wait on a module load it does not need.
 */
function claudeAdapter(): AgentControlAdapter {
  if (claude) return claude;

  claude = createClaudeCodeControlAdapter({ runtime: createSdkClaudeRuntime() });
  void claude.connect();
  return claude;
}

function resolveAdapter(provider: AgentProviderId): AgentControlAdapter | undefined {
  // An explicit switch rather than a registry lookup, because this is the
  // list of providers this *process* may execute, and it should be readable
  // as such. A provider absent here cannot be driven however it is
  // registered for observation.
  return provider === "claude-code" ? claudeAdapter() : undefined;
}

/**
 * The process's runtime host.
 *
 * Built on first call. A refused gate still produces a host — one that
 * answers `get_status` truthfully and refuses everything else — because a UI
 * that cannot ask "why not" can only show a blank screen.
 */
export function getRuntimeHost(): RuntimeHost {
  if (host) return host;

  const gate = assertLocalExecutionAllowed(process.env);

  host = createRuntimeHost({
    gate,
    // A refused gate never reaches an adapter — the host checks before
    // dispatching — but the resolver is withheld as well, so a hosted process
    // has no path that could construct a provider runtime at all.
    resolveAdapter: gate.allowed ? resolveAdapter : () => undefined,
    providers: REPORTED_PROVIDERS,
  });

  registerShutdown();
  return host;
}

/** Whether a host has been built. For a caller that wants to avoid building one. */
export function hasRuntimeHost(): boolean {
  return host !== undefined;
}

/**
 * Releases the host and every provider process it holds.
 *
 * Exported so a test, or a shutdown path, can tear down deterministically.
 * Idempotent.
 */
export async function disposeRuntimeHost(): Promise<void> {
  const current = host;
  host = undefined;

  if (current) await current.dispose();

  // The adapter outlives the host by design — it is shared, and disposing it
  // is what actually releases the provider processes, so it happens last and
  // only when the host is going.
  claude?.dispose();
  claude = undefined;
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
