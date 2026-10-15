import {
  AUTHORIZATION_CODE_TTL_MS,
  CLIENT_ID_PATTERN,
  CREDENTIAL_TTL_MS,
  credentialKindOf,
  hashesEqual,
  isWellFormedAuthorizationCode,
  isWellFormedClientSecret,
  mintAuthorizationCode,
  mintClientId,
  mintClientSecret,
  mintCredential,
  mintRecordId,
  sha256Hex,
  verifyPkce,
} from "./credentials";
import { clientForRedirectUri, CLIENT_NAME, HUBBLE_SCOPES, requestedLevel, scopesFor } from "./scopes";
import { UNSAFE_ANY } from "./text";
import type { ConnectionRecord, OAuthClientRecord } from "./records";
import type { IntegrationClient, PermissionLevel } from "./scopes";
import type { IntegrationStore } from "./store";

/**
 * Hubble's OAuth 2.1 authorization server, for MCP clients.
 *
 * The MCP authorization specification (2025-11-25) has a remote MCP server
 * act as an OAuth resource server and name an authorization server; Hubble
 * is both, on the same origin, because Hubble accounts are the identity:
 *
 *   client ─ GET /api/mcp ──────────────────────▶ 401 + resource_metadata
 *          ─ GET /.well-known/oauth-protected-resource/api/mcp
 *          ─ GET /.well-known/oauth-authorization-server
 *          ─ POST /api/oauth/register            (RFC 7591, DCR)
 *          ─ browser → /oauth/authorize          (sign in, choose workspaces
 *                                                 and permission, approve)
 *          ◀ redirect_uri?code=…&state=…&iss=…
 *          ─ POST /api/oauth/token               (code + PKCE verifier)
 *          ◀ access token (1 h, audience = /api/mcp) + rotating refresh token
 *          ─ POST /api/mcp  Authorization: Bearer hbat_…
 *
 * Every function here is pure over an `IntegrationStore` and a clock, and
 * returns a status and a JSON body; the route handlers only parse requests
 * and serialize answers. No function here reads a session: the consent step
 * is handed an already-authenticated user id by its route.
 *
 * What is deliberately absent:
 *   - the implicit and password grants, and `plain` PKCE (OAuth 2.1 removes them);
 *   - Client ID Metadata Documents — supporting them means fetching a URL the
 *     client names, an outbound request this first release does not make;
 *   - client credentials, JWT bearer grants and token introspection.
 */

export const MCP_RESOURCE_PATH = "/api/mcp";

export function mcpResourceFor(issuer: string): string {
  return `${issuer}${MCP_RESOURCE_PATH}`;
}

export function protectedResourceMetadataUrl(issuer: string): string {
  return `${issuer}/.well-known/oauth-protected-resource${MCP_RESOURCE_PATH}`;
}

/** RFC 9728 protected resource metadata for the MCP endpoint. */
export function protectedResourceMetadata(issuer: string) {
  return {
    resource: mcpResourceFor(issuer),
    authorization_servers: [issuer],
    scopes_supported: [...HUBBLE_SCOPES],
    bearer_methods_supported: ["header"],
    resource_name: "Hubble",
    resource_documentation: `${issuer}/welcome`,
  };
}

/** RFC 8414 authorization server metadata. */
export function authorizationServerMetadata(issuer: string) {
  return {
    issuer,
    authorization_endpoint: `${issuer}/oauth/authorize`,
    token_endpoint: `${issuer}/api/oauth/token`,
    registration_endpoint: `${issuer}/api/oauth/register`,
    revocation_endpoint: `${issuer}/api/oauth/revoke`,
    response_types_supported: ["code"],
    response_modes_supported: ["query"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    token_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    revocation_endpoint_auth_methods_supported: ["none", "client_secret_post", "client_secret_basic"],
    scopes_supported: [...HUBBLE_SCOPES],
    // Every authorization response carries `iss` (RFC 9207).
    authorization_response_iss_parameter_supported: true,
    service_documentation: `${issuer}/welcome`,
  };
}

export type OAuthAnswer = { status: number; body: Record<string, unknown> };

function oauthError(status: number, error: string, description: string): OAuthAnswer {
  return { status, body: { error, error_description: description } };
}

/* ------------------------------------------------------------------ *
 * Redirect URIs
 * ------------------------------------------------------------------ */

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);
const MAX_REDIRECT_URIS = 5;
const MAX_REDIRECT_URI_LENGTH = 2000;

