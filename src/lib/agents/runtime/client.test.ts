import { describe, expect, it, vi } from "vitest";
import { createRuntimeClient, RUNTIME_ENDPOINT } from "./client";
import type { RuntimeRequest } from "./protocol";

/**
 * The browser's handle.
 *
 * What matters here is the handshake and the failure shape, because those are
 * the two things a long-lived UI depends on and the two things that break
 * invisibly: a client that silently addressed a restarted host would show
 * every session vanishing, and one that threw from a background poll would
 * take a render down with it.
 */

type Call = { url: string; body: RuntimeRequest };

function stub(responses: unknown[]): { fetch: typeof fetch; calls: Call[] } {
  const calls: Call[] = [];
  let index = 0;

  const fetchStub = vi.fn(async (url: RequestInfo | URL, init?: RequestInit) => {
    calls.push({ url: String(url), body: JSON.parse(String(init?.body)) as RuntimeRequest });
    const payload = responses[Math.min(index++, responses.length - 1)];
    return { json: async () => payload } as Response;
  });

  return { fetch: fetchStub as unknown as typeof fetch, calls };
}

const STATUS = {
  ok: true,
  value: { environment: "local", executable: true, runtimeId: "runtime-1", providers: [] },
};

describe("the handshake", () => {
  it("learns the runtime identity from a status call and carries it afterwards", async () => {
    const { fetch, calls } = stub([STATUS, { ok: true, value: { sessions: [], correlations: [] } }]);
    const client = createRuntimeClient({ fetch });

    await client.status();
    expect(client.runtimeId()).toBe("runtime-1");

    await client.send({ name: "list_sessions" });

    expect(calls[0].body.runtimeId).toBeUndefined();
    expect(calls[1].body.runtimeId).toBe("runtime-1");
  });

  it("sends the handshake without an identity even once it has one", async () => {
    // `get_status` is how an identity is discovered, so it must never require
    // one — otherwise a client that has gone stale can never recover.
    const { fetch, calls } = stub([STATUS]);
    const client = createRuntimeClient({ fetch });

    await client.status();
    await client.status();

    expect(calls.every((call) => call.body.runtimeId === undefined)).toBe(true);
  });

  it("forgets a stale identity so the next call re-handshakes", async () => {
    const { fetch, calls } = stub([
      STATUS,
      { ok: false, error: { code: "runtime_disconnected", message: "gone" } },
      STATUS,
    ]);
    const client = createRuntimeClient({ fetch });

    await client.status();
    const refused = await client.send({ name: "list_sessions" });

    expect(refused).toMatchObject({ ok: false, error: { code: "runtime_disconnected" } });
    expect(client.runtimeId()).toBeUndefined();

    await client.send({ name: "list_sessions" });
    expect(calls[2].body.runtimeId).toBeUndefined();
  });

  it("can be reset explicitly", async () => {
    const { fetch } = stub([STATUS]);
    const client = createRuntimeClient({ fetch });

    await client.status();
    client.reset();

    expect(client.runtimeId()).toBeUndefined();
  });
});

describe("failures", () => {
  it("turns a transport error into a result rather than throwing", async () => {
    // A background poll must not be able to take a render down.
    const failing = vi.fn(async () => {
      throw new Error("fetch failed: http://localhost:3000/api/agents/control");
    });
    const client = createRuntimeClient({ fetch: failing as unknown as typeof fetch });

    const result = await client.send({ name: "list_sessions" });

    expect(result).toMatchObject({ ok: false, error: { code: "runtime_disconnected" } });
  });

  it("does not put the thrown message in front of a user", async () => {
    // A network error's text can carry a host and a port.
    const failing = vi.fn(async () => {
      throw new Error("connect ECONNREFUSED 127.0.0.1:3000");
    });
    const client = createRuntimeClient({ fetch: failing as unknown as typeof fetch });

    const result = await client.send({ name: "list_sessions" });
    const message = result.ok ? "" : result.error.message;

    expect(message).not.toContain("127.0.0.1");
    expect(message).not.toContain("3000");
  });

  it("treats an unreadable reply as a disconnect", async () => {
    // What a static desktop build returns: the route is not in the tree, so
    // the response is an HTML page rather than a result.
    const { fetch } = stub(["<!doctype html>"]);
    const client = createRuntimeClient({ fetch });

    expect(await client.send({ name: "list_sessions" })).toMatchObject({
      ok: false,
      error: { code: "runtime_disconnected" },
    });
  });
});

describe("what the client sends", () => {
  it("posts one command to one endpoint, same-origin", async () => {
    const { fetch, calls } = stub([STATUS]);
    const client = createRuntimeClient({ fetch });

    await client.status();

    expect(calls[0].url).toBe(RUNTIME_ENDPOINT);
    expect(Object.keys(calls[0].body).sort()).toEqual(["command"]);
  });

  it("carries no actor, no token and no path", async () => {
    // Identity is the transport's business and ownership is the host's. A
    // client that could name its own actor would be a client that could claim
    // somebody else's sessions.
    const { fetch, calls } = stub([STATUS, { ok: true, value: {} }]);
    const client = createRuntimeClient({ fetch });

    await client.status();
    await client.send({ name: "create_session", provider: "claude-code", projectId: "p1" });

    const serialized = JSON.stringify(calls[1].body);
    for (const forbidden of ["actor", "token", "secret", "cwd", "path", "apiKey"]) {
      expect(serialized).not.toContain(forbidden);
    }
  });
});

describe("a non-HTTP transport (the desktop app, Phase J.1)", () => {
  it("carries the same requests, handshake and generation check without fetch", async () => {
    const sent: RuntimeRequest[] = [];
    const fetchSpy = vi.fn();
    const replies: unknown[] = [
      { ok: true, value: { ...STATUS, runtimeId: "sidecar-1" } },
      { ok: true, value: { sessions: [], correlations: [] } },
      { ok: false, error: { code: "runtime_disconnected", message: "gone" } },
      { ok: true, value: { ...STATUS, runtimeId: "sidecar-2" } },
    ];
    const client = createRuntimeClient({
      fetch: fetchSpy as unknown as typeof fetch,
      post: async (request) => {
        sent.push(request);
        return replies.shift();
      },
    });

    await client.status();
    await client.send({ name: "list_sessions" });
    await client.send({ name: "list_sessions" });
    await client.status();

    expect(fetchSpy).not.toHaveBeenCalled();
    expect(sent[0]).toEqual({ command: { name: "get_status" } });
    expect(sent[1]).toEqual({ runtimeId: "sidecar-1", command: { name: "list_sessions" } });
    // A restarted sidecar: the stale identity is dropped, and the client
    // re-handshakes exactly as it does against a restarted dev server.
    expect(client.runtimeId()).toBe("sidecar-2");
  });

  it("treats an unreadable reply as a lost runtime", async () => {
    const client = createRuntimeClient({ post: async () => "not a reply" });
    expect(await client.status()).toMatchObject({ ok: false, error: { code: "runtime_disconnected" } });
  });
});
