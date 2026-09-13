import "server-only";
import { gateSyncRequest } from "@/lib/sync/http";

export const runtime = "nodejs";

/**
 * The workspaces this account owns, metadata only.
 *
 * Exists for exactly one situation: a device that is signed in and has no
 * local copy of anything. Without it such a device cannot know a workspace
 * is waiting, and its only route to the data was to press "upload" and be
 * refused — which is how a second device used to end up looking like it had
 * a data conflict.
 *
 * ## Why metadata and not contents
 *
 * Discovery answers "what exists", and hydration is a separate paged read
 * through /api/sync/pull. Returning contents here would duplicate that read,
 * make the response unbounded, and hand a caller every tab URL in the
 * account for what is meant to be a cheap list.
 *
 * ## Bounded on purpose
 *
 * A workspace row is small and a user has few of them, but "few" is not a
 * guarantee, so the response is capped. The cap is a ceiling on the answer,
 * never a page token: this is not a paging API, and a user at the cap has a
 * problem that a second page would not solve.
 *
 * Authentication, ownership, rate limiting and the 503-when-unconfigured
 * shape all come from the same gate the other three sync routes use, so this
 * cannot drift weaker than they are. Ownership is the repository's
 * `WHERE user_id = $1`; nothing here reads an identity from the request.
 */

/** A ceiling on the answer, not a page size. See the note above. */
export const MAX_DISCOVERED_WORKSPACES = 200;

export async function GET(request: Request): Promise<Response> {
  // `mutating: false`, like pull: a GET has no body to police and changes
  // nothing, so the JSON-content-type check that protects the POST routes
  // would be meaningless. Authentication and rate limiting still apply.
  const gate = await gateSyncRequest(request, false);
  if (!gate.ok) return gate.response;

  try {
    const workspaces = await gate.context.service.listWorkspaces(gate.context.user.id);
    return Response.json({
      workspaces: workspaces.slice(0, MAX_DISCOVERED_WORKSPACES),
      truncated: workspaces.length > MAX_DISCOVERED_WORKSPACES,
    });
  } catch (error) {
    console.error("[sync] workspace discovery failed:", error instanceof Error ? error.message : error);
    return Response.json({ error: "Couldn't list your workspaces right now. Try again." }, { status: 500 });
  }
}
