import { describe, expect, it, vi } from "vitest";
import { createTestConnector } from "./__fixtures__/test-connector";
import { createConnectorRegistry } from "./registry";
import { NO_CAPABILITIES } from "./types";
import type { ConnectorRegistration } from "./registry";
import type { AgentProviderId, ProviderDescriptor } from "./types";

function descriptor(provider: AgentProviderId, displayName = provider): ProviderDescriptor {
  return {
    provider,
    displayName,
    summary: "A provider.",
    capabilities: NO_CAPABILITIES,
  };
}

function registration(
  provider: AgentProviderId,
  create = () => createTestConnector({ provider })
): ConnectorRegistration {
  return { descriptor: descriptor(provider), create };
}

describe("registering providers", () => {
  it("keeps registration order, which is display order", () => {
    const registry = createConnectorRegistry();
    registry.register(registration("claude-code"));
    registry.register(registration("gemini"));
    registry.register(registration("grok"));

    expect(registry.describeAll().map((entry) => entry.provider)).toEqual([
      "claude-code",
      "gemini",
      "grok",
    ]);
  });

  it("refuses a duplicate rather than replacing the first", () => {
    const registry = createConnectorRegistry();
    const first = createTestConnector({ provider: "gemini", displayName: "First" });

    registry.register(registration("gemini", () => first));
    const second = registry.register(registration("gemini"));

    expect(second).toEqual({ ok: false, reason: "duplicate-provider" });
    // The original survives: a silent overwrite would leave whoever
    // registered first holding a connector nobody else can reach.
    expect(registry.get("gemini")).toBe(first);
    expect(registry.describeAll()).toHaveLength(1);
  });

  it("reports an unregistered provider as absent rather than throwing", () => {
    const registry = createConnectorRegistry();

    expect(registry.has("grok")).toBe(false);
    expect(registry.describe("grok")).toBeUndefined();
    expect(registry.get("grok")).toBeUndefined();
  });
});

describe("constructing connectors", () => {
  it("constructs nothing until a connector is actually asked for", () => {
    const create = vi.fn(() => createTestConnector({ provider: "claude-code" }));
    const registry = createConnectorRegistry();
    registry.register(registration("claude-code", create));

    // The whole point of splitting descriptor from factory: settings can list
    // five providers without building five connectors or starting five timers.
    registry.describeAll();
    registry.describe("claude-code");
    registry.has("claude-code");
    expect(create).not.toHaveBeenCalled();

    registry.get("claude-code");
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("memoises, so every caller shares one connector per provider", () => {
    const create = vi.fn(() => createTestConnector({ provider: "claude-code" }));
    const registry = createConnectorRegistry();
    registry.register(registration("claude-code", create));

    const a = registry.get("claude-code");
    const b = registry.get("claude-code");

    expect(a).toBe(b);
    expect(create).toHaveBeenCalledTimes(1);
  });

  it("lists only what was constructed", () => {
    const registry = createConnectorRegistry();
    registry.register(registration("claude-code"));
    registry.register(registration("gemini"));

    expect(registry.instantiated()).toEqual([]);

    registry.get("gemini");
    expect(registry.instantiated().map((entry) => entry.provider)).toEqual(["gemini"]);
  });
});

describe("disposal", () => {
  it("disposes every constructed connector and forgets it", () => {
    const registry = createConnectorRegistry();
    registry.register(registration("claude-code"));
    registry.register(registration("gemini"));

    const claude = registry.get("claude-code");
    registry.disposeAll();

    expect((claude as ReturnType<typeof createTestConnector>).disposed).toBe(true);
    expect(registry.instantiated()).toEqual([]);
  });

  it("does not construct a connector in order to dispose it", () => {
    const create = vi.fn(() => createTestConnector({ provider: "grok" }));
    const registry = createConnectorRegistry();
    registry.register(registration("grok", create));

    registry.disposeAll();

    expect(create).not.toHaveBeenCalled();
  });

  it("keeps registrations, so a disposed registry can be used again", () => {
    const registry = createConnectorRegistry();
    registry.register(registration("gemini"));

    registry.get("gemini");
    registry.disposeAll();

    expect(registry.has("gemini")).toBe(true);
    expect(registry.get("gemini")).toBeDefined();
  });
});