/**
 * Which redirect URIs a client may register: HTTPS anywhere, or plain HTTP to
 * this computer's loopback (a CLI's local callback, RFC 8252 §7.3). Never a
 * fragment, never credentials in the URL, never a custom scheme.
 */
export function isAcceptableRedirectUri(value: unknown): value is string {
  if (typeof value !== "string" || value.length === 0 || value.length > MAX_REDIRECT_URI_LENGTH) return false;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.hash || url.username || url.password) return false;
  if (url.protocol === "https:") return url.hostname.length > 0;
  if (url.protocol === "http:") return LOOPBACK_HOSTS.has(url.hostname);
  return false;
}

function isLoopback(url: URL): boolean {
  return url.protocol === "http:" && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Exact string match — except that a loopback redirect may use any port, as
 * RFC 8252 §7.3 requires, because a CLI picks a free port when it runs.
 */
export function redirectUriMatches(registered: string, presented: string): boolean {
  if (registered === presented) return true;
  let a: URL;
  let b: URL;
  try {
    a = new URL(registered);
    b = new URL(presented);
  } catch {
    return false;
  }
  if (!isLoopback(a) || !isLoopback(b)) return false;
  return a.hostname === b.hostname && a.pathname === b.pathname && a.search === b.search;
}

/* ------------------------------------------------------------------ *
 * Dynamic Client Registration (RFC 7591)
 * ------------------------------------------------------------------ */

const MAX_CLIENT_NAME = 60;

export function cleanLabel(value: unknown, max = MAX_CLIENT_NAME): string | undefined {
  if (typeof value !== "string") return undefined;
  const cleaned = value
    .replace(UNSAFE_ANY, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned) return undefined;
  return cleaned.length > max ? cleaned.slice(0, max) : cleaned;
}

export async function registerClient(store: IntegrationStore, body: unknown, now: number): Promise<OAuthAnswer> {
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    return oauthError(400, "invalid_client_metadata", "The registration request must be a JSON object.");
  }
  const input = body as Record<string, unknown>;

  const redirectUris = input.redirect_uris;
  if (!Array.isArray(redirectUris) || redirectUris.length === 0 || redirectUris.length > MAX_REDIRECT_URIS) {
    return oauthError(400, "invalid_redirect_uri", `Register between 1 and ${MAX_REDIRECT_URIS} redirect URIs.`);
  }
  if (!redirectUris.every(isAcceptableRedirectUri)) {
    return oauthError(400, "invalid_redirect_uri", "Redirect URIs must be HTTPS, or HTTP to localhost, with no fragment.");
  }

  const method = input.token_endpoint_auth_method ?? "none";
  if (method !== "none" && method !== "client_secret_post" && method !== "client_secret_basic") {
    return oauthError(400, "invalid_client_metadata", "Supported token endpoint auth methods: none, client_secret_post, client_secret_basic.");
  }

  const grantTypes = input.grant_types ?? ["authorization_code", "refresh_token"];
  if (!Array.isArray(grantTypes) || !grantTypes.every((g) => g === "authorization_code" || g === "refresh_token")) {
    return oauthError(400, "invalid_client_metadata", "Supported grant types: authorization_code, refresh_token.");
  }
  const responseTypes = input.response_types ?? ["code"];
  if (!Array.isArray(responseTypes) || !responseTypes.every((r) => r === "code")) {
    return oauthError(400, "invalid_client_metadata", "The only supported response type is code.");
  }

  const uris = [...new Set(redirectUris as string[])];
  const client = clientForRedirectUri(uris[0]);
  const clientName = cleanLabel(input.client_name) ?? CLIENT_NAME[client];
  const record: OAuthClientRecord = {
    clientId: mintClientId(),
    clientName,
    redirectUris: uris,
    tokenEndpointAuthMethod: method,
    createdAt: now,
  };
  let secret: string | undefined;
  if (method !== "none") {
    const minted = mintClientSecret();
    secret = minted.secret;
    record.secretHash = minted.secretHash;
  }
  await store.createOAuthClient(record);

  return {
    status: 201,
    body: {
      client_id: record.clientId,
      client_id_issued_at: Math.floor(now / 1000),
      ...(secret ? { client_secret: secret, client_secret_expires_at: 0 } : {}),
      client_name: record.clientName,
      redirect_uris: record.redirectUris,
      token_endpoint_auth_method: method,
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      scope: HUBBLE_SCOPES.join(" "),
    },
  };
}

