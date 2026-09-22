import "server-only";
import { getSession } from "@/lib/auth/session";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { LOCAL_ACTOR } from "@/lib/agents/runtime/host";
import { getCredentialInfrastructure } from "@/lib/agents/credentials/server";
import { credentialAdapterFor, credentialSupportFor } from "@/lib/agents/credentials/registry";
import { AGENT_PROVIDER_IDS } from "@/lib/agents/connectors/types";
import { isAgentProviderId, isProviderAuthMethod } from "@/lib/agents/credentials/types";
import type { RuntimeActor } from "@/lib/agents/runtime/host";
import type { ProviderAuthMethod } from "@/lib/agents/credentials/types";

export const runtime = "nodejs";

/**
 * Provider connections — the user's own AI credentials.
 *
 * ## Why this is its own route
 *
 * `/api/agents/control` carries a closed union of control verbs, none of which
 * can name a path, a command or a secret, and its guard suite asserts exactly
 * that. Connecting a credential is the one operation that has to accept a
 * secret in a request body, so it lives here rather than as a fifteenth
 * command that would have widened that union's vocabulary to include one.
 *
 * ## The four rules this handler enforces, and nothing else
 *
 *   1. **Same origin, JSON content type.** The cross-site case is the real
 *      browser-borne threat: a page the user visits could otherwise `fetch`
 *      here and rotate or delete their credential. A cross-site form cannot
 *      set `application/json` without a preflight nothing here answers.
 *   2. **Ownership comes from the session, never the body.** There is no
 *      `ownerId` field on any request shape below, so there is nothing for a
 *      caller to forge and nothing for a handler to forget to check. Every
 *      store call is scoped in its own signature.
 *   3. **The secret goes in and never comes out.** Requests carry one; no
 *      response shape can. Every response is built from
 *      `ProviderConnectionView`, which has no field a credential fits in.
 *   4. **Provider errors are normalized before they get here.** The adapter
 *      maps a status code onto a `CredentialValidationCode` and discards the
 *      body, so there is no provider string for this handler to echo.
 *
 * ## What is deliberately absent
 *
 * A `GET` that returns a secret. A "test this key" endpoint that takes a raw
 * key and reports more than a normalized code. A list endpoint that takes an
 * owner. An admin variant that skips scoping. None of them exists, which is a
 * stronger statement than each of them being guarded.
 */

/* ------------------------------------------------------------------ *
 * Failures
 * ------------------------------------------------------------------ */

/**
 * Why a request did not happen, as a closed set with fixed sentences.
 *
 * Same discipline as every other error table in this codebase: a code plus a
 * message from the table, never interpolated. `credentials-unavailable` in
 * particular must not name the environment variable that would fix it — that
 * sentence would then be renderable by anybody who opened settings on a hosted
 * deployment.
 */
const FAILURE_MESSAGES = {
  "invalid-request": "TabDump could not read that request.",
  "unknown-provider": "TabDump does not recognise that agent.",
  "unsupported-provider": "TabDump cannot hold credentials for that agent yet.",
  "not-found": "That connection no longer exists.",
  "credentials-unavailable": "This deployment cannot store provider credentials.",
} as const;

type FailureCode = keyof typeof FAILURE_MESSAGES;

function refuse(code: FailureCode, status: number): Response {
  return Response.json({ ok: false, error: { code, message: FAILURE_MESSAGES[code] } }, { status });
}

/* ------------------------------------------------------------------ *
 * GET — what this user has connected
 * ------------------------------------------------------------------ */

/**
 * Lists this user's connections.
 *
 * Never anybody else's: the store's `list` takes an owner id in its signature
 * and there is no argument this handler could pass that is not the
 * authenticated actor's.
 *
 * Also reports which providers are *connectable*, so the settings page derives
 * its cards from the registry rather than from hardcoded marketing text — §11.
 */
