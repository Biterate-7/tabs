// @vitest-environment node
import { createHash, randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { UnauthorizedError } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientProvider } from "@modelcontextprotocol/sdk/client/auth.js";
import type { OAuthClientInformationMixed, OAuthClientMetadata, OAuthTokens } from "@modelcontextprotocol/sdk/shared/auth.js";
import { handleMcpHttpRequest } from "@/lib/mcp/http";
import {
  approveAuthorization,
  authorizationServerMetadata,
  exchangeToken,
  isAcceptableRedirectUri,
  protectedResourceMetadata,
  readBasicClientAuth,
  redirectUriMatches,
  registerClient,
  revokeToken,
  validateAuthorizationRequest,
} from "./oauth";
import { ALICE, BOB, BOB_SPACE, ENDPOINT, HISTORY, ISSUER, PHYSICS, createWorld } from "./__fixtures__/world";
import type { IntegrationStore } from "./store";

const CHATGPT_REDIRECT = "https://chatgpt.com/connector/oauth/abc123";
const NOW = 1_800_000_000_000;

function pkce() {
  const verifier = randomBytes(32).toString("base64url");
  return { verifier, challenge: createHash("sha256").update(verifier).digest("base64url") };
}

async function register(store: IntegrationStore, overrides: Record<string, unknown> = {}) {
  const answer = await registerClient(store, { client_name: "ChatGPT", redirect_uris: [CHATGPT_REDIRECT], ...overrides }, NOW);
  expect(answer.status).toBe(201);
  return answer.body as { client_id: string; client_secret?: string };
}

/** register → validate → approve → the code, as the consent page would obtain it. */
async function authorize(store: IntegrationStore, input: { level?: "read" | "write"; workspaces?: string[]; userId?: string } = {}) {
  const client = await register(store);
  const { verifier, challenge } = pkce();
  const validation = await validateAuthorizationRequest(
    store,
    { response_type: "code", client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, code_challenge: challenge, code_challenge_method: "S256", state: "s-1", resource: `${ISSUER}/api/mcp` },
    ISSUER
  );
  if (!validation.ok) throw new Error(validation.description);
  const approved = await approveAuthorization(store, {
    request: validation.request,
    issuer: ISSUER,
    userId: input.userId ?? ALICE,
    level: input.level ?? "read",
    workspaceIds: input.workspaces ?? [PHYSICS],
    grantableWorkspaceIds: new Set([PHYSICS, HISTORY]),
    now: NOW,
  });
  if (!approved.ok) throw new Error(approved.reason);
  const location = new URL(approved.location);
  return { client, verifier, code: location.searchParams.get("code")!, location };
}

const form = (values: Record<string, string>) => new URLSearchParams(values);

describe("metadata", () => {
  it("publishes RFC 9728 and RFC 8414 documents that agree on the issuer", () => {
    const resource = protectedResourceMetadata(ISSUER);
    const server = authorizationServerMetadata(ISSUER);
    expect(resource.resource).toBe(ENDPOINT);
    expect(resource.authorization_servers).toEqual([server.issuer]);
    expect(server.code_challenge_methods_supported).toEqual(["S256"]);
    expect(server.grant_types_supported).toEqual(["authorization_code", "refresh_token"]);
    expect(server.registration_endpoint).toBe(`${ISSUER}/api/oauth/register`);
    expect(server.authorization_response_iss_parameter_supported).toBe(true);
    expect(server).not.toHaveProperty("client_id_metadata_document_supported");
  });
});

