// @vitest-environment node
import { beforeEach, describe, expect, it, vi } from "vitest";
import { authenticateMcpToken, createMemoryMcpTokenStore } from "@/lib/mcp/tokens";

/**
 * /api/mcp/tokens — who may mint a Claude Desktop token, and what crosses the wire.
 *
 * The session and the store are mocked; the token logic beneath is real.
 */

const ORIGIN = "https://tabdump.test";
const ALICE = { id: "11111111-1111-4111-8111-111111111111" };
const BOB = { id: "22222222-2222-4222-8222-222222222222" };

let signedIn: { id: string } | null = ALICE;
let store = createMemoryMcpTokenStore();

vi.mock("@/lib/auth/session", () => ({
  getSession: async () =>
    signedIn ? { ok: true, auth: { user: signedIn } } : { ok: false, reason: "no-session" },
}));

vi.mock("@/lib/mcp/tokens-postgres", () => ({
  getMcpTokenStore: async () => store,
}));

const { GET, POST, DELETE } = await import("./route");

function request(method: string, body?: unknown, origin = ORIGIN): Request {
  return new Request(`${ORIGIN}/api/mcp/tokens`, {
    method,
    headers: { origin, host: "tabdump.test", "content-type": "application/json" },
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
}

beforeEach(() => {
  signedIn = ALICE;
  store = createMemoryMcpTokenStore();
});

describe("/api/mcp/tokens", () => {
  it("refuses an anonymous visitor on every method, minting nothing", async () => {
    signedIn = null;
    expect((await GET(request("GET"))).status).toBe(401);
    expect((await POST(request("POST", { name: "x" }))).status).toBe(401);
    expect((await DELETE(request("DELETE", { tokenId: "mcpt_x" }))).status).toBe(401);
    expect(store.records).toEqual([]);
  });

  it("refuses a cross-site request", async () => {
    expect((await POST(request("POST", { name: "x" }, "https://evil.example"))).status).toBe(403);
    expect(store.records).toEqual([]);
  });

  it("returns the token exactly once, and it authenticates as the caller", async () => {
    const created = await POST(request("POST", { name: "Work laptop" }));
    expect(created.headers.get("cache-control")).toBe("no-store");
    const body = await created.json();
    const token: string = body.value.token;
    expect(token).toMatch(/^tdmcp_/);

    expect(await authenticateMcpToken(store, token, Date.now())).toMatchObject({ ok: true, userId: ALICE.id });

    const listed = JSON.stringify(await (await GET(request("GET"))).json());
    expect(listed).toContain("Work laptop");
    expect(listed).not.toContain(token);
    expect(listed).not.toContain(store.records[0].tokenHash);
  });

  it("lists only the caller's tokens", async () => {
    await POST(request("POST", { name: "Alice's" }));
    signedIn = BOB;
    await POST(request("POST", { name: "Bob's" }));

    const bobList = (await (await GET(request("GET"))).json()).value.tokens;
    expect(bobList.map((t: { name: string }) => t.name)).toEqual(["Bob's"]);
  });

  it("lets only the owner revoke, and answers another's id as not found", async () => {
    await POST(request("POST", { name: "Alice's" }));
    const [record] = store.records;

    signedIn = BOB;
    expect((await DELETE(request("DELETE", { tokenId: record.id }))).status).toBe(404);
    expect(store.records[0].revokedAt).toBeUndefined();

    signedIn = ALICE;
    expect((await DELETE(request("DELETE", { tokenId: record.id }))).status).toBe(200);
    expect(store.records[0].revokedAt).toBeDefined();
  });

  it("rejects an invalid name", async () => {
    const response = await POST(request("POST", { name: "" }));
    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe("invalid-name");
  });
});
