import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  activeAuthMethod,
  agentCapabilities,
  authIntro,
  externalAuthMethods,
  methodAvailability,
  offeredAuthMethods,
  signInShape,
  unavailableAuthMethods,
  validateAgentDefinition,
} from "./authentication";
import { PLATFORM_PROVIDERS, platformProvider } from "./catalog";
import { PROVIDER_LAUNCH_TABLE } from "@/lib/agents/launch/allowlist";
import type { AgentAuthMethod, PlatformProvider } from "./catalog";
import type { ProviderConnectionView } from "@/lib/agents/runtime/protocol";

/**
 * Agent Authentication & Runtime — the capability model.
 *
 * The catalogue is the source of truth for which authentication methods a
 * provider has and which Hubble offers; everything the UI shows is derived
 * here. These tests pin what was *verified* per provider (see
 * docs/agent-authentication.md), the rules any definition must meet, and that
 * nothing here can carry a credential.
 */

const claude = platformProvider("claude-code")!;
const codex = platformProvider("openai-codex")!;
const gemini = platformProvider("gemini")!;
const grok = platformProvider("grok")!;
const custom = platformProvider("custom")!;

function ids(methods: readonly { method: AgentAuthMethod }[] | readonly AgentAuthMethod[]): string[] {
  return methods.map((entry) => ("method" in entry ? entry.method.id : entry.id));
}

function view(over: Partial<ProviderConnectionView> = {}): ProviderConnectionView {
  return {
    provider: "gemini",
    connection: "connected",
    available: true,
    authentication: "required",
    capabilities: ["create_session"],
    nativeSignIn: true,
    authMethods: [],
    ...over,
  };
}

describe("capability registration", () => {
  it("gives every shipped agent a runtime and at least one authentication method", () => {
    for (const provider of PLATFORM_PROVIDERS) {
      expect(provider.runtimeName.length).toBeGreaterThan(0);
      expect(provider.auth.length).toBeGreaterThan(0);
    }
  });

  it("holds every shipped definition to the security rules", () => {
    for (const provider of PLATFORM_PROVIDERS) expect([provider.provider, validateAgentDefinition(provider)]).toEqual([provider.provider, []]);
  });

  it("offers a runtime sign-in only with the ids the agent's own launch entry can run", () => {
    // Claude's native login ids come from the allowlist; a catalogue method
    // offered for it must name one the allowlist actually runs.
    const loginIds = Object.keys(PROVIDER_LAUNCH_TABLE.find((entry) => entry.provider === "claude-code")!.native!.loginArgs);
    for (const method of claude.auth) {
      if (method.owner !== "runtime" || method.support.status !== "offered") continue;
      expect(method.runtimeMethodIds?.every((id) => loginIds.includes(id))).toBe(true);
    }
    // …and the unsupported subscription login is not one the allowlist runs.
    expect(loginIds).not.toContain("claudeai");
  });
});

describe("supported and unsupported methods, per provider and surface", () => {
  it("Claude on the web: the user's own API key only; the subscription route is refused with Anthropic's reason", () => {
    expect(ids(offeredAuthMethods(claude, "web"))).toEqual(["anthropic-api-key"]);
    const refused = unavailableAuthMethods(claude, "web");
    expect(ids(refused.map((entry) => entry.method))).toEqual([
      "anthropic-console",
      "claude-subscription",
      "claude-cloud-provider",
    ]);
    expect(refused.find((entry) => entry.method.id === "claude-subscription")!.reason).toMatch(
      /doesn't allow apps built on the Claude Agent SDK/
    );
  });

  it("Claude in the desktop app: the Console sign-in through Claude Code; a cloud provider is recognised, not collected", () => {
    expect(ids(offeredAuthMethods(claude, "desktop"))).toEqual(["anthropic-console"]);
    expect(ids(externalAuthMethods(claude, "desktop"))).toEqual(["claude-cloud-provider"]);
    expect(ids(unavailableAuthMethods(claude, "desktop").map((entry) => entry.method))).toEqual([
      "anthropic-api-key",
      "claude-subscription",
    ]);
  });

  it("never offers a Claude subscription anywhere", () => {
    for (const surface of ["web", "desktop"] as const) {
      expect(methodAvailability(claude.auth.find((method) => method.id === "claude-subscription")!, surface).status).toBe(
        "unsupported"
      );
    }
  });

  it("Gemini, Codex and Grok: their own account sign-in only; API keys and environment credentials are refused", () => {
    expect(ids(offeredAuthMethods(gemini, "desktop"))).toEqual(["google-account"]);
    expect(ids(unavailableAuthMethods(gemini, "desktop").map((entry) => entry.method))).toEqual(["gemini-api-key", "vertex-ai"]);
    expect(ids(offeredAuthMethods(codex, "desktop"))).toEqual(["chatgpt-account"]);
    expect(ids(unavailableAuthMethods(codex, "desktop").map((entry) => entry.method))).toEqual(["openai-api-key"]);
    expect(ids(offeredAuthMethods(grok, "desktop"))).toEqual(["xai-account"]);
    expect(ids(unavailableAuthMethods(grok, "desktop").map((entry) => entry.method))).toEqual(["xai-api-key"]);
  });

  it("the custom agent: a Hubble token on the web, nothing in the desktop app", () => {
    expect(ids(offeredAuthMethods(custom, "web"))).toEqual(["hubble-access-token"]);
    expect(offeredAuthMethods(custom, "desktop")).toEqual([]);
    expect(unavailableAuthMethods(custom, "desktop")[0]!.reason).toMatch(/desktop app does not run one/);
  });

  it("claims subscription support only where the provider documents it, and only through its own runtime", () => {
    const table = Object.fromEntries(
      PLATFORM_PROVIDERS.map((provider) => [provider.provider, agentCapabilities(provider, "desktop").supportsSubscriptionAuth])
    );
    expect(table).toEqual({
      "claude-code": false,
      "openai-codex": true,
      gemini: true,
      grok: false,
      custom: false,
    });
  });
});

