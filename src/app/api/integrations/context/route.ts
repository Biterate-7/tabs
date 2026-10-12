import "server-only";
import { integrationContext, okJson, readJson, refuse } from "@/lib/integrations/routes";
import { recordActivity, userActivity } from "@/lib/integrations/activity";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * What AI clients saved about one workspace's project, for the person to
 * read — and to remove. Deleting here is the person's own action in Hubble;
 * no AI client can delete saved context or notes.
 */
export async function GET(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: false });
  if (context instanceof Response) return context;
  const workspaceId = new URL(request.url).searchParams.get("workspaceId");
  if (!workspaceId) return refuse("invalid_request", "Choose a workspace.", 400);
  const owned = (await context.sync.cursorOf(workspaceId, context.userId)) !== null;
  if (!owned) return refuse("not_found", "That workspace is not synced to your account.", 404);
  const [projectContext, notes] = await Promise.all([
    context.store.getProjectContext(context.userId, workspaceId),
    context.store.listNotes(context.userId, workspaceId, { offset: 0, limit: 50 }),
  ]);
  return okJson({ context: projectContext ?? null, notes: notes.notes, notesTotal: notes.total });
}

export async function DELETE(request: Request): Promise<Response> {
  const context = await integrationContext(request, { mutating: true });
  if (context instanceof Response) return context;
  const body = await readJson(request);
  if (!body || typeof body.workspaceId !== "string") return refuse("invalid_request", "Hubble could not read that request.", 400);
  const now = Date.now();
  if (typeof body.noteId === "string") {
    const deleted = await context.store.deleteNote(context.userId, body.noteId);
    if (!deleted) return refuse("not_found", "That note no longer exists.", 404);
    await recordActivity(context.store, userActivity(context.userId, { kind: "write", operation: "delete_note", outcome: "ok", workspaceId: body.workspaceId, targets: [body.noteId], detail: "Deleted a saved note" }, now));
    return okJson({ deleted: true });
  }
  const cleared = await context.store.deleteProjectContext(context.userId, body.workspaceId);
  await recordActivity(context.store, userActivity(context.userId, { kind: "write", operation: "clear_project_context", outcome: "ok", workspaceId: body.workspaceId, detail: "Cleared saved project context" }, now));
  return okJson({ cleared });
}
