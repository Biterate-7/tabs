// @vitest-environment node
import { beforeEach, describe, expect, it } from "vitest";
import { handleMcpHttpRequest, MAX_MCP_REQUEST_BYTES } from "./http";
import {
  MAX_ACTIVE_MCP_TOKENS,
  MCP_TOKEN_TTL_MS,
  authenticateMcpToken,
  createMemoryMcpTokenStore,
  hashMcpToken,
  issueMcpToken,
  mintMcpToken,
  toMcpTokenView,
} from "./tokens";
import { ALICE, BOB, createFixtureData } from "./__fixtures__/accounts";
import type { McpHttpDeps } from "./http";

const ENDPOINT = "https://tabdump.test/api/mcp";
const NOW = 1_800_000_000_000;

const INITIALIZE = {
  jsonrpc: "2.0",
  id: 1,
  method: "initialize",
  params: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "auth-test", version: "1.0.0" },
  },
};

let deps: McpHttpDeps;
let tokens: ReturnType<typeof createMemoryMcpTokenStore>;
let clock: number;

beforeEach(async () => {
  tokens = createMemoryMcpTokenStore();
  clock = NOW;
  deps = { tokens, data: await createFixtureData(), now: () => clock };
});

function post(headers: Record<string, string>, body: unknown = INITIALIZE, method = "POST"): Request {
  return new Request(ENDPOINT, {
    method,
    headers: {
      host: "tabdump.test",
      "content-type": "application/json",
      accept: "application/json, text/event-stream",
      ...headers,
    },
    ...(method === "POST" ? { body: typeof body === "string" ? body : JSON.stringify(body) } : {}),
  });
}

async function issue(userId = ALICE): Promise<string> {
  const issued = await issueMcpToken(tokens, { userId, name: "laptop", now: clock });
  if (!issued.ok) throw new Error("fixture token");
  return issued.token;
}