/* ------------------------------------------------------------------ *
 * The authorization request
 * ------------------------------------------------------------------ */

export type AuthorizationParams = {
  response_type?: string | null;
  client_id?: string | null;
  redirect_uri?: string | null;
  code_challenge?: string | null;
  code_challenge_method?: string | null;
  state?: string | null;
  scope?: string | null;
  resource?: string | null;
};

export const AUTHORIZATION_PARAM_NAMES = [
  "response_type",
  "client_id",
  "redirect_uri",
  "code_challenge",
  "code_challenge_method",
  "state",
  "scope",
  "resource",
] as const;

export type ValidAuthorizationRequest = {
  clientId: string;
  /** Self-declared by the client at registration. Show as its claim. */
  clientName: string;
  /** Which product the verified redirect host belongs to. Display only. */
  client: IntegrationClient;
  /** Where the code will be sent — the thing a person should check. */
  redirectHost: string;
  redirectUri: string;
  codeChallenge: string;
  state?: string;
  resource: string;
  requestedLevel: PermissionLevel;
};

export type AuthorizationValidation =
  | { ok: true; request: ValidAuthorizationRequest }
  /** Not safe to redirect: the client or redirect URI could not be verified. Show the error to the person. */
  | { ok: false; redirect: false; error: string; description: string }
  /** Safe to report to the client at its verified redirect URI. */
  | { ok: false; redirect: true; location: string; error: string; description: string };

function normalizeResource(value: string): string {
  return value.endsWith("/") ? value.slice(0, -1) : value;
}

export function errorRedirect(redirectUri: string, issuer: string, error: string, description: string, state?: string): string {
  const url = new URL(redirectUri);
  url.searchParams.set("error", error);
  url.searchParams.set("error_description", description);
  if (state !== undefined) url.searchParams.set("state", state);
  url.searchParams.set("iss", issuer);
  return url.toString();
}

