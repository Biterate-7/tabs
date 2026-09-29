import { describe, expect, it } from "vitest";
import { createClaudeCodeControlAdapter } from "@/lib/agents/control/providers/claude-code/adapter";
import { createNativeLoginState, withNativeAuthentication } from "@/lib/agents/launch/native-auth";
import { allowDesktopExecution } from "./gate";
import { createRuntimeHost, LOCAL_ACTOR } from "./host";
import type { ClaudeRuntime, ClaudeRuntimeAvailability } from "@/lib/agents/control/providers/claude-code/runtime";

/**
 * The production "stuck on Connecting…" bug, host side (Agent Authentication
 * & Runtime).
 *
 * A hosted runtime builds its host — and a brand-new Claude adapter — per
 * request, and fires `connect()` without waiting. `connect()` sets the status
 * to `connecting` and only then asks whether a credential exists, so every
 * `get_status` read the status in between and said `connecting`. For a user
 * who was signed out, or had nothing configured, that was the only answer
 * they ever got.
 */

function runtime(answer: () => Promise<ClaudeRuntimeAvailability>): ClaudeRuntime {
  return {
    isAvailable: async () => (await answer()).kind === "available",
    describeAvailability: answer,
    start: async () => ({ ok: false, error: { code: "process-failed" } }),
  };
}

/** One request against a host built the way the remote runtime builds it. */
async function statusOnce(answer: () => Promise<ClaudeRuntimeAvailability>, settleMs?: number) {
  const adapter = createClaudeCodeControlAdapter({ runtime: runtime(answer), connectTimeoutMs: 1_000 });
  void adapter.connect();
  const host = createRuntimeHost({
    gate: allowDesktopExecution(),
    resolveAdapter: (provider) => (provider === "claude-code" ? adapter : undefined),
    providers: ["claude-code"],
    runtimeId: "r1",
    ...(settleMs !== undefined ? { statusSettleMs: settleMs } : {}),
  });
  const reply = await host.execute(LOCAL_ACTOR, { name: "get_status" });
  if (!reply.ok) throw new Error("status refused");
  return { adapter, provider: reply.value.providers[0]! };
}

describe("get_status never answers with a phantom `connecting`", () => {
  it("reports a signed-out user as needing setup, not connecting, on a host built per request", async () => {
    const { provider } = await statusOnce(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20)); // a credential lookup
      return { kind: "credential-required", reason: "not_connected" };
    });
    expect(provider.connection).toBe("configuration_required");
    expect(provider.authentication).toBe("required");
  });

  it("reports a ready runtime as connected", async () => {
    const { provider } = await statusOnce(async () => ({ kind: "available" }));
    expect(provider.connection).toBe("connected");
  });

  it("waits only so long: a lookup that hangs is reported as it stands, and never holds the reply", async () => {
    const started = Date.now();
    const { provider } = await statusOnce(() => new Promise(() => {}), 50);
    expect(Date.now() - started).toBeLessThan(900);
    // Still honest — the Command Centre's watchdog turns this into a timeout.
    expect(provider.connection).toBe("connecting");
  });
});

describe("the Claude adapter's connect is bounded", () => {
  it("settles into an error with a timeout rather than staying connecting", async () => {
    const adapter = createClaudeCodeControlAdapter({
      runtime: runtime(() => new Promise(() => {})),
      connectTimeoutMs: 30,
    });
    const result = await adapter.connect();
    expect(result).toMatchObject({ ok: false, error: { code: "timeout" } });
    expect(adapter.getConnectionStatus()).toMatchObject({ kind: "error", lastError: { code: "timeout" } });
  });

  it("shares one connect between concurrent callers", async () => {
    let asked = 0;
    const adapter = createClaudeCodeControlAdapter({
      runtime: runtime(async () => {
        asked += 1;
        return { kind: "available" };
      }),
    });
    await Promise.all([adapter.connect(), adapter.connect(), adapter.connect()]);
    expect(asked).toBe(1);
    await adapter.connectSettled();
    expect(adapter.getConnectionStatus().kind).toBe("connected");
  });

  it("treats a runtime that throws as unavailable, not as connecting", async () => {
    const adapter = createClaudeCodeControlAdapter({ runtime: runtime(() => Promise.reject(new Error("boom"))) });
    await adapter.connect();
    expect(adapter.getConnectionStatus().kind).toBe("unavailable");
  });
});

describe("the auth kind reaches the status — as a closed value, never the account", () => {
  it("reports a Claude subscription sign-in as not permitted, with nothing the CLI printed", async () => {
    const login = createNativeLoginState({
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({
          loggedIn: true,
          authMethod: "claude.ai",
          apiProvider: "firstParty",
          email: "alice@example.com",
          orgName: "Alice Co",
          subscriptionType: "max",
        }),
      }),
    });
    // The desktop shape: Claude's adapter, whose credential source is the
    // native login — which refuses this sign-in — wrapped with the extension.
    const adapter = withNativeAuthentication(
      createClaudeCodeControlAdapter({
        runtime: runtime(async () => ({ kind: "credential-required", reason: "not_permitted" })),
      }),
      "claude-code",
      login
    );
    const host = createRuntimeHost({
      gate: allowDesktopExecution(),
      resolveAdapter: () => adapter,
      providers: ["claude-code"],
      runtimeId: "r1",
    });
    const connected = await host.execute(LOCAL_ACTOR, { name: "connect_provider", provider: "claude-code" });
    expect(connected).toMatchObject({
      ok: true,
      value: { authentication: "authenticated", authKind: "subscription", authIssue: "method_not_permitted" },
    });
    const status = await host.execute(LOCAL_ACTOR, { name: "get_status" });
    const text = JSON.stringify([connected, status]);
    for (const leaked of ["alice", "Alice Co", "claude.ai", '"max"']) expect(text).not.toContain(leaked);
  });
});