export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return refuse("invalid-request", 403);

  const infrastructure = await getCredentialInfrastructure();
  if (!infrastructure) return refuse("credentials-unavailable", 503);

  const actor = await resolveActor(request);
  const connections = await infrastructure.service.list(actor.id);

  return Response.json({
    ok: true,
    value: {
      connections,
      // Derived from the registry, not from a table in the UI. §11's
      // requirement is that a connector card's statuses come from actual
      // provider registration; sending the adapter's own input shape is how
      // the settings page is made incapable of describing a credential
      // mechanism differently from the code that performs it.
      //
      // Only the *shape* crosses — a label, a placeholder, a link and a
      // sentence. The adapter itself stays on the server, so `validate` is
      // never reachable from a browser and a secret has no client-side code
      // path that would send it anywhere but this route.
      connectable: connectableProviders(),
      // Whether connections survive a restart. Rendered, so a developer on a
      // memory store is not surprised when theirs is gone tomorrow.
      durable: infrastructure.durable,
    },
  });
}

/**
 * Every provider that can actually be connected, with how to ask for it.
 *
 * Providers with no credential adapter are simply absent rather than present
 * with an empty shape, so a client rendering this list cannot show a Connect
 * button for something that would refuse.
 */
function connectableProviders() {
  return AGENT_PROVIDER_IDS.flatMap((provider) => {
    const adapter = credentialAdapterFor(provider);
    if (!adapter) return [];

    const method = adapter.authMethods[0];
    if (!method) return [];

    const input = adapter.input(method);
    if (!input) return [];

    return [
      {
        provider,
        authMethods: adapter.authMethods,
        input: {
          label: input.label,
          placeholder: input.placeholder,
          issueUrl: input.issueUrl,
          explanation: input.explanation,
        },
      },
    ];
  });
}

/* ------------------------------------------------------------------ *
 * POST — connect, rotate, revalidate
 * ------------------------------------------------------------------ */

type PostBody = {
  action?: unknown;
  provider?: unknown;
  authMethod?: unknown;
  secret?: unknown;
  displayName?: unknown;
  connectionId?: unknown;
};

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) {
    return refuse("invalid-request", 403);
  }

  const infrastructure = await getCredentialInfrastructure();
  if (!infrastructure) return refuse("credentials-unavailable", 503);

  let body: PostBody;
  try {
    body = (await request.json()) as PostBody;
  } catch {
    return refuse("invalid-request", 400);
  }

  const actor = await resolveActor(request);

  switch (body.action) {
    case "connect":
      return connect(infrastructure, actor, body);
    case "rotate":
      return rotate(infrastructure, actor, body);
    case "revalidate":
      return revalidate(infrastructure, actor, body);
    default:
      return refuse("invalid-request", 400);
  }
}

type Infrastructure = NonNullable<Awaited<ReturnType<typeof getCredentialInfrastructure>>>;

async function connect(
  infrastructure: Infrastructure,
  actor: RuntimeActor,
  body: PostBody
): Promise<Response> {
  if (!isAgentProviderId(body.provider)) return refuse("unknown-provider", 400);

  // Asked of the registry rather than assumed. A provider with no credential
  // adapter is refused here rather than reaching the service and failing as a
  // generic validation error, so the user is told the accurate thing.
  const support = credentialSupportFor(body.provider);
  if (support.kind !== "supported") return refuse("unsupported-provider", 400);

  const authMethod = resolveAuthMethod(body.authMethod, support.authMethods);
  if (!authMethod) return refuse("invalid-request", 400);

  if (typeof body.secret !== "string" || !body.secret.trim()) {
    return refuse("invalid-request", 400);
  }

  const outcome = await infrastructure.service.connect({
    // From the session. There is no branch here that reads an owner from the
    // body, because there is no such field on `PostBody`.
    ownerId: actor.id,
    provider: body.provider,
    authMethod,
    secret: body.secret,
    displayName: body.displayName,
  });

  return connectionResponse(outcome);
}

