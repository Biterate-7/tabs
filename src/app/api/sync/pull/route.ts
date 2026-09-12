import "server-only";
import { gateSyncRequest, invalid, notFound } from "@/lib/sync/http";
import { isCursor } from "@/lib/sync/request";
import { SYNC_REQUEST_LIMITS } from "@/lib/sync/service";
import { isUuid } from "@/lib/sync/validation";

export const runtime = "nodejs";

/**
 * Everything that changed in one workspace since the caller's cursor.
 *
 * A GET, and genuinely read-only: it takes no body, writes nothing, and
 * advances no server state. The client's cursor lives on the client (see
 * src/lib/sync/metadata.ts) precisely so two devices can be at different
 * points in the same stream without fighting over one number.
 *
 * The response carries tombstones alongside updates. That is the whole
 * reason deletions are stored rather than removed: a client can tell
 * "this was deleted" from "I have never heard of this", and absence is
 * never evidence of deletion.
 *
 * Paged by `hasMore`/`cursor` rather than returning a whole workspace each
 * time, and cut at a version boundary so one transaction's writes are never
 * split across two pages.
 */
export async function GET(request: Request): Promise<Response> {
  // `mutating: false`: a GET has no body to police and must never change
  // state, so the JSON-content-type check that protects the POST routes
  // would be meaningless here. Authentication and rate limiting still apply.
  const gate = await gateSyncRequest(request, false);
  if (!gate.ok) return gate.response;

  const url = new URL(request.url);
  const workspaceId = url.searchParams.get("workspaceId");
  const cursor = url.searchParams.get("cursor") ?? "0";

  if (!isUuid(workspaceId)) return invalid(["workspaceId: must be a UUID"]);
  if (!isCursor(cursor)) return invalid(["cursor: must be a cursor string"]);

  try {
    const page = await gate.context.service.pull(
      workspaceId,
      gate.context.user.id,
      cursor,
      SYNC_REQUEST_LIMITS.pullPageSize
    );
    // null means "not yours or not there" — one answer for both, so a
    // guessed id reveals nothing.
    if (!page) return notFound();

    return Response.json(page);
  } catch (error) {
    console.error("[sync] pull failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Couldn't fetch changes right now. Try again." }, { status: 500 });
  }
}