describe("reconciling with what the agent itself advertised", () => {
  it("offers a runtime sign-in with the agent's own id, and nothing the agent did not advertise", () => {
    const advertised = [{ id: "oauth-personal", name: "Log in with Google" }];
    expect(offeredAuthMethods(gemini, "desktop", advertised)).toEqual([
      { method: gemini.auth[0], runtimeMethodId: "oauth-personal" },
    ]);
    expect(offeredAuthMethods(gemini, "desktop", [])).toEqual([]);
  });

  it("drops advertised methods the catalogue does not offer — an API key is never turned into a button", () => {
    const advertised = [
      { id: "gemini-api-key", name: "Use Gemini API key" },
      { id: "vertex-ai", name: "Vertex AI" },
      { id: "oauth-personal", name: "Log in with Google" },
    ];
    expect(offeredAuthMethods(gemini, "desktop", advertised).map((entry) => entry.runtimeMethodId)).toEqual(["oauth-personal"]);
  });

  it("drops a Claude subscription login even if a runtime advertises one", () => {
    const advertised = [
      { id: "claudeai", name: "Sign in with Claude" },
      { id: "console", name: "Sign in with Anthropic Console" },
    ];
    expect(offeredAuthMethods(claude, "desktop", advertised).map((entry) => entry.runtimeMethodId)).toEqual(["console"]);
  });

  it("lists a runtime sign-in without an id before the agent has been asked", () => {
    expect(offeredAuthMethods(grok, "desktop")).toEqual([{ method: grok.auth[0] }]);
  });
});

describe("the method in use", () => {
  it("comes only from the runtime's closed report, never from what happens to be offered", () => {
    expect(activeAuthMethod(gemini, view({ authentication: "authenticated" }))).toBeUndefined();
    expect(activeAuthMethod(claude, view({ provider: "claude-code", authentication: "authenticated", authKind: "account" }))?.id).toBe(
      "anthropic-console"
    );
    expect(
      activeAuthMethod(claude, view({ provider: "claude-code", authentication: "authenticated", authKind: "subscription" }))?.id
    ).toBe("claude-subscription");
    // Not signed in: no method is "in use", whatever kind is reported.
    expect(activeAuthMethod(claude, view({ provider: "claude-code", authentication: "required", authKind: "account" }))).toBeUndefined();
  });
});

describe("how an agent signs in here", () => {
  it("derives the three shapes from the offered methods, and lets the runtime's native sign-in win", () => {
    expect(signInShape(claude, "web")).toBe("provider-key");
    expect(signInShape(claude, "desktop")).toBe("native");
    expect(signInShape(gemini, "web")).toBe("native");
    expect(signInShape(custom, "web")).toBe("mcp-token");
    expect(signInShape(claude, "web", view({ provider: "claude-code", nativeSignIn: true }))).toBe("native");
  });

  it("says 'use your existing account' only where an account sign-in is offered", () => {
    expect(authIntro(gemini, "desktop")).toMatch(/Gemini CLI can authenticate using your existing Google account/);
    expect(authIntro(claude, "desktop")).toMatch(/your existing Anthropic Console account/);
    expect(authIntro(claude, "web")).toBe("Claude Code runs on your own Anthropic API key here.");
    expect(authIntro(claude, "web")).not.toMatch(/account/);
    expect(authIntro(custom, "desktop")).toBe("Authentication through Hubble isn't currently supported for Custom MCP agent.");
  });
});

