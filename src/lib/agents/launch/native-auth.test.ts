import { describe, expect, it } from "vitest";
import { createNativeLoginSource, createNativeLoginState, withNativeAuthentication } from "./native-auth";
import { createUnimplementedControlAdapter } from "@/lib/agents/control/unimplemented";
import type { NativeOperation, NativeRunResult } from "./process";

function runner(replies: Partial<Record<"status" | "login", NativeRunResult>>) {
  const calls: NativeOperation[] = [];
  const run = async (operation: NativeOperation): Promise<NativeRunResult> => {
    calls.push(operation);
    return replies[operation.kind] ?? { ok: false, reason: "failed" };
  };
  return { run, calls };
}

const status = (loggedIn: boolean): NativeRunResult => ({
  ok: true,
  exitCode: 0,
  stdout: JSON.stringify({ loggedIn, authMethod: "claude.ai", email: "alice@example.com", orgName: "Alice Co" }),
});

describe("native sign-in state", () => {
  it("reads only whether the agent is signed in", async () => {
    const { run } = runner({ status: status(true) });
    const state = createNativeLoginState({ run });
    expect(await state.status()).toBe("authenticated");

    const source = createNativeLoginSource(state);
    const credential = await source();
    // An empty environment: the agent finds its own token in its own store.
    expect(credential).toEqual({ ok: true, connectionId: "native-login", env: {} });
    expect(JSON.stringify(credential)).not.toContain("alice");
  });

  it("refuses to resolve a credential while signed out, and says unknown for garbage", async () => {
    expect(await createNativeLoginSource(createNativeLoginState(runner({ status: status(false) })))()).toEqual({
      ok: false,
      reason: "not_connected",
    });
    const garbage = createNativeLoginState(runner({ status: { ok: true, exitCode: 1, stdout: "not json" } }));
    expect(await garbage.status()).toBe("unknown");
  });

  it("caches briefly, and asks again after a sign-in", async () => {
    let clock = 0;
    const { run, calls } = runner({ status: status(false), login: { ok: true, exitCode: 0, stdout: "" } });
    const state = createNativeLoginState({ run, now: () => clock });
    await state.status();
    await state.status();
    expect(calls.filter((call) => call.kind === "status")).toHaveLength(1);
    clock += 16_000;
    await state.status();
    expect(calls.filter((call) => call.kind === "status")).toHaveLength(2);
    await state.login("claudeai");
    expect(calls.filter((call) => call.kind === "status")).toHaveLength(3);
  });
});

describe("the native sign-in extension", () => {
  it("offers exactly the allowlisted methods and runs only those", async () => {
    const { run, calls } = runner({ status: status(false), login: { ok: true, exitCode: 0, stdout: "" } });
    const adapter = withNativeAuthentication(
      createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" }),
      "claude-code",
      createNativeLoginState({ run })
    );

    expect(adapter.describeAuthentication().methods.map((method) => method.id)).toEqual(["claudeai", "console"]);
    expect(await adapter.authenticate("auth login --evil")).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(calls.some((call) => call.kind === "login")).toBe(false);

    await adapter.authenticate("console");
    expect(calls).toContainEqual({ kind: "login", methodId: "console" });
  });

  it("keeps the adapter's own members reachable", () => {
    const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" });
    const wrapped = withNativeAuthentication(base, "claude-code", createNativeLoginState(runner({})));
    expect(wrapped.provider).toBe("claude-code");
    expect(typeof wrapped.createSession).toBe("function");
    expect(wrapped.getCapabilities()).toBe(base.getCapabilities());
  });
});
