import { beforeEach, describe, expect, it } from "vitest";
import { pathToFileURL } from "node:url";
import path from "node:path";
import { createSdkClaudeRuntime } from "./sdk-runtime";
import { recordedCalls, resetRecordedCalls } from "./__fixtures__/fake-sdk";
import {
  LEAK_CANARY,
  missingCredentialSource,
  staticCredentialSource,
} from "@/lib/agents/credentials/__fixtures__/source";
import type { ClaudeRuntimeStartOptions } from "./runtime";

/**
 * The local runtime's half of bring-your-own-credentials.
 *
 * ## What changed, and why it needed a test
 *
 * The local runtime used to pass no environment at all: the agent process
 * inherited whatever the server process had, which on a developer's machine is
 * their own Claude Code login and on any deployment with `ANTHROPIC_API_KEY`
 * set is *the operator's*, used silently for everybody. From inside
 * `sdk-runtime.ts` those two are indistinguishable, so it no longer tries to
 * tell them apart — a credential arrives explicitly or the run does not start.
 *
 * These tests pin both halves of that: the refusal, and the fact that the
 * inherited variables are removed rather than merely overwritten.
 */

// A real module on disk, loaded through the same dynamic `import()`
// production uses. Not `vi.mock` — see the note in the fixture.
const FAKE_SDK = pathToFileURL(
  path.resolve(__dirname, "__fixtures__/fake-sdk.ts")
).href;

const MISSING_SDK = pathToFileURL(
  path.resolve(__dirname, "__fixtures__/does-not-exist.ts")
).href;

function startOptions(over: Partial<ClaudeRuntimeStartOptions> = {}): ClaudeRuntimeStartOptions {
  return {
    sessionId: "cs-1",
    additionalDirectories: [],
    permissionMode: "default",
    allowedTools: ["Read"],
    disallowedTools: ["Bash"],
    onMessage: () => {},
    onPermissionRequest: async () => ({ behavior: "deny", message: "no" }),
    onExit: () => {},
    ...over,
  };
}

/** The environment a deployment might have, including an operator key. */
const HOSTILE_BASE_ENV = {
  PATH: "/usr/bin",
  HOME: "/home/app",
  // The thing this phase removed. If it ever reaches an agent process again,
  // the test below fails.
  ANTHROPIC_API_KEY: "sk-ant-OPERATOR-KEY-MUST-NOT-BE-USED",
  ANTHROPIC_AUTH_TOKEN: "oauth-OPERATOR-TOKEN-MUST-NOT-BE-USED",
  ANTHROPIC_BASE_URL: "https://operator-proxy.invalid",
  UNRELATED: "kept",
};

beforeEach(() => {
  resetRecordedCalls();
});

describe("availability", () => {
  it("is unavailable when the SDK cannot be loaded", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: MISSING_SDK,
      credentials: staticCredentialSource(),
    });

    expect(await runtime.isAvailable()).toBe(false);
    expect(await runtime.describeAvailability?.()).toEqual({ kind: "unavailable" });
  });

  it("distinguishes a missing credential from a missing SDK", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: missingCredentialSource("not_connected"),
    });

    // Two states that used to collapse into one `false`. They need different
    // sentences: one is a machine problem the user cannot fix, the other is a
    // button they have not pressed.
    expect(await runtime.isAvailable()).toBe(false);
    expect(await runtime.describeAvailability?.()).toEqual({
      kind: "credential-required",
      reason: "not_connected",
    });
  });

  it("is available when both the SDK and a credential are present", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource(),
    });

    expect(await runtime.isAvailable()).toBe(true);
    expect(await runtime.describeAvailability?.()).toEqual({ kind: "available" });
  });
});

