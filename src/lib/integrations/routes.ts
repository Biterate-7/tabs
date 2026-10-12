import "server-only";
import { getSession } from "@/lib/auth/session";
import { hasJsonContentType, isSameOrigin } from "@/lib/auth/origin";
import { checkAuthRateLimit } from "@/lib/auth/rate-limit";
import { createSyncMcpData } from "@/lib/mcp/data";
import { getSyncService } from "@/lib/sync/store";
import { getIntegrationStore } from "./store-postgres";
import type { HubbleMcpData } from "@/lib/mcp/data";
import type { SyncService } from "@/lib/sync/service";
import type { IntegrationStore } from "./store";

/**
 * Shared plumbing for the integration routes.
 *
 * Two kinds of route use it, and they never mix:
 *
 *   - Hubble's own pages (src/app/api/integrations/*, and the consent step of
 *     /api/oauth/authorize): authenticated by the session cookie, same origin
 *     only, JSON only — the auth routes' own CSRF rules. These are the only
 *     routes that approve, revoke or change anything for the person.
 *   - OAuth endpoints an AI client calls (register, token, revoke) and the
 *     metadata documents: no cookie is read at all, so they answer CORS
 *     preflights and carry no ambient authority.
 */

export type RouteFailure = { code: string; message: string; status: number };

export function refuse(code: string, message: string, status: number): Response {
  return Response.json({ ok: false, error: { code, message } }, { status, headers: { "cache-control": "no-store" } });
}

export function okJson(value: unknown, init: ResponseInit = {}): Response {
  return Response.json({ ok: true, value }, { ...init, headers: { "cache-control": "no-store", ...(init.headers ?? {}) } });
}

export type IntegrationContext = {
  userId: string;
  store: IntegrationStore;
  sync: SyncService;
  data: HubbleMcpData;
};

/**
 * The signed-in person and the infrastructure, or the response that says why
 * not. `mutating` adds the JSON content-type requirement the mutating auth
 * routes already have.
 */
export async function integrationContext(request: Request, options: { mutating: boolean }): Promise<IntegrationContext | Response> {
  if (!isSameOrigin(request) || (options.mutating && !hasJsonContentType(request))) {
    return refuse("invalid_request", "Hubble could not read that request.", 403);
  }
  const session = await getSession(request);
  if (!session.ok) {
    return session.reason === "not-configured"
      ? refuse("unavailable", "Accounts are not available on this deployment.", 503)
      : refuse("sign_in_required", "Sign in to Hubble to manage AI integrations.", 401);
  }
  const [store, sync] = await Promise.all([getIntegrationStore().catch(() => undefined), getSyncService()]);
  if (!store || !sync.ok) return refuse("unavailable", "AI integrations are not available on this deployment.", 503);
  return { userId: session.auth.user.id, store, sync: sync.service, data: createSyncMcpData({ sync: sync.service }) };
}

/** The person's synced workspaces — the only ones a connection may be granted. */
export async function grantableWorkspaces(sync: SyncService, userId: string) {
  const rows = await sync.listWorkspaces(userId);
  return rows.map((row) => ({ id: row.id, name: row.name, updatedAt: row.updatedAt }));
}

export async function readJson(request: Request): Promise<Record<string, unknown> | undefined> {
  try {
    const text = await request.text();
    if (text.length > 64 * 1024) return undefined;
    const value = JSON.parse(text) as unknown;
    return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

/* ------------------------------------------------------------------ *
 * OAuth endpoints
 * ------------------------------------------------------------------ */

export const OAUTH_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "GET, POST, OPTIONS",
  "access-control-allow-headers": "authorization, content-type, mcp-protocol-version",
  "access-control-max-age": "600",
} as const;

export function preflight(): Response {
  return new Response(null, { status: 204, headers: OAUTH_CORS_HEADERS });
}

export function oauthJson(status: number, body: Record<string, unknown>): Response {
  return Response.json(body, {
    status,
    headers: { ...OAUTH_CORS_HEADERS, "cache-control": "no-store", pragma: "no-cache" },
  });
}

export function publicJson(body: Record<string, unknown>): Response {
  return Response.json(body, { headers: { ...OAUTH_CORS_HEADERS, "cache-control": "public, max-age=300" } });
}

/** Per-IP limits on the OAuth endpoints. Generous: AI clients call from shared egress addresses. */
export const OAUTH_RATE_LIMITS = {
  register: { limit: 30, windowMs: 10 * 60 * 1000 },
  token: { limit: 600, windowMs: 10 * 60 * 1000 },
  authorize: { limit: 60, windowMs: 10 * 60 * 1000 },
} as const;

export function rateLimited(request: Request, key: keyof typeof OAUTH_RATE_LIMITS): Response | undefined {
  const result = checkAuthRateLimit(request, `oauth-${key}`, OAUTH_RATE_LIMITS[key]);
  if (result.allowed) return undefined;
  return oauthJson(429, { error: "slow_down", error_description: "Too many requests. Try again shortly." });
}

/** The integration store, for the OAuth endpoints. `undefined` → 503. */
export async function oauthStore(): Promise<IntegrationStore | undefined> {
  return getIntegrationStore().catch(() => undefined);
}
