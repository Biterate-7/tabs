/**
 * The one piece of auth configuration that is safe in the browser bundle,
 * and the only auth module without `server-only`.
 *
 * The OAuth **client ID** is public by design — Google Identity Services
 * needs it client-side to start a sign-in, and Google documents it as
 * non-secret. It is not a capability on its own: possessing it lets anyone
 * ask Google for a token *for this app*, and that token still has to pass
 * server-side verification (src/lib/auth/google.ts) before it means
 * anything here.
 *
 * The client **secret** is deliberately absent from this file and from the
 * codebase entirely — the ID-token flow TabDump uses has no step that needs
 * one, so there is no secret to leak into a bundle.
 *
 * Written as a direct `process.env.NEXT_PUBLIC_…` member access because
 * that is the form Next's bundler statically replaces; a computed lookup
 * would come back undefined in the browser.
 */
export function publicGoogleClientId(): string | undefined {
  return process.env.NEXT_PUBLIC_GOOGLE_CLIENT_ID?.trim() || undefined;
}