describe("dynamic client registration", () => {
  it("accepts HTTPS and loopback redirects, refuses everything else", () => {
    expect(isAcceptableRedirectUri("https://claude.ai/api/mcp/auth_callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://localhost:7777/oauth/callback")).toBe(true);
    expect(isAcceptableRedirectUri("http://127.0.0.1:51234/cb")).toBe(true);
    for (const bad of ["http://evil.example.com/cb", "https://a.example/cb#frag", "https://u:p@a.example/cb", "javascript:alert(1)", "myapp://cb", ""]) {
      expect(isAcceptableRedirectUri(bad), bad).toBe(false);
    }
  });

  it("matches loopback redirects on any port, everything else exactly", () => {
    expect(redirectUriMatches("http://localhost:7777/oauth/callback", "http://localhost:50111/oauth/callback")).toBe(true);
    expect(redirectUriMatches("http://localhost:7777/oauth/callback", "http://localhost:7777/other")).toBe(false);
    expect(redirectUriMatches(CHATGPT_REDIRECT, `${CHATGPT_REDIRECT}/`)).toBe(false);
    expect(redirectUriMatches("https://a.example:443/cb", "https://a.example:8443/cb")).toBe(false);
  });

  it("issues a public client by default and a hashed secret only when asked", async () => {
    const world = createWorld();
    const publicClient = await register(world.store);
    expect(publicClient.client_secret).toBeUndefined();
    const confidential = await register(world.store, { token_endpoint_auth_method: "client_secret_basic" });
    expect(confidential.client_secret).toMatch(/^hbcs_/);
    const stored = await world.store.getOAuthClient(confidential.client_id);
    expect(JSON.stringify(stored)).not.toContain(confidential.client_secret!);
  });

  it("refuses malformed registrations", async () => {
    const world = createWorld();
    for (const body of [null, [], { redirect_uris: [] }, { redirect_uris: ["http://evil.example/cb"] }, { redirect_uris: [CHATGPT_REDIRECT], grant_types: ["password"] }, { redirect_uris: [CHATGPT_REDIRECT], token_endpoint_auth_method: "private_key_jwt" }]) {
      expect((await registerClient(world.store, body, NOW)).status).toBe(400);
    }
  });
});

describe("the authorization request", () => {
  it("never redirects to an unverified client or redirect URI", async () => {
    const world = createWorld();
    const client = await register(world.store);
    const unknown = await validateAuthorizationRequest(world.store, { client_id: "hbcl_AAAAAAAAAAAAAAAAAAAAAA", redirect_uri: CHATGPT_REDIRECT }, ISSUER);
    expect(unknown).toMatchObject({ ok: false, redirect: false });
    const wrongRedirect = await validateAuthorizationRequest(world.store, { client_id: client.client_id, redirect_uri: "https://attacker.example/cb" }, ISSUER);
    expect(wrongRedirect).toMatchObject({ ok: false, redirect: false });
  });

  it("reports protocol errors to the verified redirect with state and iss", async () => {
    const world = createWorld();
    const client = await register(world.store);
    const noPkce = await validateAuthorizationRequest(world.store, { response_type: "code", client_id: client.client_id, state: "xyz" }, ISSUER);
    expect(noPkce.ok).toBe(false);
    if (noPkce.ok || !noPkce.redirect) throw new Error("expected a redirect");
    const url = new URL(noPkce.location);
    expect(url.origin + url.pathname).toBe(CHATGPT_REDIRECT);
    expect(url.searchParams.get("error")).toBe("invalid_request");
    expect(url.searchParams.get("state")).toBe("xyz");
    expect(url.searchParams.get("iss")).toBe(ISSUER);

    const otherResource = await validateAuthorizationRequest(
      world.store,
      { response_type: "code", client_id: client.client_id, code_challenge: pkce().challenge, code_challenge_method: "S256", resource: "https://elsewhere.example/api/mcp" },
      ISSUER
    );
    expect(otherResource).toMatchObject({ ok: false, error: "invalid_target" });
  });

  it("reads the requested scope as a hint, never a grant", async () => {
    const world = createWorld();
    const client = await register(world.store);
    const v = await validateAuthorizationRequest(
      world.store,
      { response_type: "code", client_id: client.client_id, code_challenge: pkce().challenge, code_challenge_method: "S256", scope: "hubble.write admin everything" },
      ISSUER
    );
    expect(v.ok && v.request.requestedLevel).toBe("write");
  });

  it("refuses to grant a workspace the account does not have synced", async () => {
    const world = createWorld();
    const client = await register(world.store);
    const v = await validateAuthorizationRequest(world.store, { response_type: "code", client_id: client.client_id, code_challenge: pkce().challenge, code_challenge_method: "S256" }, ISSUER);
    if (!v.ok) throw new Error("fixture");
    const result = await approveAuthorization(world.store, { request: v.request, issuer: ISSUER, userId: ALICE, level: "read", workspaceIds: [BOB_SPACE], grantableWorkspaceIds: new Set([PHYSICS]), now: NOW });
    expect(result).toEqual({ ok: false, reason: "unknown_workspace" });
    const none = await approveAuthorization(world.store, { request: v.request, issuer: ISSUER, userId: ALICE, level: "read", workspaceIds: [], grantableWorkspaceIds: new Set([PHYSICS]), now: NOW });
    expect(none).toEqual({ ok: false, reason: "no_workspaces" });
  });
});

