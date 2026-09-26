import "server-only";
import { getSession } from "@/lib/auth/session";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { LOCAL_ACTOR } from "@/lib/agents/runtime/host";
import { getRuntimeHost } from "@/lib/agents/runtime/server";
import { isHandshakeCommand, parseRuntimeRequest, runtimeFailure } from "@/lib/agents/runtime/protocol";
import type { RuntimeActor } from "@/lib/agents/runtime/host";

export const runtime = "nodejs";

/**
 * The local execution surface.
 *
 * ## Why this is the transport
 *
 * Hubble's desktop shell is a **static export** loaded from
 * `tauri://localhost` (see next.config.ts): `pageExtensions: ["tsx"]` drops
 * every `route.ts` from the desktop route tree, so this file does not exist
 * in the packaged app at all. The transport that *does* exist in every
 * context where agents can legitimately run — `npm run dev`, a self-hosted
 * `next start` on the user's own machine — is a Next route handler on the
 * Node runtime, which is also what the existing local Claude Code
 * *observation* endpoint already is.
 *
 * So this is a route rather than a Tauri command, and that is a decision
 * about what the architecture actually is rather than a preference. Adding a
 * Rust command would mean either reimplementing the control plane in Rust or
 * having Tauri spawn a Node process to host it — a second runtime, a second
 * lifecycle and a second place for the trust boundary to be wrong. The
 * honest consequence is recorded rather than papered over: **the packaged
 * desktop build has no local execution surface**, `get_status` is
 * unreachable there, and the client reports `runtime_disconnected`. See
 * docs/agent-local-runtime.md.
 *
 * ## What this handler is allowed to do
 *
 * Parse, identify, delegate. It contains no control logic, no provider
 * knowledge, no path handling and no permission decision — every one of those
 * belongs to the host, which re-derives them from its own state. What this
 * file adds is the three things only a request can answer:
 *
 *   1. **Is this request from this origin?** The cross-site case is the one
 *      real browser-borne threat against a localhost server: a page the user
 *      visits could otherwise `fetch` here. Same-origin plus a required JSON
 *      content type is what the auth routes already use, and for the same
 *      reason — a cross-site form or image post cannot set the content type
 *      without a preflight that nothing here answers.
 *   2. **Who is asking?** The signed-in account when the deployment has
 *      accounts; the anonymous local actor when it does not. Never anything
 *      out of the body.
 *   3. **Is this the runtime they think it is?** A generation check, not an
 *      authenticator. See the note on `runtimeId` in ../../../lib/agents/runtime/protocol.ts.
 *
 * ## What it never exposes
 *
 * There is one endpoint and it takes one command from a closed union. There
 * is no path parameter, no command string, no shell, no filesystem verb, and
 * no way to name a provider option. A body that does not parse into a
 * `RuntimeCommand` is refused before anything else happens, and the refusal
 * says only that it did not parse.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) {
    // Deliberately the same refusal a malformed body gets. A probe learns
    // that this endpoint exists and nothing about why it said no.
    return Response.json(runtimeFailure("invalid_request"), { status: 403 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(runtimeFailure("invalid_request"), { status: 400 });
  }

  const parsed = parseRuntimeRequest(body);
  if (!parsed) return Response.json(runtimeFailure("invalid_request"), { status: 400 });

  // Identified before the host is built, and that ordering is now
  // load-bearing rather than incidental. A remote host is constructed *for*
  // an actor: its adapter is bound to a store view that can only see that
  // account's sandboxes. Building one before knowing who is asking would mean
  // a host that had to be told later, which is the shape where one account's
  // request reaches another's session.
  const actor = await resolveActor(request);
  const host = await getRuntimeHost(actor);

  // The generation check. A client carrying an id from a previous process is
  // told so rather than silently served by a host that holds none of its
  // sessions — which would look, from the UI, like every session vanishing.
  if (!isHandshakeCommand(parsed.command.name) && parsed.runtimeId !== host.runtimeId) {
    return Response.json(runtimeFailure("runtime_disconnected"), { status: 409 });
  }

  const result = await host.execute(actor, parsed.command);

  // Always 200 for a well-formed command, whatever the host decided. The
  // result carries the outcome, and a caller has one shape to read rather
  // than a status code to interpret alongside it.
  return Response.json(result);
}

/**
 * Who this request is from.
 *
 * On a deployment with accounts, the signed-in user — so one account's
 * sessions are invisible to another signed into the same browser, exactly as
 * their workspaces already are. On a Hubble with no accounts configured, the
 * anonymous local actor, which is the honest answer: there is one user of a
 * local runtime and it is whoever is at the machine.
 *
 * Note what is absent: any reading of the body. A command cannot name its own
 * actor, which is why `RuntimeCommand` has no field for one.
 */
async function resolveActor(request: Request): Promise<RuntimeActor> {
  const session = await getSession(request);
  return session.ok ? { id: `account:${session.auth.user.id}` } : LOCAL_ACTOR;
}
