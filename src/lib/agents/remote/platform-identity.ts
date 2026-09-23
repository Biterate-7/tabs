import "server-only";
import { getVercelOidcTokenSync } from "@vercel/oidc";

/**
 * Whether the platform has given this request an OIDC token.
 *
 * ## Why this asks the SDK's lookup rather than `process.env`
 *
 * A deployed Vercel Function receives its OIDC token per request, in the
 * request context (`x-vercel-oidc-token`). `process.env.VERCEL_OIDC_TOKEN` is
 * the local-development copy that `vercel env pull` writes, and it is absent
 * in production. The gate used to check only the variable, so every real
 * deployment reported "not configured for remote sandboxes" while the sandbox
 * SDK beside it would have authenticated without complaint.
 *
 * `getVercelOidcTokenSync` is the lookup `@vercel/sandbox` itself goes through
 * (header first, then the variable). Asking it means the gate answers true
 * exactly when the SDK could authenticate. The sync form is deliberate: it
 * reads, and never refreshes a token or makes a network call.
 *
 * ## Presence only
 *
 * The token is a credential. It is compared against nothing, stored nowhere,
 * logged never, and does not leave this function — only the boolean does.
 */
export function hasPlatformOidcToken(): boolean {
  try {
    return getVercelOidcTokenSync().trim().length > 0;
  } catch {
    // No request context, no header and no variable: not on a platform that
    // issues one. The gate then falls through to the access-token trio, and
    // refuses if that is incomplete too.
    return false;
  }
}