describe("the token endpoint", () => {
  it("exchanges a code with the right PKCE verifier for an audience-bound pair", async () => {
    const world = createWorld();
    const { client, verifier, code, location } = await authorize(world.store);
    expect(location.searchParams.get("state")).toBe("s-1");
    const answer = await exchangeToken(world.store, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id, redirect_uri: CHATGPT_REDIRECT, resource: ENDPOINT }), undefined, ISSUER, NOW);
    expect(answer.status).toBe(200);
    expect(answer.body).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "hubble.read" });
    expect(String(answer.body.access_token)).toMatch(/^hbat_/);
    expect(String(answer.body.refresh_token)).toMatch(/^hbrt_/);
    const [connection] = await world.store.listConnections(ALICE);
    expect(connection).toMatchObject({ client: "chatgpt", method: "oauth", workspaceIds: [PHYSICS], scopes: ["hubble.read"] });
    expect(world.store.credentials.find((c) => c.kind === "access")?.resource).toBe(ENDPOINT);
  });

  it("refuses a wrong verifier, a wrong client, a wrong redirect and an expired code", async () => {
    const world = createWorld();
    const a = await authorize(world.store);
    expect((await exchangeToken(world.store, form({ grant_type: "authorization_code", code: a.code, code_verifier: pkce().verifier, client_id: a.client.client_id }), undefined, ISSUER, NOW)).body.error).toBe("invalid_grant");

    const b = await authorize(world.store);
    const other = await register(world.store);
    expect((await exchangeToken(world.store, form({ grant_type: "authorization_code", code: b.code, code_verifier: b.verifier, client_id: other.client_id }), undefined, ISSUER, NOW)).body.error).toBe("invalid_grant");

    const c = await authorize(world.store);
    expect((await exchangeToken(world.store, form({ grant_type: "authorization_code", code: c.code, code_verifier: c.verifier, client_id: c.client.client_id, redirect_uri: "https://chatgpt.com/other" }), undefined, ISSUER, NOW)).body.error).toBe("invalid_grant");

    const d = await authorize(world.store);
    expect((await exchangeToken(world.store, form({ grant_type: "authorization_code", code: d.code, code_verifier: d.verifier, client_id: d.client.client_id }), undefined, ISSUER, NOW + 6 * 60 * 1000)).body.error).toBe("invalid_grant");

    expect(await world.store.countActiveConnections(ALICE)).toBe(0);
  });

  it("revokes what a code bought when the code is replayed", async () => {
    const world = createWorld();
    const { client, verifier, code } = await authorize(world.store);
    const first = await exchangeToken(world.store, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }), undefined, ISSUER, NOW);
    expect(first.status).toBe(200);
    const replay = await exchangeToken(world.store, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }), undefined, ISSUER, NOW);
    expect(replay.body.error).toBe("invalid_grant");
    expect(await world.store.countActiveConnections(ALICE)).toBe(0);
  });

  it("rotates refresh tokens and revokes the connection when an old one comes back", async () => {
    const world = createWorld();
    const { client, verifier, code } = await authorize(world.store);
    const first = await exchangeToken(world.store, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }), undefined, ISSUER, NOW);
    const refresh1 = String(first.body.refresh_token);
    const second = await exchangeToken(world.store, form({ grant_type: "refresh_token", refresh_token: refresh1, client_id: client.client_id }), undefined, ISSUER, NOW + 1000);
    expect(second.status).toBe(200);
    expect(second.body.refresh_token).not.toBe(refresh1);

    const reuse = await exchangeToken(world.store, form({ grant_type: "refresh_token", refresh_token: refresh1, client_id: client.client_id }), undefined, ISSUER, NOW + 2000);
    expect(reuse.body.error).toBe("invalid_grant");
    const after = await exchangeToken(world.store, form({ grant_type: "refresh_token", refresh_token: String(second.body.refresh_token), client_id: client.client_id }), undefined, ISSUER, NOW + 3000);
    expect(after.body.error).toBe("invalid_grant");
  });

  it("authenticates confidential clients and refuses a public client that sends a secret", async () => {
    const world = createWorld();
    const confidential = await register(world.store, { token_endpoint_auth_method: "client_secret_basic" });
    const basic = readBasicClientAuth(`Basic ${Buffer.from(`${confidential.client_id}:${confidential.client_secret}`).toString("base64")}`);
    expect(basic).toEqual({ clientId: confidential.client_id, clientSecret: confidential.client_secret });
    const badSecret = await exchangeToken(world.store, form({ grant_type: "refresh_token", refresh_token: "x" }), { clientId: confidential.client_id, clientSecret: "hbcs_" + "A".repeat(43) }, ISSUER, NOW);
    expect(badSecret.status).toBe(401);
    const publicClient = await register(world.store);
    const withSecret = await exchangeToken(world.store, form({ grant_type: "refresh_token", refresh_token: "x", client_id: publicClient.client_id, client_secret: "hbcs_" + "A".repeat(43) }), undefined, ISSUER, NOW);
    expect(withSecret.status).toBe(401);
  });

  it("revocation ends the connection for a refresh token and is not an oracle", async () => {
    const world = createWorld();
    const { client, verifier, code } = await authorize(world.store);
    const pair = await exchangeToken(world.store, form({ grant_type: "authorization_code", code, code_verifier: verifier, client_id: client.client_id }), undefined, ISSUER, NOW);
    expect((await revokeToken(world.store, form({ token: "hbrt_" + "B".repeat(43), client_id: client.client_id }), undefined, NOW)).status).toBe(200);
    expect(await world.store.countActiveConnections(ALICE)).toBe(1);
    expect((await revokeToken(world.store, form({ token: String(pair.body.refresh_token), client_id: client.client_id }), undefined, NOW)).status).toBe(200);
    expect(await world.store.countActiveConnections(ALICE)).toBe(0);
  });
});

