// Which Hubble account context detection is acting for — decided by Hubble's
// server, never by what a page says.
//
// The problem it solves: activity and consent live in one Chrome profile that
// several Hubble accounts (and signed-out Hubble) may use. The Hubble page
// claims an account with every context command, but anything running on
// Hubble's origin can claim anything. So the claim is only a claim: the
// extension asks Hubble's own /api/auth/me itself, with the browser's
// HttpOnly session cookie (which no page script can read or set), and acts
// only when the server's answer and the claim agree.
//
//   page ── { account: claimed id | null } ──► background ── fetch /api/auth/me (credentials) ──► Hubble
//                                                  │ agree → owner = "user:" + sha256(id) | "signed-out"
//                                                  └ disagree, error, timeout → refused (fail closed)
//
// No secret, key or token is kept anywhere: what is verified is the live
// session itself, so signing out or a revoked session takes effect at the
// next check. Writes always check afresh; reads may reuse a check for a few
// seconds, and only when the page claims the same account it confirmed.
//
// Every browser call is injected, so all of it is tested without Chrome
// (context-identity.test.js).

export const IDENTITY_CACHE_MS = 10_000;
export const IDENTITY_TIMEOUT_MS = 5_000;
const ACCOUNT = /^[A-Za-z0-9_-]{1,200}$/;

/** A page's claim, checked for shape: null (signed out) or an account id. Undefined when malformed. */
export function readAccountClaim(value) {
  if (value === null) return null;
  return typeof value === "string" && ACCOUNT.test(value) ? value : undefined;
}

async function sha256Hex(text, subtle) {
  const bytes = new Uint8Array(await subtle.digest("SHA-256", new TextEncoder().encode(text)));
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** The owner stored for a confirmed account: a hash, so the extension's storage never holds the account id itself. */
export async function ownerForAccount(account, subtle = globalThis.crypto?.subtle) {
  return account === null ? "signed-out" : `user:${await sha256Hex(`hubble-context:${account}`, subtle)}`;
}

/**
 * @param deps.fetch         globalThis.fetch
 * @param deps.hubbleOrigin  Hubble's origin; /api/auth/me is asked there, with credentials
 * @param deps.now           () => epoch ms
 * @param deps.subtle        crypto.subtle (for the owner's hash)
 */
export function createIdentityVerifier(deps) {
  let confirmed; // { account: string | null, at }

  /** The server's own answer: { ok: true, account: id | null } or { ok: false }. Never throws. */
  async function askServer() {
    const controller = typeof AbortController === "function" ? new AbortController() : undefined;
    const timer = controller ? setTimeout(() => controller.abort(), IDENTITY_TIMEOUT_MS) : undefined;
    try {
      const response = await deps.fetch(`${deps.hubbleOrigin}/api/auth/me`, {
        credentials: "include",
        cache: "no-store",
        headers: { Accept: "application/json" },
        ...(controller ? { signal: controller.signal } : {}),
      });
      if (!response?.ok) return { ok: false };
      const body = await response.json();
      if (!body || typeof body.authenticated !== "boolean") return { ok: false };
      if (!body.authenticated) return { ok: true, account: null };
      const id = body.user?.id;
      return typeof id === "string" && ACCOUNT.test(id) ? { ok: true, account: id } : { ok: false };
    } catch {
      return { ok: false };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  const ownerOf = (account) => ownerForAccount(account, deps.subtle);

  /**
   * The owner a command may act for, or a refusal:
   *   { ok: true, owner }
   *   { ok: false, error: "identity-invalid" }     the claim isn't one
   *   { ok: false, error: "identity-unverified" }  Hubble couldn't be asked (offline, error, timeout)
   *   { ok: false, error: "identity-mismatch" }    the page claims an account the browser isn't signed in to
   */
  async function verify(claim, { fresh = false } = {}) {
    const account = readAccountClaim(claim);
    if (account === undefined) return { ok: false, error: "identity-invalid" };
    const at = deps.now();
    const reusable = !fresh && confirmed && confirmed.account === account && at - confirmed.at >= 0 && at - confirmed.at < IDENTITY_CACHE_MS;
    if (!reusable) {
      const answer = await askServer();
      if (!answer.ok) {
        confirmed = undefined;
        return { ok: false, error: "identity-unverified" };
      }
      confirmed = { account: answer.account, at: deps.now() };
    }
    if (confirmed.account !== account) return { ok: false, error: "identity-mismatch" };
    return { ok: true, owner: await ownerOf(account) };
  }

  /** The owner Hubble's server says this browser is signed in as now, asked afresh; undefined when it can't say. */
  async function currentOwner() {
    const answer = await askServer();
    if (!answer.ok) return undefined;
    confirmed = { account: answer.account, at: deps.now() };
    return ownerOf(answer.account);
  }

  return { verify, currentOwner, forget: () => (confirmed = undefined) };
}
