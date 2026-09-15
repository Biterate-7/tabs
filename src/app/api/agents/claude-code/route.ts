import "server-only";
import { decodeCursor, encodeCursor } from "@/lib/agents/claude-code/cursor";
import { countCreatedTasks, normalizeSession } from "@/lib/agents/claude-code/normalizer";
import { sweepSessions } from "@/lib/agents/claude-code/reader";
import type { ClaudeObservationResponse } from "@/lib/agents/claude-code/contract";

export const runtime = "nodejs";

/**
 * Local Claude Code observation.
 *
 * The endpoint's entire input is an opaque cursor. It accepts no path, no
 * glob, no session filter and no directory — the server alone decides which
 * files are legible, and the browser's only say in the matter is "continue
 * from where I was".
 *
 * ## Hosted deployments
 *
 * On Vercel (or any server that is not the user's own machine) `~/.claude`
 * either does not exist or belongs to the deployment, not to the person
 * looking at the page. Either way it is not the user's sessions, so the
 * honest answer is `available: false` — and that is what the sweep returns
 * when the projects root is missing. This feature is local/self-hosted by
 * nature, and nothing here is weakened to make a hosted deployment look like
 * it works.
 *
 * Reading is deliberately a POST: the cursor is state rather than an
 * addressable resource, and a GET would invite caching a result that is only
 * ever true for the instant it was taken.
 */
export async function POST(request: Request): Promise<Response> {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    // A pollable endpoint should not punish a malformed body with a 400 the
    // client would then have to special-case: an unreadable cursor simply
    // means "start fresh", which decodeCursor already yields.
    body = null;
  }

  const rawCursor = (body as { cursor?: unknown } | null)?.cursor;
  const cursors = decodeCursor(rawCursor);

  const now = Date.now();
  const sweep = await sweepSessions(cursors, now);

  if (!sweep.available) {
    const unavailable: ClaudeObservationResponse = {
      available: false,
      sessions: [],
      observations: [],
      cursor: "",
    };
    return Response.json(unavailable);
  }

  const response: ClaudeObservationResponse = {
    available: true,
    sessions: sweep.results.map((result) => result.session),
    observations: sweep.results.flatMap((result) =>
      normalizeSession({
        session: result.session,
        records: result.records,
        now,
        // The cursor returned by the sweep has ALREADY been advanced past this
        // batch's creations, so the base for numbering them is that total
        // minus what this batch itself created — the count the previous poll
        // left behind.
        taskOrdinalBase: result.cursor.taskOrdinal - countCreatedTasks(result.records),
      })
    ),
    cursor: encodeCursor(sweep.results.map((result) => result.cursor)),
  };

  return Response.json(response);
}
