import { afterEach, describe, expect, it, vi } from "vitest";
import { COMMAND_TIMEOUT_MS, createRuntimeClient } from "./client";
import { RUNTIME_COMMAND_NAMES } from "./protocol";

/**
 * Every runtime command is bounded (Agent Authentication & Runtime).
 *
 * The production "stuck on Connecting…" had two halves: a host that reported
 * a status mid-connect, and a client that would wait for any reply forever.
 * These tests pin the client half: a command that gets no answer settles into
 * `timeout`, a late answer changes nothing, and the transport is told to give
 * up.
 */

afterEach(() => {
  vi.useRealTimers();
});

function hangingFetch() {
  const signals: AbortSignal[] = [];
  const fetch = vi.fn((_url: unknown, init?: RequestInit) => {
    if (init?.signal) signals.push(init.signal);
    return new Promise<Response>(() => {});
  });
  return { fetch, signals };
}

describe("command deadlines", () => {
  it("bounds every command in the protocol, and waits longest for a person signing in", () => {
    for (const name of RUNTIME_COMMAND_NAMES) expect(COMMAND_TIMEOUT_MS[name]).toBeGreaterThan(0);
    const longest = Math.max(...Object.values(COMMAND_TIMEOUT_MS));
    expect(COMMAND_TIMEOUT_MS.authenticate_provider).toBe(longest);
    // Above the agents' own 10-minute sign-in wait, so a finishing sign-in is not cut off.
    expect(COMMAND_TIMEOUT_MS.authenticate_provider).toBeGreaterThan(10 * 60 * 1000);
  });

  it("answers `timeout` when the runtime never replies — never a promise that hangs", async () => {
    vi.useFakeTimers();
    const { fetch, signals } = hangingFetch();
    const client = createRuntimeClient({ fetch: fetch as unknown as typeof globalThis.fetch, timeouts: { connect_provider: 1_000 } });

    const reply = client.send({ name: "connect_provider", provider: "claude-code" });
    await vi.advanceTimersByTimeAsync(1_000);
    await expect(reply).resolves.toEqual({
      ok: false,
      error: { code: "timeout", message: "The agent did not respond in time." },
    });
    // The request itself is abandoned, not left open.
    expect(signals[0]?.aborted).toBe(true);
  });

  it("times out a handshake the same way, so the status can never wait forever either", async () => {
    vi.useFakeTimers();
    const { fetch } = hangingFetch();
    const client = createRuntimeClient({ fetch: fetch as unknown as typeof globalThis.fetch, timeouts: { get_status: 500 } });
    const reply = client.status();
    await vi.advanceTimersByTimeAsync(500);
    await expect(reply).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(client.runtimeId()).toBeUndefined();
  });

  it("bounds a non-HTTP transport too (the desktop relay)", async () => {
    vi.useFakeTimers();
    const client = createRuntimeClient({
      post: () => new Promise(() => {}),
      timeouts: { authenticate_provider: 2_000 },
    });
    const reply = client.send({ name: "authenticate_provider", provider: "gemini", methodId: "oauth-personal" });
    await vi.advanceTimersByTimeAsync(2_000);
    await expect(reply).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
  });

  it("returns a reply that arrives in time, and leaves no timer behind", async () => {
    vi.useFakeTimers();
    const client = createRuntimeClient({
      post: async () => ({ ok: true, value: { environment: "local", executable: true, runtimeId: "r1", providers: [] } }),
    });
    await expect(client.status()).resolves.toMatchObject({ ok: true });
    expect(client.runtimeId()).toBe("r1");
    expect(vi.getTimerCount()).toBe(0);
  });

  it("drops a reply that arrives after its deadline", async () => {
    vi.useFakeTimers();
    let answer: (value: unknown) => void = () => {};
    const client = createRuntimeClient({
      post: () =>
        new Promise((resolve) => {
          answer = resolve;
        }),
      timeouts: { get_status: 100 },
    });
    const reply = client.status();
    await vi.advanceTimersByTimeAsync(100);
    answer({ ok: true, value: { environment: "local", executable: true, runtimeId: "late", providers: [] } });
    await expect(reply).resolves.toMatchObject({ ok: false, error: { code: "timeout" } });
    // The late handshake did not quietly become the runtime this client addresses.
    expect(client.runtimeId()).toBeUndefined();
  });
});
