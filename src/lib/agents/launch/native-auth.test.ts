import { describe, expect, it } from "vitest";
import {
  createNativeLoginSource,
  createNativeLoginState,
  readClaudeAuthStatus,
  withNativeAuthentication,
} from "./native-auth";
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

/**
 * `claude auth status` replies, shaped as Claude Code 2.1.229 prints them.
 *
 * The subscription one is the verified shape (`authMethod: "claude.ai"`, plus
 * account fields Hubble must drop). The non-subscription one stands for *any*
 * first-party sign-in that is not the verified subscription marker — the
 * Console sign-in's exact `authMethod` string was not observable here, so the
 * tests pin the rule ("not the subscription marker, no plan") rather than a
 * guessed value.
 */
const reply = (body: Record<string, unknown>, exitCode = 0): NativeRunResult => ({
  ok: true,
  exitCode,
  stdout: JSON.stringify(body),
});
const SUBSCRIPTION = reply({
  loggedIn: true,
  authMethod: "claude.ai",
  apiProvider: "firstParty",
  email: "alice@example.com",
  orgId: "org-secret-id",
  orgName: "Alice Co",
  subscriptionType: "max",
});
const CONSOLE = reply({ loggedIn: true, authMethod: "not-a-subscription", apiProvider: "firstParty", email: "alice@example.com" });
const SIGNED_OUT = reply({ loggedIn: false }, 1);

describe("reading `claude auth status` (Agent Authentication & Runtime)", () => {
  it("recognises a Claude subscription login and does not permit it", () => {
    expect(readClaudeAuthStatus(SUBSCRIPTION.ok ? SUBSCRIPTION.stdout : "")).toEqual({
      state: "authenticated",
      kind: "subscription",
      permitted: false,
    });
  });

  it("treats a plan field as a subscription whatever the method is called — fails closed", () => {
    expect(
      readClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "something-else", subscriptionType: "pro" }))
    ).toMatchObject({ kind: "subscription", permitted: false });
  });

  it("permits a first-party sign-in that is not a subscription (a Console account)", () => {
    expect(readClaudeAuthStatus(CONSOLE.ok ? CONSOLE.stdout : "")).toEqual({
      state: "authenticated",
      kind: "account",
      permitted: true,
    });
  });

  it("recognises a cloud provider from `apiProvider`", () => {
    expect(
      readClaudeAuthStatus(JSON.stringify({ loggedIn: true, authMethod: "third_party", apiProvider: "bedrock" }))
    ).toEqual({ state: "authenticated", kind: "cloud_provider", permitted: true });
  });

  it("does not guess when a signed-in agent says nothing about how", () => {
    expect(readClaudeAuthStatus(JSON.stringify({ loggedIn: true }))).toEqual({
      state: "authenticated",
      permitted: false,
    });
  });

  it("reads signed out, and anything unreadable as unknown", () => {
    expect(readClaudeAuthStatus(JSON.stringify({ loggedIn: false }))).toEqual({ state: "required", permitted: false });
    expect(readClaudeAuthStatus("not json")).toEqual({ state: "unknown", permitted: false });
    expect(readClaudeAuthStatus("[]")).toEqual({ state: "unknown", permitted: false });
    expect(readClaudeAuthStatus(JSON.stringify({ loggedIn: "yes" }))).toEqual({ state: "unknown", permitted: false });
  });

  it("keeps no account detail — only closed values leave the reader", () => {
    const read = readClaudeAuthStatus(SUBSCRIPTION.ok ? SUBSCRIPTION.stdout : "");
    const text = JSON.stringify(read);
    for (const leaked of ["alice", "Alice Co", "org-secret-id", "max", "claude.ai"]) expect(text).not.toContain(leaked);
  });
});

