import "server-only";
import { jsonWithCookies } from "@/lib/auth/cookies";
import { isSameOrigin } from "@/lib/auth/origin";
import { destroySession } from "@/lib/auth/session";

export const runtime = "nodejs";

/**
 * Real logout: the server-side session row is deleted first, then the
 * browser's cookie is cleared. Clearing only the cookie would leave a live
 * token in whatever else holds a copy of it.
 *
 * Always answers 200, even with no session to destroy — "sign me out" has
 * succeeded either way, and distinguishing the two would tell an unrelated
 * caller whether a given browser was signed in.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return jsonWithCookies({ error: "Request rejected." }, { status: 403 });
  }

  try {
    const { cookie } = await destroySession(request);
    return jsonWithCookies({ ok: true }, { cookies: [cookie] });
  } catch (error) {
    // The row may or may not have been deleted, so the cookie is NOT
    // cleared here: telling the browser it is signed out while the session
    // is still live server-side is the one outcome worth avoiding.
    console.error("[auth] logout failed:", error instanceof Error ? error.message : error);
    return jsonWithCookies({ error: "Couldn't sign you out right now. Try again." }, { status: 500 });
  }
}
