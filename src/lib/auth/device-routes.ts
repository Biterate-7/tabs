import "server-only";
import { jsonWithCookies } from "./cookies";
import {
  cleanDeviceLabel,
  createDevicePairing,
  isCodeChallenge,
  readDeviceToken,
  redeemDevicePairing,
  resolveDeviceToken,
  toPublicDevice,
} from "./device";
import { requireUser } from "./guard";
import { hasJsonContentType, isSameOrigin } from "./origin";
import { checkAuthRateLimit } from "./rate-limit";
import { getAuthStore } from "./store";

/**
 * The handlers behind /api/auth/desktop/* (see ./device.ts for the flow).
 * Kept here rather than in the route files so they can be tested directly
 * and so a route file exports only its handler.
 *
 * Which credential each one accepts is the security model, so it is stated
 * per handler:
 *
 *   authorize   web session cookie only — a device can't mint more devices
 *   token       neither: the pairing code + PKCE verifier are the credential
 *   logout      the device token being signed out
 *   devices     web session cookie only — the web manages connected desktops
 */

function json(body: unknown, status = 200, headers?: Record<string, string>): Response {
  return jsonWithCookies(body, { status, ...(headers ? { headers } : {}) });
}

function rejected(): Response {
  return json({ error: "Request rejected." }, 403);
}

function rateLimited(retryAfterMs: number): Response {
  return json({ error: "Too many attempts. Try again shortly." }, 429, { "retry-after": String(Math.ceil(retryAfterMs / 1000)) });
}

async function readJson(request: Request): Promise<Record<string, unknown> | null> {
  try {
    const body = await request.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

/** A cookie-authenticated web user, refusing a device token: what only the website may do. */
async function requireWebUser(request: Request) {
  if (readDeviceToken(request) !== undefined) return { ok: false as const, response: rejected() };
  const auth = await requireUser(request);
  if (!auth.ok) return auth;
  if (auth.auth.via === "device") return { ok: false as const, response: rejected() };
  return auth;
}

/** POST /api/auth/desktop/authorize { challenge, label? } → { code, expiresAt } */
export async function authorizeDesktop(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) return rejected();
  const rate = checkAuthRateLimit(request, "desktop-authorize");
  if (!rate.allowed) return rateLimited(rate.retryAfterMs);

  const auth = await requireWebUser(request);
  if (!auth.ok) return auth.response;

  const body = await readJson(request);
  if (!body || !isCodeChallenge(body.challenge)) return json({ error: "Expected { challenge }." }, 400);

  const store = await getAuthStore();
  if (!store.ok) return json({ error: "Accounts aren't available on this deployment yet." }, 503);
  const { code, expiresAt } = await createDevicePairing(store.store, auth.user.id, body.challenge, cleanDeviceLabel(body.label));
  return json({ code, expiresAt });
}

/** POST /api/auth/desktop/token { code, verifier } → { token, expiresAt, user } */
export async function exchangeDesktopCode(request: Request): Promise<Response> {
  if (!hasJsonContentType(request)) return rejected();
  const rate = checkAuthRateLimit(request, "desktop-token");
  if (!rate.allowed) return rateLimited(rate.retryAfterMs);

  const body = await readJson(request);
  if (!body) return json({ error: "Expected { code, verifier }." }, 400);

  const store = await getAuthStore();
  if (!store.ok) return json({ error: "Accounts aren't available on this deployment yet." }, 503);
  const result = await redeemDevicePairing(store.store, body.code, body.verifier);
  if (!result.ok) {
    return result.reason === "invalid-request"
      ? json({ error: "Expected { code, verifier }." }, 400)
      : json({ error: "That sign-in code has expired or was already used. Sign in again from Hubble Desktop." }, 401);
  }
  return json({ token: result.token, expiresAt: result.device.expiresAt, user: result.user });
}

/** POST /api/auth/desktop/logout, with the device token → the credential is deleted. */
export async function signOutDesktop(request: Request): Promise<Response> {
  const token = readDeviceToken(request);
  if (!token) return json({ error: "Sign in to continue." }, 401);
  const store = await getAuthStore();
  if (!store.ok) return json({ error: "Accounts aren't available on this deployment yet." }, 503);
  const resolved = await resolveDeviceToken(store.store, token);
  // Already gone (revoked from the web, expired) is the outcome asked for.
  if (resolved) await store.store.deleteDeviceSession(resolved.device.id);
  return json({ ok: true });
}

/** GET /api/auth/desktop/devices → { devices } — the signed-in web user's connected desktops. */
export async function listDesktops(request: Request): Promise<Response> {
  const auth = await requireWebUser(request);
  if (!auth.ok) return auth.response;
  const store = await getAuthStore();
  if (!store.ok) return json({ error: "Accounts aren't available on this deployment yet." }, 503);
  const now = Date.now();
  const devices = (await store.store.listDeviceSessions(auth.user.id)).filter((device) => device.expiresAt > now);
  return json({ devices: devices.map(toPublicDevice) });
}

/** POST /api/auth/desktop/devices { revoke: id } → that desktop is signed out. Someone else's id is a 404. */
export async function revokeDesktop(request: Request): Promise<Response> {
  if (!isSameOrigin(request) || !hasJsonContentType(request)) return rejected();
  const auth = await requireWebUser(request);
  if (!auth.ok) return auth.response;
  const body = await readJson(request);
  if (!body || typeof body.revoke !== "string") return json({ error: "Expected { revoke }." }, 400);
  const store = await getAuthStore();
  if (!store.ok) return json({ error: "Accounts aren't available on this deployment yet." }, 503);
  const owned = (await store.store.listDeviceSessions(auth.user.id)).find((device) => device.id === body.revoke);
  if (!owned) return json({ error: "Not found." }, 404);
  await store.store.deleteDeviceSession(owned.id);
  return json({ ok: true });
}
