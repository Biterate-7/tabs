import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createClaudeCredentialAdapter } from "@/lib/agents/credentials/providers/claude";
import { createCredentialService } from "@/lib/agents/credentials/service";
import { createMemoryConnectionStore } from "@/lib/agents/credentials/store";
import {
  createAesCipher,
  createCredentialStore,
  createMemorySecretRows,
  generateCredentialKey,
} from "@/lib/agents/credentials/secret-store";
import {
  registerCredentialAdapter,
  resetCredentialAdapters,
} from "@/lib/agents/credentials/registry";
import type { CredentialService } from "@/lib/agents/credentials/service";
import type { CredentialStore } from "@/lib/agents/credentials/secret-store";
import type { ConnectionStore } from "@/lib/agents/credentials/store";

/**
 * The provider-connections endpoint.
 *
 * ## Why the infrastructure is mocked and the service is not
 *
 * `getCredentialInfrastructure` reaches for `process.env` and Postgres, which a
 * test has no business doing. Everything *below* it — the service, the stores,
 * the cipher, the Claude credential adapter — is real, so what is exercised
 * here is the genuine path a request takes, with only the resolution of
 * "which database" replaced.
 *
 * The session is mocked for the same reason: who is signed in is the one thing
 * this route reads from outside itself, and it is precisely the thing the
 * isolation assertions need to vary.
 */

const ORIGIN = "https://tabdump.test";

const ALICE = { id: "alice-uuid", email: "alice@example.com", name: "Alice", avatarUrl: null };
const BOB = { id: "bob-uuid", email: "bob@example.com", name: "Bob", avatarUrl: null };

const ALICE_KEY = "sk-ant-api03-ALICE-DO-NOT-LEAK-aaaaa";
const BOB_KEY = "sk-ant-api03-BOB-DO-NOT-LEAK-bbbbbbb";

let connections: ConnectionStore;
let secrets: CredentialStore;
let service: CredentialService;
let signedIn: typeof ALICE | null = ALICE;

vi.mock("@/lib/auth/session", () => ({
  getSession: async () =>
    signedIn ? { ok: true, auth: { user: signedIn } } : { ok: false, reason: "no-session" },
}));

vi.mock("@/lib/agents/credentials/server", () => ({
  getCredentialInfrastructure: async () =>
    infrastructureAvailable ? { service, connections, secrets, durable: true } : undefined,
}));

let infrastructureAvailable = true;

const { GET, POST, DELETE } = await import("./route");

