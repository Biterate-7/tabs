// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { ALICE, BOB, BOB_SPACE, ENDPOINT, HISTORY, ISSUER, PHYSICS, createWorld } from "@/lib/integrations/__fixtures__/world";

/**
 * Hubble's OAuth authorization server as an AI client meets it: the real
 * route handlers for discovery, registration, consent, tokens, revocation
 * and /api/mcp, wired together in memory.
 *
 * The last block is the closest thing to connecting Claude without a Claude
 * account: the MCP SDK's own OAuth client (the code path claude.ai's custom
 * connectors and Claude Code follow) discovers, registers, is sent to the
 * consent step, which is driven through the same two requests the consent
 * page makes, and then uses, refreshes, loses and regains its connection.
 * Nothing leaves the process and there is no database.
 */

const USERS = {
  [ALICE]: { id: ALICE, name: "Alice", email: "alice@example.test" },
  [BOB]: { id: BOB, name: "Bob", email: "bob@example.test" },
} as const;
const CLAUDE_CALLBACK = "https://claude.ai/api/mcp/auth_callback";

let world = createWorld();
let signedIn: string | null = ALICE;
let storeState: "ready" | "not-migrated" | "unreachable" = "ready";

vi.mock("@/lib/auth/session", () => ({
  getSession: async () => (signedIn ? { ok: true, auth: { user: USERS[signedIn as keyof typeof USERS] } } : { ok: false, reason: "no-session" }),
}));
vi.mock("@/lib/sync/store", () => ({
  getSyncService: async () => ({ ok: true, service: world.sync }),
}));
vi.mock("@/lib/integrations/store-postgres", () => ({
  getIntegrationStore: async () => {
    if (storeState === "unreachable") throw new Error("connect ECONNREFUSED postgresql://owner:s3cret@db.internal/neondb");
    return storeState === "ready" ? world.store : undefined;
  },
}));
vi.mock("@/lib/mcp/services", () => ({
  getMcpDeps: async () => world.deps,
}));
vi.mock("@/lib/mcp/tokens-postgres", () => ({
  getMcpTokenStore: async () => world.tokens,
}));

const register = await import("./register/route");
const token = await import("./token/route");
const revoke = await import("./revoke/route");
const authorize = await import("./authorize/route");
const mcpRoute = await import("../mcp/route");
const connections = await import("../integrations/connections/route");
const resourceMetadata = await import("../../.well-known/oauth-protected-resource/api/mcp/route");
const resourceMetadataRoot = await import("../../.well-known/oauth-protected-resource/route");
const serverMetadata = await import("../../.well-known/oauth-authorization-server/route");

/** The deployment's public surface: each path to the route handler Next would run. */
async function serve(input: string | URL | Request, init?: RequestInit): Promise<Response> {
  const request = new Request(input, init);
  const { pathname } = new URL(request.url);
  const method = request.method;
  switch (pathname) {
    case "/.well-known/oauth-protected-resource/api/mcp":
      return resourceMetadata.GET(request);
    case "/.well-known/oauth-protected-resource":
      return resourceMetadataRoot.GET(request);
    case "/.well-known/oauth-authorization-server":
      return serverMetadata.GET(request);
    case "/api/oauth/register":
      return method === "OPTIONS" ? register.OPTIONS() : register.POST(request);
    case "/api/oauth/token":
      return method === "OPTIONS" ? token.OPTIONS() : token.POST(request);
    case "/api/oauth/revoke":
      return method === "OPTIONS" ? revoke.OPTIONS() : revoke.POST(request);
    case "/api/mcp":
      return mcpRoute.POST(request);
    default:
      return Response.json({ error: "not found" }, { status: 404 });
  }
}