/* ------------------------------------------------------------------ *
 * End to end, driven by the MCP SDK's own OAuth client
 * ------------------------------------------------------------------ */

class TestProvider implements OAuthClientProvider {
  info?: OAuthClientInformationMixed;
  saved?: OAuthTokens;
  verifier = "";
  authorizationUrl?: URL;
  get redirectUrl() {
    return "https://claude.ai/api/mcp/auth_callback";
  }
  get clientMetadata(): OAuthClientMetadata {
    return { client_name: "Claude", redirect_uris: [this.redirectUrl], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" };
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

/** The deployment's public surface, routed in memory to the same functions the route handlers call. */
function serve(world: ReturnType<typeof createWorld>) {
  return async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    const json = (status: number, body: unknown) => Response.json(body, { status });
    switch (url.pathname) {
      case "/.well-known/oauth-protected-resource/api/mcp":
      case "/.well-known/oauth-protected-resource":
        return json(200, protectedResourceMetadata(ISSUER));
      case "/.well-known/oauth-authorization-server":
        return json(200, authorizationServerMetadata(ISSUER));
      case "/api/oauth/register": {
        const answer = await registerClient(world.store, await request.json(), Date.now());
        return json(answer.status, answer.body);
      }
      case "/api/oauth/token": {
        const answer = await exchangeToken(world.store, new URLSearchParams(await request.text()), readBasicClientAuth(request.headers.get("authorization")), ISSUER, Date.now());
        return json(answer.status, answer.body);
      }
      case "/api/mcp":
        return handleMcpHttpRequest(request, world.deps);
      default:
        return json(404, { error: "not found" });
    }
  };
}

describe("OAuth end to end with the official MCP client", () => {
  it("discovers, registers, authorizes with PKCE, exchanges, calls tools, and survives a refresh", async () => {
    const world = createWorld();
    const fetch = serve(world);
    const provider = new TestProvider();

    // 1. Unauthenticated: the client discovers Hubble's metadata, registers
    //    itself and asks the person to authorize.
    const first = new StreamableHTTPClientTransport(new URL(ENDPOINT), { authProvider: provider, fetch });
    await expect(new Client({ name: "claude-like", version: "1" }).connect(first)).rejects.toBeInstanceOf(UnauthorizedError);
    expect(provider.info?.client_id).toMatch(/^hbcl_/);
    const authorizationUrl = provider.authorizationUrl!;
    expect(authorizationUrl.origin + authorizationUrl.pathname).toBe(`${ISSUER}/oauth/authorize`);
    expect(authorizationUrl.searchParams.get("code_challenge_method")).toBe("S256");
    expect(authorizationUrl.searchParams.get("resource")).toBe(ENDPOINT);

    // 2. The person approves on Hubble's consent page: read and save, Physics only.
    const params = Object.fromEntries(authorizationUrl.searchParams);
    const validation = await validateAuthorizationRequest(world.store, params, ISSUER);
    if (!validation.ok) throw new Error(validation.description);
    expect(validation.request).toMatchObject({ client: "claude", redirectHost: "claude.ai" });
    const approved = await approveAuthorization(world.store, {
      request: validation.request,
      issuer: ISSUER,
      userId: ALICE,
      level: "write",
      workspaceIds: [PHYSICS],
      grantableWorkspaceIds: new Set([PHYSICS, HISTORY]),
      now: Date.now(),
    });
    if (!approved.ok) throw new Error(approved.reason);
    const code = new URL(approved.location).searchParams.get("code")!;

    // 3. The client exchanges the code and connects.
    await first.finishAuth(code);
    expect(provider.saved?.access_token).toMatch(/^hbat_/);
    const client = new Client({ name: "claude-like", version: "1" });
    await client.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { authProvider: provider, fetch }));
    const tools = (await client.listTools()).tools.map((t) => t.name);
    expect(tools).toContain("save_workspace_note");
    const listed = await client.callTool({ name: "list_workspaces", arguments: {} });
    expect(JSON.parse((listed.content as { text: string }[])[0].text).workspaces.map((w: { workspaceId: string }) => w.workspaceId)).toEqual([PHYSICS]);

    // 4. Refresh: the old access token stops mattering; the new pair works.
    const refreshed = await exchangeToken(world.store, form({ grant_type: "refresh_token", refresh_token: provider.saved!.refresh_token!, client_id: provider.info!.client_id }), undefined, ISSUER, Date.now());
    expect(refreshed.status).toBe(200);
    provider.saved = refreshed.body as unknown as OAuthTokens;
    const again = new Client({ name: "claude-like", version: "1" });
    await again.connect(new StreamableHTTPClientTransport(new URL(ENDPOINT), { authProvider: provider, fetch }));
    expect((await again.callTool({ name: "get_connection_info", arguments: {} })).isError).not.toBe(true);

    // 5. Bob's token never sees Alice, and Alice's is refused on another resource.
    const [connection] = await world.store.listConnections(ALICE);
    expect(connection.client).toBe("claude");
    const elsewhere = await handleMcpHttpRequest(
      new Request("https://preview.hubble.test/api/mcp", {
        method: "POST",
        headers: { authorization: `Bearer ${provider.saved.access_token}`, "content-type": "application/json", host: "preview.hubble.test" },
        body: "{}",
      }),
      world.deps
    );
    expect(elsewhere.status).toBe(401);
    expect(await world.store.listConnections(BOB)).toEqual([]);
  });
});