export async function validateAuthorizationRequest(
  store: IntegrationStore,
  params: AuthorizationParams,
  issuer: string
): Promise<AuthorizationValidation> {
  const clientId = params.client_id ?? "";
  if (!CLIENT_ID_PATTERN.test(clientId)) {
    return { ok: false, redirect: false, error: "invalid_client", description: "This app is not registered with Hubble." };
  }
  const client = await store.getOAuthClient(clientId);
  if (!client) return { ok: false, redirect: false, error: "invalid_client", description: "This app is not registered with Hubble." };

  let redirectUri: string | undefined;
  if (params.redirect_uri) {
    redirectUri = client.redirectUris.find((registered) => redirectUriMatches(registered, params.redirect_uri!)) ? params.redirect_uri : undefined;
  } else if (client.redirectUris.length === 1) {
    redirectUri = client.redirectUris[0];
  }
  if (!redirectUri) {
    return { ok: false, redirect: false, error: "invalid_request", description: "The redirect address does not match what this app registered." };
  }

  const state = params.state ?? undefined;
  if (state !== undefined && state.length > 1000) {
    return { ok: false, redirect: false, error: "invalid_request", description: "The state parameter is too long." };
  }
  const fail = (error: string, description: string): AuthorizationValidation => ({
    ok: false,
    redirect: true,
    location: errorRedirect(redirectUri!, issuer, error, description, state),
    error,
    description,
  });

  if (params.response_type !== "code") return fail("unsupported_response_type", "Only response_type=code is supported.");
  if (!params.code_challenge || params.code_challenge_method !== "S256") {
    return fail("invalid_request", "PKCE with code_challenge_method=S256 is required.");
  }
  if (!/^[A-Za-z0-9_-]{43}$/.test(params.code_challenge)) return fail("invalid_request", "The code challenge is not a valid S256 challenge.");

  const resource = mcpResourceFor(issuer);
  if (params.resource && normalizeResource(params.resource) !== resource) {
    return fail("invalid_target", "Hubble can only issue access to its MCP endpoint.");
  }

  return {
    ok: true,
    request: {
      clientId,
      clientName: client.clientName,
      client: clientForRedirectUri(redirectUri),
      redirectHost: new URL(redirectUri).host,
      redirectUri,
      codeChallenge: params.code_challenge,
      ...(state !== undefined ? { state } : {}),
      resource,
      requestedLevel: requestedLevel(params.scope),
    },
  };
}

/** At most this many live connections per account — generous, but finite. */
export const MAX_ACTIVE_CONNECTIONS = 25;
/** Workspaces one connection may be granted. */
export const MAX_GRANTED_WORKSPACES = 50;

/**
 * The person approved. Issues a single-use code bound to everything they
 * decided, and returns where to send the browser.
 *
 * `grantableWorkspaceIds` is the server's own list of the person's synced
 * workspaces; the chosen ids must all be in it. The consent page cannot
 * grant a workspace the account does not have.
 */
export async function approveAuthorization(
  store: IntegrationStore,
  input: {
    request: ValidAuthorizationRequest;
    issuer: string;
    userId: string;
    level: PermissionLevel;
    workspaceIds: readonly string[];
    grantableWorkspaceIds: ReadonlySet<string>;
    now: number;
  }
): Promise<{ ok: true; location: string } | { ok: false; reason: "no_workspaces" | "unknown_workspace" | "too_many_connections" }> {
  const chosen = [...new Set(input.workspaceIds)];
  if (chosen.length === 0) return { ok: false, reason: "no_workspaces" };
  if (chosen.length > MAX_GRANTED_WORKSPACES || !chosen.every((id) => input.grantableWorkspaceIds.has(id))) {
    return { ok: false, reason: "unknown_workspace" };
  }
  // An early answer for the consent page; the code exchange enforces the cap atomically.
  if ((await store.countActiveConnections(input.userId)) >= MAX_ACTIVE_CONNECTIONS) return { ok: false, reason: "too_many_connections" };

  const { code, codeHash } = mintAuthorizationCode();
  await store.createAuthorizationCode({
    codeHash,
    clientId: input.request.clientId,
    userId: input.userId,
    redirectUri: input.request.redirectUri,
    codeChallenge: input.request.codeChallenge,
    resource: input.request.resource,
    scopes: scopesFor(input.level),
    workspaceIds: chosen,
    client: input.request.client,
    label: input.request.clientName,
    createdAt: input.now,
    expiresAt: input.now + AUTHORIZATION_CODE_TTL_MS,
  });

  const url = new URL(input.request.redirectUri);
  url.searchParams.set("code", code);
  if (input.request.state !== undefined) url.searchParams.set("state", input.request.state);
  url.searchParams.set("iss", input.issuer);
  return { ok: true, location: url.toString() };
}

export function denyAuthorization(request: ValidAuthorizationRequest, issuer: string): string {
  return errorRedirect(request.redirectUri, issuer, "access_denied", "The person declined to connect Hubble.", request.state);
}

/* ------------------------------------------------------------------ *
 * The token endpoint
 * ------------------------------------------------------------------ */