describe("starting a run", () => {
  it("refuses when the user has no usable connection", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: missingCredentialSource("not_usable"),
      baseEnv: HOSTILE_BASE_ENV,
    });

    const result = await runtime.start(startOptions());

    expect(result.ok).toBe(false);
    expect(result.ok === false && result.error.code).toBe("authentication");
    // And nothing was launched. A refusal that still started a process would
    // be the worst of both.
    expect(recordedCalls()).toHaveLength(0);
  });

  it("puts the user's own credential in the agent's environment", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource(LEAK_CANARY, "pc-alice"),
      baseEnv: HOSTILE_BASE_ENV,
    });

    const result = await runtime.start(startOptions());
    expect(result.ok).toBe(true);

    const env = recordedCalls()[0]?.options.env as Record<string, string>;
    expect(env.ANTHROPIC_API_KEY).toBe(LEAK_CANARY);
  });

  it("strips the deployment's own provider variables rather than only overwriting them", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource(LEAK_CANARY, "pc-alice"),
      baseEnv: HOSTILE_BASE_ENV,
    });

    await runtime.start(startOptions());
    const env = recordedCalls()[0]?.options.env as Record<string, string>;

    // The operator's key is gone, not shadowed. Overwriting alone would mean a
    // future edit that forgot to set the variable falls through to it and
    // silently works — which is the failure that is invisible until a billing
    // statement arrives.
    expect(env.ANTHROPIC_API_KEY).not.toContain("OPERATOR");
    expect(env.ANTHROPIC_AUTH_TOKEN).toBeUndefined();
    expect(env.ANTHROPIC_BASE_URL).toBeUndefined();

    // Everything unrelated is inherited: the agent still needs a PATH.
    expect(env.PATH).toBe("/usr/bin");
    expect(env.UNRELATED).toBe("kept");
  });

  it("does not mutate the process environment it was given", async () => {
    const base = { ...HOSTILE_BASE_ENV };
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource(LEAK_CANARY),
      baseEnv: base,
    });

    await runtime.start(startOptions());

    // Building a fresh map per run — rather than setting a global and clearing
    // it afterwards — is what lets two concurrent sessions belonging to two
    // different users run without seeing each other's key.
    expect(base).toEqual(HOSTILE_BASE_ENV);
  });

  it("gives two users' runs two different environments", async () => {
    const alice = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource("sk-ant-ALICE", "pc-alice"),
      baseEnv: HOSTILE_BASE_ENV,
    });
    const bob = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource("sk-ant-BOB", "pc-bob"),
      baseEnv: HOSTILE_BASE_ENV,
    });

    await Promise.all([alice.start(startOptions()), bob.start(startOptions())]);

    const keys = recordedCalls().map(
      (call) => (call.options.env as Record<string, string>).ANTHROPIC_API_KEY
    );
    expect(keys.sort()).toEqual(["sk-ant-ALICE", "sk-ant-BOB"]);
  });

  it("resolves the credential on every start, not once at construction", async () => {
    let current: string | null = "sk-ant-FIRST";
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      baseEnv: HOSTILE_BASE_ENV,
      credentials: async () =>
        current
          ? { ok: true, connectionId: "pc-1", env: { ANTHROPIC_API_KEY: current } }
          : { ok: false, reason: "not_connected" },
    });

    await runtime.start(startOptions());
    current = "sk-ant-SECOND";
    await runtime.start(startOptions());
    current = null;
    const refused = await runtime.start(startOptions());

    // A user who rotates their key gets the new one on the next session, and a
    // user who disconnects cannot start another — without anything being
    // rebuilt.
    const keys = recordedCalls().map(
      (call) => (call.options.env as Record<string, string>).ANTHROPIC_API_KEY
    );
    expect(keys).toEqual(["sk-ant-FIRST", "sk-ant-SECOND"]);
    expect(refused.ok).toBe(false);
  });

  it("puts the credential in the environment and nowhere else in the SDK call", async () => {
    const runtime = createSdkClaudeRuntime({
      moduleSpecifier: FAKE_SDK,
      credentials: staticCredentialSource(LEAK_CANARY),
      baseEnv: { PATH: "/usr/bin" },
    });

    await runtime.start(startOptions({ cwd: "C:/work/project" }));

    const call = recordedCalls()[0]!;
    const optionsWithoutEnv = { ...call.options };
    delete optionsWithoutEnv.env;

    // Not in the tool lists, not in the permission mode, not in the prompt
    // queue, not in `cwd`, not in anything the SDK is otherwise handed.
    expect(JSON.stringify(optionsWithoutEnv)).not.toContain(LEAK_CANARY);
    expect(JSON.stringify(call.prompt)).not.toContain(LEAK_CANARY);
  });
});

describe("the session's Hubble context server (Phase J.3)", () => {
  const TOKEN = "tdctx_SESSION-CREDENTIAL-MUST-NOT-REACH-ARGV";

  it("configures no MCP server at all for a session without workspace context", async () => {
    const runtime = createSdkClaudeRuntime({ moduleSpecifier: FAKE_SDK, credentials: staticCredentialSource() });
    await runtime.start(startOptions());
    const options = recordedCalls()[0]?.options as Record<string, unknown>;
    expect(options.mcpServers).toEqual({});
    expect(options.strictMcpConfig).toBe(true);
    expect((options.env as Record<string, string>).TABDUMP_CONTEXT_TOKEN).toBeUndefined();
  });

  it("gives the agent exactly Hubble's server, with the credential in its environment and only a placeholder in its config", async () => {
    const runtime = createSdkClaudeRuntime({ moduleSpecifier: FAKE_SDK, credentials: staticCredentialSource() });
    await runtime.start(
      startOptions({ contextServer: { name: "tabdump", url: "http://127.0.0.1:5123/mcp", token: TOKEN } })
    );
    const options = recordedCalls()[0]?.options as Record<string, unknown>;

    expect(options.strictMcpConfig).toBe(true);
    expect(options.mcpServers).toEqual({
      tabdump: {
        type: "http",
        url: "http://127.0.0.1:5123/mcp",
        headers: { Authorization: "Bearer ${TABDUMP_CONTEXT_TOKEN}" },
      },
    });
    // The SDK turns mcpServers into `--mcp-config <json>` on the command line:
    // the token must not be anywhere in what becomes argv.
    expect(JSON.stringify(options.mcpServers)).not.toContain(TOKEN);
    expect((options.env as Record<string, string>).TABDUMP_CONTEXT_TOKEN).toBe(TOKEN);
  });
});