describe("capabilities", () => {
  it("describes each agent from its catalogue entry alone", () => {
    expect(agentCapabilities(gemini, "desktop")).toMatchObject({
      runtimeName: "Gemini CLI",
      supportsAccountAuth: true,
      supportsApiKey: false,
      supportsLocalRuntime: true,
      supportsWorkspaceContext: true,
      supportsSessionControl: true,
      supportsMcp: true,
      detection: "executable",
      authenticationDetection: "agent-probe",
    });
    expect(agentCapabilities(claude, "web")).toMatchObject({
      supportsApiKey: true,
      supportsAccountAuth: false,
      authenticationDetection: "stored-credential",
    });
    expect(agentCapabilities(claude, "desktop")).toMatchObject({
      supportsApiKey: false,
      supportsAccountAuth: true,
      authenticationDetection: "cli-status",
    });
    expect(agentCapabilities(codex, "desktop")).toMatchObject({ supportsSessionControl: false });
    expect(agentCapabilities(custom, "web")).toMatchObject({
      supportsLocalRuntime: false,
      supportsSessionControl: false,
      supportsMcp: true,
      detection: "none",
      authenticationDetection: "hubble-token",
    });
    expect(agentCapabilities(custom, "desktop")).toMatchObject({ supportedAuthMethods: [], authenticationDetection: "none" });
  });

  it("keeps each provider's capabilities its own", () => {
    const before = JSON.stringify(agentCapabilities(gemini, "desktop"));
    // Deriving another provider's — including one refused everywhere — changes nothing for Gemini.
    agentCapabilities(claude, "desktop");
    agentCapabilities(codex, "web");
    expect(JSON.stringify(agentCapabilities(gemini, "desktop"))).toBe(before);
  });
});

describe("custom agent definitions cannot bypass the security model", () => {
  const base: PlatformProvider = { ...custom };

  it("accepts the shipped custom agent", () => {
    expect(validateAgentDefinition(base)).toEqual([]);
  });

  it("refuses a custom agent that declares a sign-in for Hubble to run, a session or a chat", () => {
    const launched: PlatformProvider = {
      ...base,
      chat: true,
      sessions: { available: true },
      auth: [
        ...base.auth,
        {
          id: "their-login",
          label: "Their login",
          kind: "account",
          subscription: false,
          owner: "runtime",
          summary: "x",
          support: { status: "offered", surfaces: ["web"] },
          runtimeMethodIds: ["login"],
        },
      ],
    };
    expect(validateAgentDefinition(launched).sort()).toEqual(
      ["client_agent_with_chat", "client_agent_with_runtime_auth", "client_agent_with_sessions"].sort()
    );
  });

  it("refuses an API key Hubble would hold for an agent it launches as a process", () => {
    const acpWithKey: PlatformProvider = {
      ...gemini,
      auth: [
        {
          id: "stored-key",
          label: "Stored key",
          kind: "api_key",
          subscription: false,
          owner: "hubble",
          summary: "x",
          support: { status: "offered", surfaces: ["web"] },
        },
      ],
    };
    expect(validateAgentDefinition(acpWithKey)).toEqual(["hubble_held_key_outside_sdk"]);
  });

  it("refuses offering a plan login Hubble would collect, an environment credential, or a sign-in the agent never advertises", () => {
    const bad: PlatformProvider = {
      ...claude,
      auth: [
        {
          id: "collected-plan",
          label: "x",
          kind: "account",
          subscription: true,
          owner: "hubble",
          summary: "x",
          support: { status: "offered", surfaces: ["web"] },
        },
        {
          id: "env",
          label: "x",
          kind: "environment",
          subscription: false,
          owner: "agent_config",
          summary: "x",
          support: { status: "offered", surfaces: ["desktop"] },
        },
        {
          id: "unadvertised",
          label: "x",
          kind: "account",
          subscription: false,
          owner: "runtime",
          summary: "x",
          support: { status: "offered", surfaces: ["desktop"] },
        },
      ],
    };
    expect(validateAgentDefinition(bad).sort()).toEqual(
      ["environment_credential_offered", "hubble_held_subscription", "runtime_sign_in_without_runtime_ids"].sort()
    );
  });

  it("refuses an unsupported method without a reason, duplicate ids, and a method outside the agent's surfaces", () => {
    const bad: PlatformProvider = {
      ...base,
      auth: [
        { ...base.auth[0]!, support: { status: "offered", surfaces: ["desktop"] } },
        { ...base.auth[0]!, support: { status: "unsupported", reason: " " } },
      ],
    };
    expect(validateAgentDefinition(bad).sort()).toEqual(
      ["duplicate_method_id", "method_surface_outside_provider", "unsupported_without_reason"].sort()
    );
    expect(validateAgentDefinition({ ...base, auth: [] })).toEqual(["no_auth_methods"]);
  });
});

describe("no credential in the model", () => {
  it("declares no field a credential could be put in", () => {
    for (const file of ["authentication.ts", "catalog.ts"]) {
      const source = readFileSync(path.resolve(__dirname, file), "utf8");
      for (const pattern of [/\bapiKey\s*:/i, /\baccessToken\b/i, /\brefreshToken\b/i, /\bpassword\s*:/i, /\bsecret\s*:/i, /\btoken\s*:/i]) {
        expect(`${file}: ${pattern.test(source)}`).toBe(`${file}: false`);
      }
    }
  });

  it("serializes every provider's capabilities without anything credential-shaped", () => {
    const serialized = JSON.stringify(PLATFORM_PROVIDERS.flatMap((provider) => [agentCapabilities(provider, "web"), agentCapabilities(provider, "desktop")]));
    expect(serialized).not.toMatch(/sk-ant-|sk-[A-Za-z0-9]{20}|xai-[A-Za-z0-9]{10}|AIza[0-9A-Za-z]{10}|Bearer /);
  });
});