export type ClientAuthentication = { clientId?: string; clientSecret?: string };

/** Client credentials from an `Authorization: Basic` header (RFC 6749 §2.3.1), if present. */
export function readBasicClientAuth(header: string | null): ClientAuthentication | undefined {
  if (!header) return undefined;
  const match = /^Basic\s+([A-Za-z0-9+/=]+)\s*$/i.exec(header);
  if (!match) return undefined;
  let decoded: string;
  try {
    decoded = Buffer.from(match[1], "base64").toString("utf8");
  } catch {
    return undefined;
  }
  const colon = decoded.indexOf(":");
  if (colon === -1) return undefined;
  try {
    return { clientId: decodeURIComponent(decoded.slice(0, colon)), clientSecret: decodeURIComponent(decoded.slice(colon + 1)) };
  } catch {
    return undefined;
  }
}

async function authenticateClient(
  store: IntegrationStore,
  form: URLSearchParams,
  basic: ClientAuthentication | undefined
): Promise<{ ok: true; client: OAuthClientRecord } | { ok: false; answer: OAuthAnswer }> {
  const invalid = { ok: false as const, answer: oauthError(401, "invalid_client", "Client authentication failed.") };
  const clientId = basic?.clientId ?? form.get("client_id") ?? "";
  if (!CLIENT_ID_PATTERN.test(clientId)) return invalid;
  const client = await store.getOAuthClient(clientId);
  if (!client) return invalid;
  if (basic?.clientId && form.get("client_id") && form.get("client_id") !== basic.clientId) return invalid;

  if (client.tokenEndpointAuthMethod === "none") {
    // A public client: PKCE is its proof. A secret it was never issued means
    // something is confused, not more trustworthy.
    if (basic?.clientSecret || form.get("client_secret")) return invalid;
    return { ok: true, client };
  }
  const presented = client.tokenEndpointAuthMethod === "client_secret_basic" ? basic?.clientSecret : form.get("client_secret");
  if (!isWellFormedClientSecret(presented) || !client.secretHash || !hashesEqual(sha256Hex(presented), client.secretHash)) return invalid;
  return { ok: true, client };
}

function tokenResponse(access: string, refresh: string, connection: ConnectionRecord): OAuthAnswer {
  return {
    status: 200,
    body: {
      access_token: access,
      token_type: "Bearer",
      expires_in: Math.floor(CREDENTIAL_TTL_MS.access / 1000),
      refresh_token: refresh,
      scope: connection.scopes.join(" "),
    },
  };
}

async function issuePair(store: IntegrationStore, connection: ConnectionRecord, resource: string, now: number) {
  const access = mintCredential("access");
  const refresh = mintCredential("refresh");
  await store.createCredential({
    id: mintRecordId("cred"),
    connectionId: connection.id,
    kind: "access",
    tokenHash: access.tokenHash,
    hint: access.hint,
    resource,
    createdAt: now,
    expiresAt: now + CREDENTIAL_TTL_MS.access,
  });
  await store.createCredential({
    id: mintRecordId("cred"),
    connectionId: connection.id,
    kind: "refresh",
    tokenHash: refresh.tokenHash,
    hint: refresh.hint,
    resource,
    createdAt: now,
    expiresAt: now + CREDENTIAL_TTL_MS.refresh,
  });
  return tokenResponse(access.token, refresh.token, connection);
}

const INVALID_GRANT = oauthError(400, "invalid_grant", "The authorization code or refresh token is invalid, expired or already used.");

