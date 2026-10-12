import "server-only";
import { getSession } from "@/lib/auth/session";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { getSyncService } from "@/lib/sync/store";
import { recordActivity, userActivity } from "@/lib/integrations/activity";
import { AUTHORIZATION_PARAM_NAMES, approveAuthorization, denyAuthorization, validateAuthorizationRequest } from "@/lib/integrations/oauth";
import { requestOrigin } from "@/lib/integrations/origin";
import { grantableWorkspaces, oauthStore, okJson, rateLimited, readJson, refuse } from "@/lib/integrations/routes";
import { CLIENT_NAME, isPermissionLevel } from "@/lib/integrations/scopes";
import type { AuthorizationParams } from "@/lib/integrations/oauth";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The consent step of Hubble's OAuth flow — the server half of the
 * /oauth/authorize page.
 *
 * GET validates the client's authorization request and tells the page what
 * to show: who is asking (the client's self-declared name *and* the verified
 * host the answer will be sent to), whether the person is signed in, and
 * which synced workspaces they could grant. POST records the person's
 * decision and returns where to send the browser.
 *
 * Both are Hubble's own page talking to Hubble: same origin, session cookie,
 * JSON. The request parameters are validated again on POST rather than
 * trusted from the GET, and the workspaces granted must be the account's
 * own synced ones. A request whose client or redirect URI cannot be verified
 * is never redirected anywhere — the page shows the error instead.
 */

function paramsFrom(source: URLSearchParams | Record<string, unknown>): AuthorizationParams {
  const params: AuthorizationParams = {};
  for (const name of AUTHORIZATION_PARAM_NAMES) {
    const value = source instanceof URLSearchParams ? source.get(name) : source[name];
    if (typeof value === "string") params[name] = value;
  }
  return params;
}

export async function GET(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) return refuse("invalid_request", "Hubble could not read that request.", 403);
  const store = await oauthStore();
  if (!store) return refuse("unavailable", "AI integrations are not available on this deployment.", 503);

  const issuer = requestOrigin(request);
  const validation = await validateAuthorizationRequest(store, paramsFrom(new URL(request.url).searchParams), issuer);
  if (!validation.ok) {
    return okJson({
      valid: false,
      error: validation.description,
      ...(validation.redirect ? { redirect: validation.location } : {}),
    });
  }

  const { request: valid } = validation;
  const summary = {
    clientName: valid.clientName,
    client: valid.client,
    clientProduct: CLIENT_NAME[valid.client],
    redirectHost: valid.redirectHost,
    requestedLevel: valid.requestedLevel,
  };

  const session = await getSession(request);
  if (!session.ok) return okJson({ valid: true, signedIn: false, request: summary });

  const sync = await getSyncService();
  const workspaces = sync.ok ? await grantableWorkspaces(sync.service, session.auth.user.id).catch(() => []) : [];
  return okJson({
    valid: true,
    signedIn: true,
    account: { name: session.auth.user.name, email: session.auth.user.email },
    request: summary,
    workspaces,
  });
}

export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) return refuse("invalid_request", "Hubble could not read that request.", 403);
  const limited = rateLimited(request, "authorize");
  if (limited) return limited;
  const store = await oauthStore();
  const sync = await getSyncService();
  if (!store || !sync.ok) return refuse("unavailable", "AI integrations are not available on this deployment.", 503);

  const body = await readJson(request);
  if (!body || typeof body.params !== "object" || body.params === null) return refuse("invalid_request", "Hubble could not read that request.", 400);
  const issuer = requestOrigin(request);
  const validation = await validateAuthorizationRequest(store, paramsFrom(body.params as Record<string, unknown>), issuer);
  if (!validation.ok) {
    return validation.redirect ? okJson({ redirect: validation.location }) : refuse("invalid_request", validation.description, 400);
  }

  const now = Date.now();
  const session = await getSession(request);
  // Denying needs no account: it grants nothing, and a signed-out person must be able to say no.
  if (body.decision === "deny") {
    if (session.ok) {
      await recordActivity(store, userActivity(session.auth.user.id, { kind: "connection", operation: "authorization_denied", outcome: "ok", detail: `Declined to connect ${CLIENT_NAME[validation.request.client]}` }, now));
    }
    return okJson({ redirect: denyAuthorization(validation.request, issuer) });
  }
  if (!session.ok) return refuse("sign_in_required", "Sign in to Hubble to continue.", 401);
  const userId = session.auth.user.id;
  if (body.decision !== "approve" || !isPermissionLevel(body.permission) || !Array.isArray(body.workspaceIds)) {
    return refuse("invalid_request", "Choose a permission level and at least one workspace.", 400);
  }

  const grantable = new Set((await grantableWorkspaces(sync.service, userId)).map((workspace) => workspace.id));
  const approved = await approveAuthorization(store, {
    request: validation.request,
    issuer,
    userId,
    level: body.permission,
    workspaceIds: body.workspaceIds.filter((id): id is string => typeof id === "string"),
    grantableWorkspaceIds: grantable,
    now,
  });
  if (!approved.ok) {
    const messages = {
      no_workspaces: "Choose at least one workspace.",
      unknown_workspace: "One of those workspaces is not synced to your account.",
      too_many_connections: "You already have the maximum number of AI connections. Disconnect one in Settings first.",
    } as const;
    return refuse(approved.reason, messages[approved.reason], 400);
  }
  await recordActivity(
    store,
    userActivity(userId, { kind: "connection", operation: "authorization_granted", outcome: "ok", detail: `Authorized ${CLIENT_NAME[validation.request.client]} (${body.permission === "write" ? "read and save" : "read only"})` }, now)
  );
  return okJson({ redirect: approved.location });
}
