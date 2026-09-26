import "server-only";
import { getSession } from "@/lib/auth/session";
import { decideServerRuntime } from "@/lib/agents/control/runtime";
import { LOCAL_ACTOR } from "./host";
import type { RuntimeEnvironment } from "@/lib/agents/control/runtime";
import type { RuntimeActor } from "./host";

/**
 * Who an agent request is from — or `null`, meaning refuse it.
 *
 * The signed-in account, whenever there is one. Without a session, the
 * anonymous `LOCAL_ACTOR` exists only where the local gate says this process
 * is somebody's own opted-in machine, and nowhere else.
 *
 * ## Why the anonymous actor is gated
 *
 * `LOCAL_ACTOR` is one fixed id. On a machine with one person at it, that is
 * the right model. On a hosted deployment it made every unauthenticated
 * visitor the *same* owner: all of them could create sandboxes billed to the
 * deployment, and a key one of them connected was used for sessions any other
 * could start. Phase I.3 found that on the live Production deployment.
 *
 * Applied to the two routes that *create* things — provider connections and
 * remote projects. The control route keeps answering anonymously on purpose:
 * its handshake is how a signed-out Command Centre learns it cannot run
 * agents, and with no credential and no project creatable for the anonymous
 * owner, there is nothing a session could start with.
 *
 * `decideServerRuntime` is asked rather than a narrower "is this hosted?"
 * check so that an unrecognised server — self-hosted, no platform markers —
 * falls on the refusing side too. Anonymous access is something an operator
 * turns on by opting into local execution, never a default.
 *
 * The environment is a parameter, never read here: `runtime/server.ts` is the
 * one module in this layer that reads the real one, and the calling route
 * passes it. Never read from the body: a request cannot name its own owner.
 */
export async function resolveRequestActor(
  request: Request,
  env: RuntimeEnvironment
): Promise<RuntimeActor | null> {
  const session = await getSession(request);
  if (session.ok) return { id: `account:${session.auth.user.id}` };
  return decideServerRuntime(env).allowed ? LOCAL_ACTOR : null;
}
