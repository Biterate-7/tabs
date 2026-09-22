import "server-only";
import { decideRemoteRuntime } from "@/lib/agents/control/runtime";
import { createVercelSandboxService } from "./sandbox-vercel";
import { createPostgresRemoteStore } from "./store-postgres";
import type { RemoteProjectServices } from "./projects";

/**
 * The remote plane's infrastructure, resolved once per process.
 *
 * ## Why this is not folded into `runtime/server.ts`
 *
 * Because two callers need it and they need different things. The runtime
 * host needs a store *and* a gate decision, and it needs them arranged into
 * an adapter bound to one actor. The remote-projects route needs a store and
 * a sandbox service, and no host at all — a project can be created before any
 * session exists, and building a runtime host to do it would construct a
 * provider adapter for no reason.
 *
 * Sharing the construction rather than the arrangement keeps both honest and
 * avoids a second place where "is remote execution configured?" gets decided.
 *
 * ## Fail closed
 *
 * Returns `undefined` when the remote plane is not configured — no sandbox
 * credential, or no durable store. The route reports that as a 503 with a
 * sentence an operator can act on, rather than creating a sandbox it would
 * immediately lose track of.
 */

let resolved: Promise<RemoteProjectServices | undefined> | undefined;

export async function getRemoteServices(): Promise<RemoteProjectServices | undefined> {
  resolved ??= (async () => {
    const store = await createPostgresRemoteStore().catch(() => undefined);

    // The same decision the gate takes, from the same inputs. Asked here
    // rather than re-derived, so a deployment cannot be "remote enough" to
    // create projects and not remote enough to run them.
    const decision = decideRemoteRuntime(process.env, { durableStore: store !== undefined });
    if (!decision.allowed || !store) return undefined;

    return { store, sandbox: createVercelSandboxService() };
  })().catch((error) => {
    // Not cached: the next request gets a fresh attempt rather than inheriting
    // one bad startup forever.
    resolved = undefined;
    throw error;
  });

  return resolved;
}

/** Forgets the cached services. For tests, and for a deterministic shutdown. */
export function resetRemoteServices(): void {
  resolved = undefined;
}
