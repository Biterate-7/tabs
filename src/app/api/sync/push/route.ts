import "server-only";
import { gateSyncRequest, invalid, notFound, readJsonBody } from "@/lib/sync/http";
import { parsePushRequest } from "@/lib/sync/request";
import { SYNC_REQUEST_LIMITS } from "@/lib/sync/service";
import { createTimestamp } from "@/lib/timestamps";

export const runtime = "nodejs";

/**
 * Applies a batch of local changes to a workspace the caller owns.
 *
 * All or nothing. Every upsert and delete in one request shares a
 * transaction and therefore a single sync version, so another device reading
 * the change stream sees the whole batch or none of it — a move of twenty
 * tabs never arrives as nineteen.
 *
 * Three distinct refusals, deliberately not collapsed into one:
 *
 *  - 404  the workspace is not this user's (or does not exist — the same
 *         answer on purpose, so a guessed id is not an existence oracle);
 *  - 409 `stale-base`  the workspace moved since the client last read. The
 *         client pulls and retries.
 *  - 409 `conflict`  specific entities changed since the client's base, or a
 *         write would have moved a tab a human had locked. The response
 *         names them.
 *
 * Nothing here resolves a conflict. It reports one and writes nothing.
 */
export async function POST(request: Request): Promise<Response> {
  const gate = await gateSyncRequest(request, true);
  if (!gate.ok) return gate.response;

  const body = await readJsonBody(request);
  if (!body.ok) return body.response;

  const parsed = parsePushRequest(body.value, SYNC_REQUEST_LIMITS.pushChanges);
  if (!parsed.ok) return invalid(parsed.errors);

  try {
    const result = await gate.context.service.push(
      parsed.value.workspaceId,
      gate.context.user.id,
      parsed.value.baseCursor,
      parsed.value.upserts,
      parsed.value.deletes,
      // The server stamps the deletion time. A client-supplied one would let
      // a wrong clock place a tombstone in the past, where another device
      // reading forward from its cursor would never see it.
      createTimestamp()
    );

    if (!result.ok) {
      if (result.reason === "not-found") return notFound();
      if (result.reason === "stale-base") {
        return Response.json(
          {
            error: "This workspace changed on the server. Pull the latest changes and try again.",
            reason: "stale-base",
            serverCursor: result.serverCursor,
          },
          { status: 409 }
        );
      }
      return Response.json(
        {
          error: "Some of those changes conflict with the server's copy.",
          reason: "conflict",
          serverCursor: result.serverCursor,
          conflicts: result.conflicts,
        },
        { status: 409 }
      );
    }

    // `accepted` is what the server actually stored, echoed back so the
    // client establishes its new baseline from fact rather than assumption.
    return Response.json({ cursor: result.cursor, accepted: result.accepted });
  } catch (error) {
    console.error("[sync] push failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Couldn't sync those changes right now. Try again." }, { status: 500 });
  }
}
