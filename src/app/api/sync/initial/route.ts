import "server-only";
import { gateSyncRequest, invalid, readJsonBody } from "@/lib/sync/http";
import { parseInitialRequest } from "@/lib/sync/request";
import { SYNC_REQUEST_LIMITS } from "@/lib/sync/service";

export const runtime = "nodejs";

/**
 * Uploads one workspace to the server for the first time.
 *
 * Explicitly user-initiated. Nothing calls this on startup, on sign-in, or
 * from any local mutation — signing in must never be the thing that decides
 * a user's workspaces are now the server's problem.
 *
 * The route itself does no database work and knows no conflict rules: it
 * gates the request, parses it, hands it to the service, and turns the
 * result into a response.
 *
 *   parse → authenticate → validate → repository transaction → serialize
 *
 * ## Why there is no force/overwrite flag
 *
 * If the workspace already exists and the client cannot prove it has seen
 * the server's current state, this answers 409 and changes nothing. A force
 * path would be a single boolean between a user and losing the copy they
 * edited on another device, and no caller in this phase has a legitimate
 * reason to set it.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await gateSyncRequest(request, true);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = parseInitialRequest(body.value, SYNC_REQUEST_LIMITS.initialEntities);
  if (!parsed.ok) return invalid(parsed.errors);

  try {
    const result = await gate.context.service.initial(
      { workspace: parsed.value.workspace, upserts: parsed.value.upserts },
      gate.context.user.id,
      parsed.value.knownCursor
    );

    if (!result.ok) {
      if (result.reason === "too-large") {
        return Response.json({ error: result.detail }, { status: 413 });
      }
      // Both remaining refusals leave the server's copy standing and the
      // client's own untouched — nothing is lost on either side. They are
      // reported separately because the client's next move differs:
      //
      //   already-exists  this account owns it; adopt what is here.
      //   conflict        the write could not be placed; re-read and decide.
      //
      // Collapsing them, as this once did, made a second device's first
      // upload look like a data disagreement when nothing disagreed.
      const alreadyExists = result.reason === "already-exists";
      return Response.json(
        {
          error: alreadyExists
            ? "That workspace is already on the server. Sync it to this device instead."
            : "Couldn't create that workspace right now.",
          reason: result.reason,
          serverCursor: result.serverCursor,
        },
        { status: 409 }
      );
    }

    return Response.json(
      { workspace: result.workspace, cursor: result.cursor, created: result.created },
      { status: result.created ? 201 : 200 }
    );
  } catch (error) {
    // The transaction rolled back, so the server holds either the previous
    // state or nothing — never half a workspace. The client keeps its local
    // copy untouched and can retry.
    console.error("[sync] initial failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Couldn't sync that workspace right now. Try again." }, { status: 500 });
  }
}