/** A request that passes the origin and content-type checks. */
function post(body: unknown): Request {
  return new Request(`${ORIGIN}/api/agents/provider-connections`, {
    method: "POST",
    headers: { origin: ORIGIN, host: "tabdump.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function del(body: unknown): Request {
  return new Request(`${ORIGIN}/api/agents/provider-connections`, {
    method: "DELETE",
    headers: { origin: ORIGIN, host: "tabdump.test", "content-type": "application/json" },
    body: JSON.stringify(body),
  });
}

function get(): Request {
  return new Request(`${ORIGIN}/api/agents/provider-connections`, {
    headers: { origin: ORIGIN, host: "tabdump.test" },
  });
}

beforeEach(() => {
  infrastructureAvailable = true;
  signedIn = ALICE;

  resetCredentialAdapters();
  registerCredentialAdapter(
    createClaudeCredentialAdapter({
      // Key-shaped keys are accepted unless they say otherwise, so a test can
      // have one credential accepted and another rejected in the same run.
      fetchImpl: (async (_url, init?: RequestInit) => {
        const key = new Headers(init?.headers).get("x-api-key") ?? "";
        const accepted = key.startsWith("sk-ant-") && !key.includes("REJECT");
        return new Response("{}", { status: accepted ? 200 : 401 });
      }) as typeof fetch,
    })
  );

  connections = createMemoryConnectionStore();
  secrets = createCredentialStore(
    createMemorySecretRows(),
    createAesCipher(Buffer.from(generateCredentialKey(), "base64"))
  );
  service = createCredentialService({ connections, secrets });
});

afterEach(() => {
  vi.restoreAllMocks();
});

async function connectAs(user: typeof ALICE, secret: string) {
  signedIn = user;
  const response = await POST(post({ action: "connect", provider: "claude-code", secret }));
  const body = (await response.json()) as { ok: boolean; value?: { connection: { id: string } } };
  if (!body.ok || !body.value) throw new Error("fixture failed to connect");
  return body.value.connection;
}

describe("origin and content type", () => {
  it("refuses a cross-site POST", async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/agents/provider-connections`, {
        method: "POST",
        headers: { origin: "https://evil.test", host: "tabdump.test", "content-type": "application/json" },
        body: JSON.stringify({ action: "connect", provider: "claude-code", secret: ALICE_KEY }),
      })
    );

    // The real browser-borne threat: a page the user visits could otherwise
    // rotate or delete their credential.
    expect(response.status).toBe(403);
  });

  it("refuses a POST without a JSON content type", async () => {
    const response = await POST(
      new Request(`${ORIGIN}/api/agents/provider-connections`, {
        method: "POST",
        headers: { origin: ORIGIN, host: "tabdump.test", "content-type": "text/plain" },
        body: "{}",
      })
    );

    // A cross-site form cannot set this header without a preflight that
    // nothing here answers.
    expect(response.status).toBe(403);
  });

  it("refuses a cross-site DELETE", async () => {
    const response = await DELETE(
      new Request(`${ORIGIN}/api/agents/provider-connections`, {
        method: "DELETE",
        headers: { origin: "https://evil.test", host: "tabdump.test", "content-type": "application/json" },
        body: JSON.stringify({ connectionId: "pc-1" }),
      })
    );

    expect(response.status).toBe(403);
  });
});

describe("connecting", () => {
  it("returns a connection view and never the credential", async () => {
    const response = await POST(
      post({ action: "connect", provider: "claude-code", secret: ALICE_KEY, displayName: "Work" })
    );

    expect(response.status).toBe(200);
    const text = await response.text();

    // The whole surface, as text, because that is what crosses the wire.
    expect(text).not.toContain(ALICE_KEY);
    expect(text).not.toContain("DO-NOT-LEAK");
    // Nor the owner id, which a client has no use for.
    expect(text).not.toContain(ALICE.id);

    const body = JSON.parse(text) as { ok: boolean; value: { connection: Record<string, unknown> } };
    expect(body.ok).toBe(true);
    expect(body.value.connection.status).toBe("connected");
    expect(body.value.connection.displayName).toBe("Work");
  });

  it("reports a rejected credential as a normalized code, not a provider message", async () => {
    const response = await POST(
      post({ action: "connect", provider: "claude-code", secret: "sk-ant-api03-REJECT-aaaaaaaaaaaaaa" })
    );

    // 200: the request was well-formed and was processed; the provider
    // declined. Conflating that with a malformed request would make the client
    // parse the body anyway to tell them apart.
    expect(response.status).toBe(200);
    const body = (await response.json()) as { ok: boolean; validation: { code: string } };
    expect(body.ok).toBe(false);
    expect(body.validation.code).toBe("invalid_credentials");
  });

  it("refuses a provider with no credential adapter", async () => {
    const response = await POST(post({ action: "connect", provider: "gemini", secret: ALICE_KEY }));
    expect(response.status).toBe(400);

    const body = (await response.json()) as { error: { code: string } };
    expect(body.error.code).toBe("unsupported-provider");
  });

  it("refuses an unknown provider and a missing secret", async () => {
    expect((await POST(post({ action: "connect", provider: "nope", secret: ALICE_KEY }))).status).toBe(400);
    expect((await POST(post({ action: "connect", provider: "claude-code", secret: "  " }))).status).toBe(400);
    expect((await POST(post({ action: "nonsense" }))).status).toBe(400);
  });

  it("refuses an auth method the adapter does not implement", async () => {
    // Offering somebody an OAuth button and then storing an API key would be
    // the worst version of this.
    const response = await POST(
      post({
        action: "connect",
        provider: "claude-code",
        authMethod: "official_oauth",
        secret: ALICE_KEY,
      })
    );

    expect(response.status).toBe(400);
  });
});

describe("listing", () => {
  it("returns only the signed-in user's connections", async () => {
    await connectAs(ALICE, ALICE_KEY);
    await connectAs(BOB, BOB_KEY);

    signedIn = ALICE;
    const body = (await (await GET(get())).json()) as {
      value: { connections: { id: string }[] };
    };

    expect(body.value.connections).toHaveLength(1);

    // And Bob's key is nowhere in Alice's response.
    signedIn = ALICE;
    const text = await (await GET(get())).text();
    expect(text).not.toContain(BOB_KEY);
    expect(text).not.toContain(ALICE_KEY);
  });

  it("reports which providers can be connected, from the registry", async () => {
    const body = (await (await GET(get())).json()) as {
      value: { connectable: { provider: string; input: { explanation: string } }[] };
    };

    expect(body.value.connectable.map((entry) => entry.provider)).toEqual(["claude-code"]);
    // The sentence the settings page renders comes from the adapter, so the
    // product cannot describe an authorization differently from the code that
    // performs it.
    expect(body.value.connectable[0]?.input.explanation).toContain(
      "TabDump does not provide a shared Claude account"
    );
  });

  it("says so when the deployment cannot hold credentials at all", async () => {
    infrastructureAvailable = false;
    const response = await GET(get());

    expect(response.status).toBe(503);
    const text = await response.text();
    // Never the name of the environment variable that would fix it: that
    // sentence would then be renderable by anybody who opened settings.
    expect(text).not.toContain("TABDUMP_CREDENTIAL_KEY");
  });
});

describe("cross-account access", () => {
  it("does not let one user rotate another's connection", async () => {
    const alice = await connectAs(ALICE, ALICE_KEY);

    signedIn = BOB;
    const response = await POST(post({ action: "rotate", connectionId: alice.id, secret: BOB_KEY }));
    const body = (await response.json()) as { ok: boolean };
    expect(body.ok).toBe(false);

    // Alice's credential is untouched.
    expect(await secrets.reveal(alice.id, `account:${ALICE.id}`)).toBe(ALICE_KEY);
  });

  it("does not let one user disconnect another's connection", async () => {
    const alice = await connectAs(ALICE, ALICE_KEY);

    signedIn = BOB;
    const response = await DELETE(del({ connectionId: alice.id }));

    // The same 404 a connection that does not exist would produce. Nothing
    // here reveals which.
    expect(response.status).toBe(404);
    expect(await secrets.reveal(alice.id, `account:${ALICE.id}`)).toBe(ALICE_KEY);
  });

  it("does not let one user revalidate another's connection", async () => {
    const alice = await connectAs(ALICE, ALICE_KEY);

    signedIn = BOB;
    const body = (await (await POST(post({ action: "revalidate", connectionId: alice.id }))).json()) as {
      ok: boolean;
    };
    expect(body.ok).toBe(false);
  });

  it("ignores an owner id supplied in the body", async () => {
    await connectAs(ALICE, ALICE_KEY);

    // There is no `ownerId` field on any request shape, so this is asserting
    // that adding one to the payload changes nothing.
    signedIn = BOB;
    const response = await POST(
      post({ action: "connect", provider: "claude-code", secret: BOB_KEY, ownerId: `account:${ALICE.id}` })
    );
    expect(response.status).toBe(200);

    // Bob's connection landed on Bob, and Alice still has exactly one of her
    // own with her own key.
    expect(await connections.list(`account:${BOB.id}`)).toHaveLength(1);
    const aliceRows = await connections.list(`account:${ALICE.id}`);
    expect(aliceRows).toHaveLength(1);
    expect(await secrets.reveal(aliceRows[0]!.id, `account:${ALICE.id}`)).toBe(ALICE_KEY);
  });
});

describe("disconnecting", () => {
  it("removes the connection and its secret", async () => {
    const alice = await connectAs(ALICE, ALICE_KEY);

    signedIn = ALICE;
    const response = await DELETE(del({ connectionId: alice.id }));
    expect(response.status).toBe(200);

    expect(await connections.list(`account:${ALICE.id}`)).toEqual([]);
    expect(await secrets.reveal(alice.id, `account:${ALICE.id}`)).toBeUndefined();
  });

  it("answers 404 for a connection that does not exist", async () => {
    signedIn = ALICE;
    expect((await DELETE(del({ connectionId: "pc-nothing" }))).status).toBe(404);
  });
});
