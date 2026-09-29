import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { agentEnvironment } from "./env";
import { createNativeLoginSource, createNativeLoginState } from "./native-auth";

/**
 * Credential isolation across providers (Agent Authentication & Runtime).
 *
 *   - An agent Hubble launches gets an allowlisted environment: no provider's
 *     key, token or cloud credential — its own or another provider's.
 *   - The one credential Hubble ever resolves for a provider (a user's own
 *     Anthropic key, on the web) is resolved *for that provider* and written
 *     into that provider's process only.
 *   - A runtime-owned sign-in carries no credential through Hubble at all.
 */

const SRC = path.resolve(__dirname, "../../..");

/** Every credential-shaped variable an operator or developer might have in the host environment. */
const HOST_SECRETS: Record<string, string> = {
  ANTHROPIC_API_KEY: "sk-ant-host-0000000000000000",
  ANTHROPIC_AUTH_TOKEN: "anthropic-token-host",
  CLAUDE_CODE_OAUTH_TOKEN: "sk-ant-oat-host",
  // A distinctive value: a bare "1" would match the agent's own NO_COLOR=1.
  CLAUDE_CODE_USE_BEDROCK: "bedrock-flag-from-host",
  OPENAI_API_KEY: "sk-openai-host",
  CODEX_API_KEY: "codex-host",
  GEMINI_API_KEY: "gemini-host",
  GOOGLE_API_KEY: "google-host",
  GOOGLE_APPLICATION_CREDENTIALS: "C:/secrets/gcp.json",
  XAI_API_KEY: "xai-host",
  AWS_ACCESS_KEY_ID: "AKIAHOST",
  AWS_SECRET_ACCESS_KEY: "aws-host-secret",
  TABDUMP_CREDENTIAL_KEY: "hubble-master-key",
  DATABASE_URL: "postgres://user:pass@host/db",
};

describe("what an agent Hubble launches can see", () => {
  it("carries no provider's credential, whichever agent it is", () => {
    const env = agentEnvironment({ PATH: "C:/Tools", USERPROFILE: "C:/Users/alice", ...HOST_SECRETS });
    for (const name of Object.keys(HOST_SECRETS)) expect(`${name}: ${name in env}`).toBe(`${name}: false`);
    const values = JSON.stringify(env);
    for (const value of Object.values(HOST_SECRETS)) expect(values).not.toContain(value);
  });

  it("is the same environment for every ACP agent — one agent's login never becomes another's", () => {
    const launcher = readFileSync(path.join(SRC, "lib/agents/launch/process.ts"), "utf8");
    // Built from the allowlist, per launch, with nothing provider-specific added.
    expect(launcher).toContain("env: agentEnvironment(options.env)");
    expect(launcher).not.toMatch(/resolveProviderCredential|credentials\//);
  });
});

describe("the one credential Hubble resolves", () => {
  it("is resolved for Claude only, and only into Claude's own process", () => {
    const server = readFileSync(path.join(SRC, "lib/agents/runtime/server.ts"), "utf8");
    const calls = server.match(/resolveProviderCredential\([^)]*\)/g) ?? [];
    expect(calls).toEqual(['resolveProviderCredential(ownerId, "claude-code")']);
    // No ACP adapter or launcher reaches the credential store.
    for (const file of ["lib/agents/control/providers/acp/adapter.ts", "lib/agents/control/providers/acp/launcher.ts"]) {
      const source = readFileSync(path.join(SRC, file), "utf8");
      expect(`${file}: ${/credentials\/|resolveProviderCredential/.test(source)}`).toBe(`${file}: false`);
    }
  });

  it("never reaches the browser: no route answers with one, no client type has a field for one", () => {
    const protocol = readFileSync(path.join(SRC, "lib/agents/runtime/protocol.ts"), "utf8");
    expect(protocol).not.toMatch(/\b(apiKey|accessToken|refreshToken|secret|password)\s*[?]?:/);
  });
});

describe("a runtime-owned sign-in", () => {
  it("hands the agent an empty credential environment — its own store supplies the login", async () => {
    const state = createNativeLoginState({
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "not-a-subscription", apiProvider: "firstParty" }),
      }),
    });
    const resolved = await createNativeLoginSource(state)();
    expect(resolved).toEqual({ ok: true, connectionId: "native-login", env: {} });
  });

  it("never falls back to a key in the environment when the account sign-in is refused", async () => {
    const state = createNativeLoginState({
      run: async () => ({
        ok: true,
        exitCode: 0,
        stdout: JSON.stringify({ loggedIn: true, authMethod: "claude.ai", subscriptionType: "pro" }),
      }),
    });
    // Refused — not "ok, with the API key from the environment".
    expect(await createNativeLoginSource(state)()).toEqual({ ok: false, reason: "not_permitted" });
  });
});