export async function exchangeToken(
  store: IntegrationStore,
  form: URLSearchParams,
  basic: ClientAuthentication | undefined,
  issuer: string,
  now: number
): Promise<OAuthAnswer> {
  const grantType = form.get("grant_type");
  if (grantType !== "authorization_code" && grantType !== "refresh_token") {
    return oauthError(400, "unsupported_grant_type", "Supported grant types: authorization_code, refresh_token.");
  }
  const authenticated = await authenticateClient(store, form, basic);
  if (!authenticated.ok) return authenticated.answer;
  const { client } = authenticated;

  const requestedResource = form.get("resource");
  if (requestedResource && normalizeResource(requestedResource) !== mcpResourceFor(issuer)) {
    return oauthError(400, "invalid_target", "Hubble can only issue access to its MCP endpoint.");
  }

  if (grantType === "authorization_code") {
    const code = form.get("code");
    if (!isWellFormedAuthorizationCode(code)) return INVALID_GRANT;
    const consumed = await store.consumeAuthorizationCode(sha256Hex(code), now);
    if (!consumed) return INVALID_GRANT;
    const { record, alreadyUsed } = consumed;
    if (alreadyUsed) {
      // A replayed code: whatever it was exchanged for is no longer trusted
      // (OAuth 2.1 §4.1.3).
      if (record.connectionId) await store.revokeConnection(record.userId, record.connectionId, now);
      return INVALID_GRANT;
    }
    if (record.expiresAt <= now || record.clientId !== client.clientId) return INVALID_GRANT;
    const redirectUri = form.get("redirect_uri");
    if (redirectUri !== null && redirectUri !== record.redirectUri) return INVALID_GRANT;
    const verifier = form.get("code_verifier");
    if (!verifier || !verifyPkce(verifier, record.codeChallenge)) return INVALID_GRANT;

    const connection: ConnectionRecord = {
      id: mintRecordId("conn"),
      userId: record.userId,
      client: record.client,
      label: record.label,
      method: "oauth",
      oauthClientId: client.clientId,
      scopes: [...record.scopes],
      workspaceIds: [...record.workspaceIds],
      createdAt: now,
      updatedAt: now,
    };
    if (!(await store.createConnection(connection, MAX_ACTIVE_CONNECTIONS))) {
      return oauthError(400, "invalid_grant", "This Hubble account has too many AI connections. Disconnect one in Hubble first.");
    }
    await store.setAuthorizationCodeConnection(record.codeHash, connection.id);
    return issuePair(store, connection, record.resource, now);
  }

  const presented = form.get("refresh_token") ?? "";
  if (credentialKindOf(presented) !== "refresh") return INVALID_GRANT;
  const found = await store.findCredential(sha256Hex(presented));
  if (!found || found.credential.kind !== "refresh") return INVALID_GRANT;
  const { credential, connection } = found;
  if (connection.oauthClientId !== client.clientId) return INVALID_GRANT;
  if (credential.revokedAt !== undefined || connection.revokedAt !== undefined || credential.expiresAt <= now) return INVALID_GRANT;
  if (!(await store.markCredentialUsed(credential.id, now))) {
    // Rotation reuse: an old refresh token came back, so one copy is in the
    // wrong hands. Revoke the whole connection (OAuth 2.1 §4.3.1).
    await store.revokeConnection(connection.userId, connection.id, now);
    return INVALID_GRANT;
  }
  return issuePair(store, connection, credential.resource ?? mcpResourceFor(issuer), now);
}

/**
 * RFC 7009 revocation. Always 200 for a token the client could have held,
 * whether or not it was live — the endpoint is not an oracle. Revoking a
 * refresh token ends the connection; an access token ends only itself.
 */
export async function revokeToken(
  store: IntegrationStore,
  form: URLSearchParams,
  basic: ClientAuthentication | undefined,
  now: number
): Promise<OAuthAnswer> {
  const authenticated = await authenticateClient(store, form, basic);
  if (!authenticated.ok) return authenticated.answer;
  const token = form.get("token") ?? "";
  const kind = credentialKindOf(token);
  if (kind !== "access" && kind !== "refresh") return { status: 200, body: {} };
  const found = await store.findCredential(sha256Hex(token));
  if (!found || found.connection.oauthClientId !== authenticated.client.clientId) return { status: 200, body: {} };
  if (kind === "refresh") await store.revokeConnection(found.connection.userId, found.connection.id, now);
  else await store.revokeCredential(found.credential.id, now);
  return { status: 200, body: {} };
}