describe("the endpoint authenticates with a bearer token and nothing else", () => {
  it("accepts a valid token", async () => {
    const response = await handleMcpHttpRequest(post({ authorization: `Bearer ${await issue()}` }), deps);
    expect(response.status).toBe(200);
    expect((await response.json()).result.serverInfo.name).toBe("tabdump");
  });

  it("refuses a request with no token, and says how to authenticate", async () => {
    const response = await handleMcpHttpRequest(post({}), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain("Bearer");
  });

  it("ignores a Hubble session cookie entirely", async () => {
    // A browser holding a session gains nothing here.
    const response = await handleMcpHttpRequest(post({ cookie: "tabdump_session=anything-at-all" }), deps);
    expect(response.status).toBe(401);
  });

  it.each([
    ["a malformed token", "Bearer not-a-token"],
    ["an unknown well-formed token", `Bearer ${mintMcpToken().token}`],
    ["an Anthropic-shaped key", "Bearer sk-ant-api03-not-a-tabdump-token"],
  ])("refuses %s", async (_label, authorization) => {
    const response = await handleMcpHttpRequest(post({ authorization }), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toContain('error="invalid_token"');
  });

  it("refuses a Basic credential as carrying no bearer token at all", async () => {
    const response = await handleMcpHttpRequest(post({ authorization: "Basic YWxpY2U6aHVudGVyMg==" }), deps);
    expect(response.status).toBe(401);
    expect(response.headers.get("www-authenticate")).toBe('Bearer realm="Hubble MCP"');
  });

  it("refuses a revoked token", async () => {
    const token = await issue();
    const [record] = await tokens.listForUser(ALICE);
    await tokens.revoke(ALICE, record.id, clock);
    expect((await handleMcpHttpRequest(post({ authorization: `Bearer ${token}` }), deps)).status).toBe(401);
  });

  it("refuses an expired token", async () => {
    const token = await issue();
    clock = NOW + MCP_TOKEN_TTL_MS;
    expect((await handleMcpHttpRequest(post({ authorization: `Bearer ${token}` }), deps)).status).toBe(401);
  });

  it("gives every failure the same body", async () => {
    const bodies = await Promise.all(
      ([{}, { authorization: "Bearer junk" }, { authorization: `Bearer ${mintMcpToken().token}` }] as Record<string, string>[]).map(
        async (headers) => (await handleMcpHttpRequest(post(headers), deps)).text()
      )
    );
    expect(new Set(bodies).size).toBe(1);
  });
});

describe("request hygiene", () => {
  it("refuses a foreign browser origin even with a valid token", async () => {
    const response = await handleMcpHttpRequest(
      post({ authorization: `Bearer ${await issue()}`, origin: "https://evil.example" }),
      deps
    );
    expect(response.status).toBe(403);
  });

  it("allows a request with no Origin, which is what Claude Desktop sends", async () => {
    const response = await handleMcpHttpRequest(post({ authorization: `Bearer ${await issue()}` }), deps);
    expect(response.status).toBe(200);
  });

  it.each(["GET", "DELETE"])("answers %s with 405 — there is no stream or session to address", async (method) => {
    const response = await handleMcpHttpRequest(post({ authorization: `Bearer ${await issue()}` }, undefined, method), deps);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
  });

  it("refuses an oversized body", async () => {
    const huge = JSON.stringify({ ...INITIALIZE, padding: "x".repeat(MAX_MCP_REQUEST_BYTES) });
    const response = await handleMcpHttpRequest(post({ authorization: `Bearer ${await issue()}` }, huge), deps);
    expect(response.status).toBe(413);
  });

  it("refuses a body that is not JSON", async () => {
    const response = await handleMcpHttpRequest(post({ authorization: `Bearer ${await issue()}` }, "{nope"), deps);
    expect(response.status).toBe(400);
  });
});

describe("tokens", () => {
  it("are stored as a hash, never as themselves", async () => {
    const token = await issue();
    const [record] = tokens.records;
    expect(record.tokenHash).toBe(hashMcpToken(token));
    expect(record.tokenHash).toMatch(/^[0-9a-f]{64}$/);
    expect(JSON.stringify(tokens.records)).not.toContain(token);
  });

  it("have a view with neither the token nor its hash", async () => {
    const token = await issue();
    const view = JSON.stringify(toMcpTokenView(tokens.records[0]));
    expect(view).not.toContain(token);
    expect(view).not.toContain(tokens.records[0].tokenHash);
    expect(view).not.toContain("tokenHash");
  });

  it("are read-only by construction", async () => {
    await issue();
    expect(tokens.records[0].scopes).toEqual(["read"]);
  });

  it("resolve to exactly the account that minted them", async () => {
    const aliceToken = await issue(ALICE);
    const bobToken = await issue(BOB);
    expect(await authenticateMcpToken(tokens, aliceToken, clock)).toMatchObject({ ok: true, userId: ALICE });
    expect(await authenticateMcpToken(tokens, bobToken, clock)).toMatchObject({ ok: true, userId: BOB });
  });

  it("can only be revoked by their owner", async () => {
    const token = await issue(ALICE);
    const [record] = tokens.records;
    expect(await tokens.revoke(BOB, record.id, clock)).toBe(false);
    expect(await authenticateMcpToken(tokens, token, clock)).toMatchObject({ ok: true });
  });

  it("are capped per account", async () => {
    for (let i = 0; i < MAX_ACTIVE_MCP_TOKENS; i += 1) await issue();
    expect(await issueMcpToken(tokens, { userId: ALICE, name: "one too many", now: clock })).toEqual({
      ok: false,
      reason: "too-many-tokens",
    });
    // Another account's cap is its own.
    expect((await issueMcpToken(tokens, { userId: BOB, name: "bob", now: clock })).ok).toBe(true);
  });

  it.each([["an empty name", ""], ["a non-string", 42], ["an over-long name", "x".repeat(61)]])(
    "refuse %s",
    async (_label, name) => {
      expect(await issueMcpToken(tokens, { userId: ALICE, name, now: clock })).toEqual({
        ok: false,
        reason: "invalid-name",
      });
    }
  );

  it("are unique and unguessable in shape", () => {
    const minted = new Set(Array.from({ length: 200 }, () => mintMcpToken().token));
    expect(minted.size).toBe(200);
    for (const token of minted) expect(token).toMatch(/^tdmcp_[A-Za-z0-9_-]{43}$/);
  });
});
