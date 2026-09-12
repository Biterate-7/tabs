import "server-only";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { checkAuthRateLimit } from "@/lib/auth/rate-limit";
import { requireUser } from "@/lib/auth/guard";
import type { PublicUser } from "@/lib/auth/types";
import { getSyncService } from "./store";
import type { SyncService } from "./service";

/**
 * The gate every sync route goes through, so no route re-implements it and
 * none of them can quietly end up weaker than the auth routes.
 *
 * Deliberately the SAME security model the existing state-changing auth
 * endpoint uses (src/app/api/auth/google/route.ts):
 *
 *  - same-origin, so a cross-site page cannot drive it with the user's cookie;
 *  - JSON content type, which forces a preflight that nothing here answers
 *    permissively, so a form/img/script-tag request never arrives;
 *  - an authenticated session, resolved from the HttpOnly cookie;
 *  - the shared rate limiter.
 *
 * Identity comes only from the session. No sync route reads a `userId` from
 * a body or a query string — the payload types have no such field, so there
 * is nothing to accidentally honour, and a request that includes one is
 * simply answered as whoever the cookie says it is.
 */

/** Bytes. A workspace upload is large but bounded; an unbounded body is a denial of service with extra steps. */
export const MAX_SYNC_BODY_BYTES = 8 * 1024 * 1024;

export type SyncContext = { user: PublicUser; service: SyncService };

export type GateResult = { ok: true; context: SyncContext } | { ok: false; response: Response };

function json(body: unknown, status: number): Response {
  return Response.json(body, { status });
}

/**
 * @param mutating - true for POST. A GET is never allowed to change state, so
 *   pull skips the CSRF-shaped checks that only make sense for a body.
 */
export async function gateSyncRequest(request: Request, mutating: boolean): Promise<GateResult> {
  if (mutating && (!isSameOrigin(request) || !hasJsonContentType(request))) {
    return { ok: false, response: json({ error: "Request rejected." }, 403) };
  }

  const rate = checkAuthRateLimit(request, "sync");
  if (!rate.allowed) {
    return {
      ok: false,
      response: Response.json(
        { error: "Too many requests. Try again shortly." },
        { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } }
      ),
    };
  }

  const auth = await requireUser(request);
  if (!auth.ok) return { ok: false, response: auth.response };

  const service = await getSyncService();
  if (!service.ok) {
    // `detail` names environment variables and was already logged once per
    // process; the browser gets the plain message only.
    return { ok: false, response: json({ error: "Sync isn't available on this deployment yet." }, 503) };
  }

  return { ok: true, context: { user: auth.user, service: service.service } };
}

/**
 * Reads a JSON body with a hard size ceiling.
 *
 * The Content-Length header is checked first when present, but the body is
 * also measured as it is read: a chunked request can lie about its length,
 * and "the header said it was small" is not a limit.
 */
export async function readJsonBody(request: Request): Promise<{ ok: true; value: unknown } | { ok: false; response: Response }> {
  const declared = request.headers.get("content-length");
  if (declared && Number(declared) > MAX_SYNC_BODY_BYTES) {
    return { ok: false, response: json({ error: "That workspace is too large to sync." }, 413) };
  }

  let text: string;
  try {
    text = await request.text();
  } catch {
    return { ok: false, response: json({ error: "Couldn't read that request." }, 400) };
  }

  if (text.length > MAX_SYNC_BODY_BYTES) {
    return { ok: false, response: json({ error: "That workspace is too large to sync." }, 413) };
  }

  try {
    return { ok: true, value: JSON.parse(text) as unknown };
  } catch {
    return { ok: false, response: json({ error: "That request isn't valid JSON." }, 400) };
  }
}

/**
 * The answer for "this workspace isn't yours" and "this workspace doesn't
 * exist".
 *
 * Deliberately identical, and deliberately 404. Distinguishing them would
 * turn a guessed id into an existence oracle for other people's workspaces.
 */
export function notFound(): Response {
  return json({ error: "Workspace not found." }, 404);
}

export function invalid(errors: readonly string[]): Response {
  return json({ error: "That request isn't valid.", errors }, 400);
}
