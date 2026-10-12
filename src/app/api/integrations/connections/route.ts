import "server-only";
import { grantableWorkspaces, integrationContext, okJson, readJson, refuse } from "@/lib/integrations/routes";
import { CONNECTION_PROBLEM_MESSAGES, createTokenConnection, revokeConnection, updateConnection } from "@/lib/integrations/service";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * The person's AI connections: create a token connection (for a CLI, a
 * config file or the xAI API), change what one may do, or disconnect one.
 *
 * OAuth connections are created by the consent page, not here. The token in
 * POST's answer crosses the wire exactly once and is never stored in the
 * browser.
 */

async function grantable(context: Exclude<Awaited<ReturnType<typeof integrationContext>>, Response>) {
  return new Set((await grantableWorkspaces(context.sync, context.userId)).map((workspace) => workspace.id));
}

export async function POST(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body) return refuse("invalid_request", "Hubble could not read that request.", 400);
  const created = await createTokenConnection(context.store, {
    userId: context.userId,
    client: body.client,
    label: body.label,
    permission: body.permission,
    workspaceIds: body.workspaceIds,
    grantable: await grantable(context),
    now: Date.now(),
  });
  if (!created.ok) return refuse(created.problem, CONNECTION_PROBLEM_MESSAGES[created.problem], created.problem === "too_many_connections" ? 429 : 400);
  return okJson({ token: created.token, connection: created.connection });
}

export async function PATCH(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body || typeof body.connectionId !== "string") return refuse("invalid_request", "Hubble could not read that request.", 400);
  const updated = await updateConnection(context.store, {
    userId: context.userId,
    connectionId: body.connectionId,
    ...(body.permission !== undefined ? { permission: body.permission } : {}),
    ...(body.workspaceIds !== undefined ? { workspaceIds: body.workspaceIds } : {}),
    grantable: await grantable(context),
    now: Date.now(),
  });
  if (!updated.ok) {
    return updated.problem === "not_found"
      ? refuse("not_found", "That connection no longer exists.", 404)
      : refuse(updated.problem, CONNECTION_PROBLEM_MESSAGES[updated.problem], 400);
  }
  return okJson({ updated: true });
}

export async function DELETE(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body || typeof body.connectionId !== "string") return refuse("invalid_request", "Hubble could not read that request.", 400);
  const revoked = await revokeConnection(context.store, context.userId, body.connectionId, Date.now());
  return revoked ? okJson({ revoked: true }) : refuse("not_found", "That connection no longer exists.", 404);
}