async function rotate(
  infrastructure: Infrastructure,
  actor: RuntimeActor,
  body: PostBody
): Promise<Response> {
  if (typeof body.connectionId !== "string" || !body.connectionId) {
    return refuse("invalid-request", 400);
  }
  if (typeof body.secret !== "string" || !body.secret.trim()) {
    return refuse("invalid-request", 400);
  }

  // Owner-scoped inside the service. Another account's connection id is
  // indistinguishable from one that does not exist — a probe learns nothing
  // about whether it is real, which is the answer a probe should get.
  const outcome = await infrastructure.service.rotate({
    ownerId: actor.id,
    connectionId: body.connectionId,
    secret: body.secret,
  });

  return connectionResponse(outcome);
}

async function revalidate(
  infrastructure: Infrastructure,
  actor: RuntimeActor,
  body: PostBody
): Promise<Response> {
  if (typeof body.connectionId !== "string" || !body.connectionId) {
    return refuse("invalid-request", 400);
  }

  const outcome = await infrastructure.service.revalidate(actor.id, body.connectionId);
  return connectionResponse(outcome);
}

/**
 * The one response shape for every mutation.
 *
 * On success: the connection *view* — the narrowed type with no owner and no
 * credential. On failure: the normalized validation code and its fixed
 * sentence. There is no branch that returns anything else, which is what the
 * leakage suite's sweep of this module's outputs relies on.
 *
 * A validation failure is a 200 rather than a 4xx: the request was
 * well-formed and was processed, and the provider declined. Reporting that as
 * an HTTP error would conflate "your key is wrong" with "your request was
 * malformed", and the client would have to parse the body anyway to tell them
 * apart.
 */
function connectionResponse(
  outcome:
    | { ok: true; connection: unknown }
    | { ok: false; validation: { code: string; message: string } }
): Response {
  if (outcome.ok) return Response.json({ ok: true, value: { connection: outcome.connection } });
  return Response.json({ ok: false, validation: outcome.validation });
}

/* ------------------------------------------------------------------ *
 * DELETE — disconnect
 * ------------------------------------------------------------------ */

export async function DELETE(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) {
    return refuse("invalid-request", 403);
  }

  const infrastructure = await getCredentialInfrastructure();
  if (!infrastructure) return refuse("credentials-unavailable", 503);

  let body: { connectionId?: unknown };
  try {
    body = (await request.json()) as { connectionId?: unknown };
  } catch {
    return refuse("invalid-request", 400);
  }

  if (typeof body.connectionId !== "string" || !body.connectionId) {
    return refuse("invalid-request", 400);
  }

  const actor = await resolveActor(request);
  const outcome = await infrastructure.service.disconnect(actor.id, body.connectionId);

  // A connection that is not this actor's produces the same 404 as one that
  // does not exist. Nothing here reveals which.
  if (!outcome.ok) return refuse("not-found", 404);
  return Response.json({ ok: true, value: { connectionId: body.connectionId } });
}

/* ------------------------------------------------------------------ *
 * Helpers
 * ------------------------------------------------------------------ */

/**
 * Which method the caller asked for, checked against what the adapter offers.
 *
 * Defaults to the adapter's first method when the caller names none, so a
 * client that only knows about API keys keeps working when a provider gains a
 * second mechanism. A method the adapter does not implement is refused rather
 * than silently substituted — offering somebody an OAuth button and then
 * storing an API key would be the worst version of this.
 */
function resolveAuthMethod(
  requested: unknown,
  available: readonly ProviderAuthMethod[]
): ProviderAuthMethod | undefined {
  if (requested === undefined) return available[0];
  if (!isProviderAuthMethod(requested)) return undefined;
  return available.includes(requested) ? requested : undefined;
}

/**
 * Who is asking.
 *
 * Exactly as the control and remote-projects routes resolve it: the signed-in
 * account when the deployment has accounts, the anonymous local actor when it
 * does not. Never anything out of the body.
 */
async function resolveActor(request: Request): Promise<RuntimeActor> {
  const session = await getSession(request);
  return session.ok ? { id: `account:${session.auth.user.id}` } : LOCAL_ACTOR;
}
