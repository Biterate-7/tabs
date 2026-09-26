import { afterEach, describe, expect, it } from "vitest";
import { clearAllSessionCredentials, setSessionCredential } from "../session-credentials";
import { defaultConnectorCatalog } from "../catalog";
import { createDeclaredConnector } from "./declared";
import { NO_CAPABILITIES } from "../types";
import type { ConnectorObservation, ProviderDescriptor } from "../types";

/**
 * The providers that are registered and do not work yet.
 *
 * What is being pinned here is honesty. A phase that adds four provider cards
 * is exactly the phase in which one of them quietly starts reporting
 * "Connected" with nothing behind it, so these tests assert the absence of
 * that: no observation can be produced, no connected state can be reached,
 * and the reason a connector cannot work is always stated.
 */

function descriptorFor(provider: ProviderDescriptor["provider"]): ProviderDescriptor {
  return {
    provider,
    displayName: "Test provider",
    summary: "Would observe something.",
    capabilities: NO_CAPABILITIES,
    requirement: "Needs a verified way to read its activity locally.",
  };
}

afterEach(() => {
  clearAllSessionCredentials();
});

describe("connecting a declared provider", () => {
  it("lands on unavailable and says why", async () => {
    const connector = createDeclaredConnector({
      descriptor: descriptorFor("gemini"),
      unavailableDetail: "Hubble cannot observe Gemini from this environment yet.",
    });

    const status = await connector.connect();

    expect(status.kind).toBe("unavailable");
    expect(status.detail).toContain("cannot observe Gemini");
    expect(status.lastError?.code).toBe("unsupported");

    connector.dispose();
  });

  it("never reaches connected, however many times it is connected", async () => {
    const connector = createDeclaredConnector({
      descriptor: descriptorFor("grok"),
      unavailableDetail: "Not here.",
    });

    for (let i = 0; i < 5; i += 1) {
      const status = await connector.connect();
      expect(status.kind).not.toBe("connected");
    }

    connector.dispose();
  });

  it("distinguishes needs-setup from unavailable", async () => {
    const descriptor = descriptorFor("gemini");
    const connector = createDeclaredConnector({
      descriptor,
      requiresCredential: true,
      unavailableDetail: "Not here.",
    });

    // Missing something the user can supply — actionable by them.
    const missing = await connector.connect();
    expect(missing.kind).toBe("configuration_required");
    expect(missing.detail).toBe(descriptor.requirement);

    // Supplied, and still not observable — not actionable by them.
    setSessionCredential("gemini", "sk-live-value");
    const supplied = await connector.connect();
    expect(supplied.kind).toBe("unavailable");

    connector.dispose();
  });
});

describe("a declared provider observes nothing", () => {
  it("never delivers an observation", async () => {
    const connector = createDeclaredConnector({
      descriptor: descriptorFor("openai-codex"),
      unavailableDetail: "Not here.",
    });

    const batches: ConnectorObservation[][] = [];
    connector.subscribe((incoming) => batches.push(incoming));

    await connector.connect();
    await connector.connect();
    connector.disconnect();
    await connector.connect();

    expect(batches).toEqual([]);
    expect(connector.getStatus().lastObservationAt).toBeUndefined();

    connector.dispose();
  });

  it("accepts a subscriber so the contract stays uniform", () => {
    const connector = createDeclaredConnector({
      descriptor: descriptorFor("custom"),
      unavailableDetail: "Not here.",
    });

    // A future real implementation is then a change of source, not of shape.
    const off = connector.subscribe(() => {});
    expect(() => off()).not.toThrow();

    connector.dispose();
  });
});

describe("lifecycle", () => {
  it("returns to disconnected and can be retried", async () => {
    const connector = createDeclaredConnector({
      descriptor: descriptorFor("grok"),
      unavailableDetail: "Not here.",
    });

    await connector.connect();
    connector.disconnect();

    expect(connector.getStatus().kind).toBe("disconnected");
    // The stale reason goes with the state: a dismissed explanation must not
    // linger on a card that now reads "Not connected".
    expect(connector.getStatus().detail).toBeUndefined();

    connector.dispose();
  });

  it("does nothing after disposal", async () => {
    const connector = createDeclaredConnector({
      descriptor: descriptorFor("grok"),
      unavailableDetail: "Not here.",
    });

    connector.dispose();
    const status = await connector.connect();

    expect(status.kind).toBe("disconnected");
  });
});

describe("the shipped catalog", () => {
  it("registers every provider the product claims to support", () => {
    const catalog = defaultConnectorCatalog();

    expect(catalog.map((entry) => entry.descriptor.provider)).toEqual([
      "claude-code",
      "openai-codex",
      "gemini",
      "grok",
      "custom",
    ]);
  });

  it("claims capabilities only for the provider that has them", () => {
    const catalog = defaultConnectorCatalog();

    const claude = catalog.find((entry) => entry.descriptor.provider === "claude-code")!;
    expect(claude.descriptor.capabilities.runs).toBe(true);

    // Empty rather than aspirational: a capability list that promised runs
    // and events would be a promise the connector cannot keep.
    for (const provider of ["openai-codex", "gemini", "grok", "custom"] as const) {
      const entry = catalog.find((candidate) => candidate.descriptor.provider === provider)!;
      expect(entry.descriptor.capabilities).toEqual(NO_CAPABILITIES);
      expect(entry.descriptor.requirement).toBeTruthy();
    }
  });

  it("gives every unimplemented provider a specific reason, not a generic one", () => {
    const reasons = defaultConnectorCatalog()
      .filter((entry) => entry.descriptor.provider !== "claude-code")
      .map((entry) => entry.descriptor.requirement);

    expect(new Set(reasons).size).toBe(reasons.length);
  });

  it("builds nothing until a connector is asked for", () => {
    // Descriptors are data; factories are lazy. Listing the catalog is free.
    const catalog = defaultConnectorCatalog();
    expect(catalog.every((entry) => typeof entry.create === "function")).toBe(true);
  });

  it("produces a connector that cannot observe for each unimplemented provider", async () => {
    const catalog = defaultConnectorCatalog();

    for (const entry of catalog) {
      if (entry.descriptor.provider === "claude-code") continue;

      const connector = entry.create();
      const status = await connector.connect();

      expect(status.kind).not.toBe("connected");
      expect(status.detail).toBeTruthy();

      connector.dispose();
    }
  });
});