/** A same-origin request from Hubble's own consent page. */
function page(path: string, method: "GET" | "POST", body?: unknown, headers: Record<string, string> = {}): Request {
  return new Request(`${ISSUER}${path}`, {
    method,
    headers: { origin: ISSUER, host: "hubble.test", "content-type": "application/json", ...headers },
    ...(body !== undefined ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

const form = (values: Record<string, string>, headers: Record<string, string> = {}) => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", ...headers },
  body: new URLSearchParams(values).toString(),
});

async function registerClient(metadata: Record<string, unknown> = {}) {
  const response = await serve(`${ISSUER}/api/oauth/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], ...metadata }),
  });
  return { response, body: await response.clone().json() };
}

/** Query parameters a client sends to /oauth/authorize, for a registered client. */
function authorizationParams(clientId: string, extra: Record<string, string> = {}) {
  return {
    response_type: "code",
    client_id: clientId,
    redirect_uri: CLAUDE_CALLBACK,
    code_challenge: "E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM",
    code_challenge_method: "S256",
    state: "state-123",
    resource: ENDPOINT,
    ...extra,
  };
}

beforeEach(() => {
  world = createWorld();
  signedIn = ALICE;
  storeState = "ready";
});

describe("discovery and CORS", () => {
  it("publishes metadata that points at these endpoints, cacheable and readable cross-origin", async () => {
    const resource = await serve(`${ISSUER}/.well-known/oauth-protected-resource/api/mcp`);
    const server = await serve(`${ISSUER}/.well-known/oauth-authorization-server`);
    expect(resource.headers.get("access-control-allow-origin")).toBe("*");
    expect(resource.headers.get("cache-control")).toContain("public");
    const { authorization_servers, resource: name } = await resource.json();
    expect(name).toBe(ENDPOINT);
    expect(authorization_servers).toEqual([ISSUER]);
    const metadata = await server.json();
    expect(metadata).toMatchObject({
      issuer: ISSUER,
      registration_endpoint: `${ISSUER}/api/oauth/register`,
      token_endpoint: `${ISSUER}/api/oauth/token`,
      revocation_endpoint: `${ISSUER}/api/oauth/revoke`,
    });
  });

  it.each(["/api/oauth/register", "/api/oauth/token", "/api/oauth/revoke"])("answers a CORS preflight on %s", async (path) => {
    const response = await serve(`${ISSUER}${path}`, { method: "OPTIONS" });
    expect(response.status).toBe(204);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("access-control-allow-headers")).toContain("authorization");
  });
});

describe("when the database cannot serve OAuth", () => {
  it.each(["not-migrated", "unreachable"] as const)("every endpoint answers 503 (%s), saying nothing about why", async (state) => {
    storeState = state;
    const answers = [
      (await registerClient()).response,
      await serve(`${ISSUER}/api/oauth/token`, form({ grant_type: "authorization_code", code: "x" })),
      await serve(`${ISSUER}/api/oauth/revoke`, form({ token: "x" })),
      await authorize.GET(page(`/api/oauth/authorize?${new URLSearchParams(authorizationParams("hbcl_x"))}`, "GET")),
      await authorize.POST(page("/api/oauth/authorize", "POST", { params: authorizationParams("hbcl_x"), decision: "approve" })),
    ];
    for (const response of answers) {
      expect(response.status).toBe(503);
      expect(await response.text()).not.toMatch(/ECONNREFUSED|postgres|s3cret|db\.internal/i);
    }
  });
});

describe("registration", () => {
  it("registers a public client, uncached", async () => {
    const { response, body } = await registerClient();
    expect(response.status).toBe(201);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(body.client_id).toMatch(/^hbcl_/);
    expect(body.client_secret).toBeUndefined();
  });

  it("refuses a body that is not JSON, one that is too large, and a non-HTTPS redirect", async () => {
    const notJson = await serve(`${ISSUER}/api/oauth/register`, { method: "POST", body: "client_name=x" });
    expect(notJson.status).toBe(400);
    expect((await notJson.json()).error).toBe("invalid_client_metadata");
    const huge = await registerClient({ client_name: "x".repeat(17 * 1024) });
    expect(huge.response.status).toBe(400);
    const http = await registerClient({ redirect_uris: ["http://attacker.example/callback"] });
    expect(http.response.status).toBe(400);
    expect(await world.store.getOAuthClient("hbcl_none")).toBeUndefined();
  });

  it("limits registrations per address, without touching another address", async () => {
    const from = (ip: string) =>
      serve(`${ISSUER}/api/oauth/register`, {
        method: "POST",
        headers: { "content-type": "application/json", "x-forwarded-for": ip },
        body: JSON.stringify({ client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK] }),
      });
    const busy = "203.0.113.77";
    for (let i = 0; i < 30; i++) expect((await from(busy)).status).toBe(201);
    const limited = await from(busy);
    expect(limited.status).toBe(429);
    expect((await limited.json()).error).toBe("slow_down");
    expect((await from("203.0.113.78")).status).toBe(201);
  });
});

describe("the consent step (/api/oauth/authorize)", () => {
  it("describes a valid request to a signed-in person with only their own workspaces", async () => {
    const { body: client } = await registerClient();
    const response = await authorize.GET(page(`/api/oauth/authorize?${new URLSearchParams(authorizationParams(client.client_id))}`, "GET"));
    const { value } = await response.json();
    expect(value).toMatchObject({ valid: true, signedIn: true, request: { client: "claude", redirectHost: "claude.ai" } });
    expect(value.workspaces.map((w: { id: string }) => w.id).sort()).toEqual([HISTORY, PHYSICS].sort());
    expect(JSON.stringify(value)).not.toContain(BOB_SPACE);
  });

  it("tells a signed-out visitor to sign in, listing nothing", async () => {
    signedIn = null;
    const { body: client } = await registerClient();
    const { value } = await (await authorize.GET(page(`/api/oauth/authorize?${new URLSearchParams(authorizationParams(client.client_id))}`, "GET"))).json();
    expect(value).toMatchObject({ valid: true, signedIn: false });
    expect(value.workspaces).toBeUndefined();
  });

  it("never offers a redirect for an unknown client or an unregistered redirect URI", async () => {
    const { body: client } = await registerClient();
    for (const params of [authorizationParams("hbcl_unknown"), authorizationParams(client.client_id, { redirect_uri: "https://attacker.example/cb" })]) {
      const get = await (await authorize.GET(page(`/api/oauth/authorize?${new URLSearchParams(params)}`, "GET"))).json();
      expect(get.value.valid).toBe(false);
      expect(get.value.redirect).toBeUndefined();
      const post = await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve", permission: "read", workspaceIds: [PHYSICS] }));
      expect(post.status).toBe(400);
      expect(JSON.stringify(await post.json())).not.toContain("attacker.example");
    }
  });

  it("refuses a cross-site page and a non-JSON post", async () => {
    const { body: client } = await registerClient();
    const params = authorizationParams(client.client_id);
    expect((await authorize.GET(page(`/api/oauth/authorize?${new URLSearchParams(params)}`, "GET", undefined, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve" }, { origin: "https://evil.example" }))).status).toBe(403);
    expect((await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve" }, { "content-type": "text/plain" }))).status).toBe(403);
  });

  it("lets a signed-out person decline, sending the client access_denied with its state", async () => {
    signedIn = null;
    const { body: client } = await registerClient();
    const response = await authorize.POST(page("/api/oauth/authorize", "POST", { params: authorizationParams(client.client_id), decision: "deny" }));
    const redirect = new URL((await response.json()).value.redirect);
    expect(redirect.origin + redirect.pathname).toBe(CLAUDE_CALLBACK);
    expect(redirect.searchParams.get("error")).toBe("access_denied");
    expect(redirect.searchParams.get("state")).toBe("state-123");
    expect(redirect.searchParams.get("iss")).toBe(ISSUER);
    expect(redirect.searchParams.get("code")).toBeNull();
  });

  it("approves only for a signed-in person, a permission, and their own workspaces", async () => {
    const { body: client } = await registerClient();
    const params = authorizationParams(client.client_id);
    signedIn = null;
    expect((await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve", permission: "read", workspaceIds: [PHYSICS] }))).status).toBe(401);
    signedIn = ALICE;
    expect((await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve", workspaceIds: [PHYSICS] }))).status).toBe(400);
    const foreign = await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve", permission: "read", workspaceIds: [BOB_SPACE] }));
    expect(foreign.status).toBe(400);
    expect((await foreign.json()).error.code).toBe("unknown_workspace");

    const approved = await authorize.POST(page("/api/oauth/authorize", "POST", { params, decision: "approve", permission: "read", workspaceIds: [PHYSICS] }));
    expect(approved.status).toBe(200);
    const redirect = new URL((await approved.json()).value.redirect);
    expect(redirect.searchParams.get("code")).toMatch(/^hbcode_/);
    expect(redirect.searchParams.get("state")).toBe("state-123");
  });
});

describe("the token and revocation endpoints", () => {
  it("accept only form-encoded requests and refuse an unknown code as invalid_grant", async () => {
    const json = await serve(`${ISSUER}/api/oauth/token`, { method: "POST", headers: { "content-type": "application/json" }, body: "{}" });
    expect(json.status).toBe(400);
    expect((await json.json()).error).toBe("invalid_request");
    const { body: client } = await registerClient();
    const unknown = await serve(`${ISSUER}/api/oauth/token`, form({ grant_type: "authorization_code", code: "hbcode_" + "A".repeat(43), code_verifier: "v".repeat(43), client_id: client.client_id }));
    expect(unknown.status).toBe(400);
    expect((await unknown.json()).error).toBe("invalid_grant");
    expect(unknown.headers.get("cache-control")).toBe("no-store");
  });

  it("challenges a confidential client that sends the wrong secret", async () => {
    const { body: client } = await registerClient({ token_endpoint_auth_method: "client_secret_basic" });
    expect(client.client_secret).toBeTruthy();
    const basic = Buffer.from(`${client.client_id}:wrong-secret`).toString("base64");
    const response = await serve(`${ISSUER}/api/oauth/token`, form({ grant_type: "refresh_token", refresh_token: "hbrt_" + "A".repeat(43) }, { authorization: `Basic ${basic}` }));
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Basic");
    expect(JSON.stringify(await response.json())).not.toContain(client.client_secret);
  });
});

/* ------------------------------------------------------------------ *
 * A Claude-like client, end to end, through the routes
 * ------------------------------------------------------------------ */

class ClaudeLikeProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  get redirectUrl() {
    return CLAUDE_CALLBACK;
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude", redirect_uris: [CLAUDE_CALLBACK], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
  }
  clientInformation() {
    return this.info;
  }
  saveClientInformation(info: OAuthClientInformationMixed) {
    this.info = info;
  }
  tokens() {
    return this.saved;
  }
  saveTokens(tokens: OAuthTokens) {
    this.saved = tokens;
  }
  redirectToAuthorization(url: URL) {
    this.authorizationUrl = url;
  }
  saveCodeVerifier(verifier: string) {
    this.verifier = verifier;
  }
  codeVerifier() {
    return this.verifier;
  }
}

/** Connect with the SDK; when it needs a person, approve through the consent routes and finish. */
async function connectAsClaude(provider: ClaudeLikeProvider, consent: { permission: "read" | "write"; workspaceIds: string[] }) {
  const transport = new StreamableHTTPClientTransport(new URL(ENDPOINT), { authProvider: provider, fetch: serve });
  const attempt = new Client({ name: "claude-like", version: "1" });
  await expect(attempt.connect(transport)).rejects.toBeInstanceOf(UnauthorizedError);

  // The consent page: read the request, then post the person's decision — the two requests oauth-consent.tsx makes.
  const url = provider.authorizationUrl!;
  expect(url.origin + url.pathname).toBe(`${ISSUER}/oauth/authorize`);
  const shown = await (await authorize.GET(page(`/api/oauth/authorize${url.search}`, "GET"))).json();
  expect(shown.value).toMatchObject({ valid: true, signedIn: true, request: { client: "claude" } });
  const decided = await authorize.POST(page("/api/oauth/authorize", "POST", { params: Object.fromEntries(url.searchParams), decision: "approve", ...consent }));
  const code = new URL((await decided.json()).value.redirect).searchParams.get("code")!;

  await transport.finishAuth(code);
  const client = new Client({ name: "claude-like", version: "1" });
  await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { authProvider: provider, fetch: serve }));
  return client;
}

async function bearerWorks(accessToken: string): Promise<boolean> {
  const client = new Client({ name: "bearer-check", version: "1" });
  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { requestInit: { headers: { authorization: `Bearer ${accessToken}` } }, fetch: serve }));
    return !(await client.callTool({ name: "get_connection_info", arguments: {} })).isError;
  } catch {
    return false;
  }
}

describe("a Claude-like connector, end to end through the routes", () => {
  it("connects, refreshes, is cut off by a replayed refresh token, and reconnects with the same registration", async () => {
    const provider = new ClaudeLikeProvider();
    const client = await connectAsClaude(provider, { permission: "write", workspaceIds: [PHYSICS] });
    expect(provider.info?.client_id).toMatch(/^hbcl_/);
    expect(provider.saved?.access_token).toMatch(/^hbat_/);

    const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
    const workspaces = JSON.parse((listed.content as { text: string }[])[0].text).workspaces.map((w: { workspaceId: string }) => w.workspaceId);
    expect(workspaces).toEqual([PHYSICS]);
    expect((await client.listTools()).tools.map((t) => t.name)).toContain("save_workspace_note");

    // Refresh through the token route: a new pair that works.
    const first = provider.saved!;
    const refreshed = await serve(`${ISSUER}/api/oauth/token`, form({ grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: provider.info!.client_id }));
    expect(refreshed.status).toBe(200);
    const second = (await refreshed.json()) as OAuthTokens;
    expect(await bearerWorks(second.access_token)).toBe(true);

    // The first refresh token comes back: someone else has a copy, so the whole connection ends.
    const replay = await serve(`${ISSUER}/api/oauth/token`, form({ grant_type: "refresh_token", refresh_token: first.refresh_token!, client_id: provider.info!.client_id }));
    expect(replay.status).toBe(400);
    expect((await replay.json()).error).toBe("invalid_grant");
    expect(await bearerWorks(second.access_token)).toBe(false);
    expect(await world.store.countActiveConnections(ALICE)).toBe(0);

    // Reconnect: the client keeps its registration and goes through consent again.
    const registeredAs = provider.info!.client_id;
    provider.saved = undefined;
    const again = await connectAsClaude(provider, { permission: "read", workspaceIds: [PHYSICS, HISTORY] });
    expect(provider.info!.client_id).toBe(registeredAs);
    expect((await again.listTools()).tools.map((t) => t.name)).not.toContain("save_workspace_note");
    expect(await bearerWorks(second.access_token)).toBe(false);
    const active = (await world.store.listConnections(ALICE)).filter((c) => c.revokedAt === undefined);
    expect(active).toHaveLength(1);
    expect(active[0]).toMatchObject({ client: "claude", method: "oauth", workspaceIds: [PHYSICS, HISTORY] });
  });

  it("is disconnected by the client's own revocation, and by the person in Settings", async () => {
    // The client revokes its refresh token (RFC 7009): the connection ends.
    const viaClient = new ClaudeLikeProvider();
    await connectAsClaude(viaClient, { permission: "read", workspaceIds: [PHYSICS] });
    const revoked = await serve(`${ISSUER}/api/oauth/revoke`, form({ token: viaClient.saved!.refresh_token!, client_id: viaClient.info!.client_id }));
    expect(revoked.status).toBe(200);
    expect(await bearerWorks(viaClient.saved!.access_token)).toBe(false);

    // The person disconnects in Settings: access and refresh both stop working.
    const viaSettings = new ClaudeLikeProvider();
    await connectAsClaude(viaSettings, { permission: "read", workspaceIds: [PHYSICS] });
    const [connection] = (await world.store.listConnections(ALICE)).filter((c) => c.revokedAt === undefined);
    const disconnected = await connections.DELETE(page("/api/integrations/connections", "POST", { connectionId: connection.id }));
    expect(disconnected.status).toBe(200);
    expect(await bearerWorks(viaSettings.saved!.access_token)).toBe(false);
    const refresh = await serve(`${ISSUER}/api/oauth/token`, form({ grant_type: "refresh_token", refresh_token: viaSettings.saved!.refresh_token!, client_id: viaSettings.info!.client_id }));
    expect(refresh.status).toBe(400);

    // Revoking an unknown token is still 200: the endpoint is not an oracle.
    expect((await serve(`${ISSUER}/api/oauth/revoke`, form({ token: "hbrt_" + "Z".repeat(43), client_id: viaSettings.info!.client_id }))).status).toBe(200);
  });

  it("answers an unauthenticated /api/mcp call with a 401 that points at the metadata", async () => {
    const response = await serve(ENDPOINT, { method: "POST", headers: { "content-type": "application/json", accept: "application/json, text/event-stream" }, body: "{}" });
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain(`resource_metadata="${ISSUER}/.well-known/oauth-protected-resource/api/mcp"`);
  });
});
