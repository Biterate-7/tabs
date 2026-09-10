import "server-only";
import { isGoogleConfigured } from "@/lib/auth/config";
import { jsonWithCookies } from "@/lib/auth/cookies";
import { issueLoginNonce } from "@/lib/auth/nonce";
import { isSameOrigin } from "@/lib/auth/origin";
import { checkAuthRateLimit } from "@/lib/auth/rate-limit";

export const runtime = "nodejs";

/**
 * Step one of a sign-in: hand this browser a single-use nonce and remember
 * its hash in an HttpOnly cookie.
 *
 * POST rather than GET even though it reads nothing, because it *writes* a
 * cookie — and because a GET would be reachable cross-site from a plain
 * `<img>`/`<script>` tag, letting an attacker overwrite the victim's
 * pending nonce. See src/lib/auth/nonce.ts for what the nonce buys.
 */
export async function POST(request: Request): Promise<Response> {
  if (!isSameOrigin(request)) {
    return jsonWithCookies({ error: "Request rejected." }, { status: 403 });
  }
  if (!isGoogleConfigured()) {
    return jsonWithCookies({ error: "Sign-in isn't available on this deployment yet." }, { status: 503 });
  }

  const rate = checkAuthRateLimit(request, "nonce");
  if (!rate.allowed) {
    return jsonWithCookies(
      { error: "Too many sign-in attempts — try again shortly." },
      { status: 429, headers: { "retry-after": String(Math.ceil(rate.retryAfterMs / 1000)) } }
    );
  }

  const { nonce, cookie } = issueLoginNonce();
  return jsonWithCookies({ nonce }, { cookies: [cookie] });
}

/** Declared only so an unsupported method is a clean 405 rather than Next's generic handling. Required by the same reasoning as the POST-only note above. */
export async function GET(): Promise<Response> {
  return jsonWithCookies({ error: "Method not allowed." }, { status: 405, headers: { allow: "POST" } });
}