describe("native sign-in state", () => {
  it("resolves an empty credential for a permitted sign-in — the agent finds its own token", async () => {
    const state = createNativeLoginState(runner({ status: CONSOLE }));
    expect(await state.status()).toBe("authenticated");

    const credential = await createNativeLoginSource(state)();
    expect(credential).toEqual({ ok: true, connectionId: "native-login", env: {} });
    expect(JSON.stringify(credential)).not.toContain("alice");
  });

  it("refuses a subscription sign-in as not permitted, and substitutes nothing", async () => {
    const state = createNativeLoginState(runner({ status: SUBSCRIPTION }));
    expect(await state.status()).toBe("authenticated");
    expect(await createNativeLoginSource(state)()).toEqual({ ok: false, reason: "not_permitted" });
  });

  it("refuses to resolve a credential while signed out, and says unknown for garbage", async () => {
    expect(await createNativeLoginSource(createNativeLoginState(runner({ status: SIGNED_OUT })))()).toEqual({
      ok: false,
      reason: "not_connected",
    });
    const garbage = createNativeLoginState(runner({ status: { ok: true, exitCode: 1, stdout: "not json" } }));
    expect(await garbage.status()).toBe("unknown");
    expect(await createNativeLoginSource(garbage)()).toEqual({ ok: false, reason: "unavailable" });
  });

  it("treats a status command that could not run as unknown, not signed in", async () => {
    const state = createNativeLoginState(runner({ status: { ok: false, reason: "timeout" } }));
    expect(await state.status()).toBe("unknown");
    expect(state.answer().permitted).toBe(false);
  });

  it("caches briefly, and asks again after a sign-in", async () => {
    let clock = 0;
    const { run, calls } = runner({ status: SIGNED_OUT, login: { ok: true, exitCode: 0, stdout: "" } });
    const state = createNativeLoginState({ run, now: () => clock });
    await state.status();
    await state.status();
    expect(calls.filter((call) => call.kind === "status")).toHaveLength(1);
    clock += 16_000;
    await state.status();
    expect(calls.filter((call) => call.kind === "status")).toHaveLength(2);
    await state.login("console");
    expect(calls.filter((call) => call.kind === "status")).toHaveLength(3);
  });
});

describe("the native sign-in extension", () => {
  it("offers only the Console sign-in, and runs only allowlisted methods", async () => {
    const { run, calls } = runner({ status: SIGNED_OUT, login: { ok: true, exitCode: 0, stdout: "" } });
    const adapter = withNativeAuthentication(
      createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" }),
      "claude-code",
      createNativeLoginState({ run })
    );

    expect(adapter.describeAuthentication().methods.map((method) => method.id)).toEqual(["console"]);
    expect(await adapter.authenticate("auth login --evil")).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    // A Claude subscription login is not a method Hubble can start, whatever
    // an older client sends (Anthropic does not permit it in Agent-SDK apps).
    expect(await adapter.authenticate("claudeai")).toMatchObject({ ok: false, error: { code: "invalid-request" } });
    expect(calls.some((call) => call.kind === "login")).toBe(false);

    await adapter.authenticate("console");
    expect(calls).toContainEqual({ kind: "login", methodId: "console" });
  });

  it("describes a subscription sign-in as signed in but not permitted — the kind, never the account", async () => {
    const adapter = withNativeAuthentication(
      createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" }),
      "claude-code",
      createNativeLoginState(runner({ status: SUBSCRIPTION }))
    );
    await adapter.connect();
    const described = adapter.describeAuthentication();
    expect(described).toMatchObject({ state: "authenticated", kind: "subscription", issue: "method_not_permitted" });
    expect(JSON.stringify(described)).not.toMatch(/alice|Alice Co|org-secret-id|max/);
  });

  it("describes a permitted sign-in with its kind and no issue", async () => {
    const adapter = withNativeAuthentication(
      createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" }),
      "claude-code",
      createNativeLoginState(runner({ status: CONSOLE }))
    );
    await adapter.connect();
    const described = adapter.describeAuthentication();
    expect(described).toMatchObject({ state: "authenticated", kind: "account" });
    expect(described.issue).toBeUndefined();
  });

  it("reports a sign-in that finished but still is not signed in as a failure", async () => {
    const adapter = withNativeAuthentication(
      createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" }),
      "claude-code",
      createNativeLoginState(runner({ status: SIGNED_OUT, login: { ok: true, exitCode: 0, stdout: "" } }))
    );
    expect(await adapter.authenticate("console")).toMatchObject({ ok: false, error: { code: "configuration" } });
  });

  it("reports a sign-in process that failed or timed out as unreachable", async () => {
    const adapter = withNativeAuthentication(
      createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" }),
      "claude-code",
      createNativeLoginState(runner({ status: SIGNED_OUT, login: { ok: false, reason: "timeout" } }))
    );
    expect(await adapter.authenticate("console")).toMatchObject({ ok: false, error: { code: "unreachable" } });
  });

  it("keeps the adapter's own members reachable", () => {
    const base = createUnimplementedControlAdapter({ provider: "claude-code", detail: "x" });
    const wrapped = withNativeAuthentication(base, "claude-code", createNativeLoginState(runner({})));
    expect(wrapped.provider).toBe("claude-code");
    expect(typeof wrapped.createSession).toBe("function");
    expect(wrapped.getCapabilities()).toBe(base.getCapabilities());
  });
});
