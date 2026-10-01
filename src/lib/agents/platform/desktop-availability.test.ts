import { describe, expect, it } from "vitest";
import { PLATFORM_PROVIDERS, isLocalProcessTransport, platformProvider } from "./catalog";
import { availableInDesktop, connectionPhase } from "./lifecycle";
import type { PlatformProvider } from "./catalog";

/**
 * "Available in Hubble Desktop" is derived from the lifecycle and the
 * catalogue, never from a list of provider names. These tests pin the hosted
 * web answer for today's catalogue, and the rule itself for any provider.
 */

/** The hosted web deployment: a remote runtime that can run agents (Claude), but nothing local. */
function hostedPhase(provider: PlatformProvider) {
  return connectionPhase({ provider, surface: "web", executable: true, local: false });
}

describe("availableInDesktop", () => {
  it("on hosted web, is true for exactly the agents that run as a local process", () => {
    const offered = PLATFORM_PROVIDERS.filter((spec) => availableInDesktop(spec, hostedPhase(spec), "web")).map(
      (spec) => spec.provider
    );
    expect(offered).toEqual(["openai-codex", "gemini", "grok"]);
    // The rule, not the names: every one of them is a local process the desktop app can start.
    for (const provider of offered) {
      const spec = platformProvider(provider)!;
      expect(isLocalProcessTransport(spec.transport)).toBe(true);
      expect(spec.surfaces).toContain("desktop");
    }
  });

  it("never claims Claude Code or the custom MCP agent on hosted web, where they are not runtime-unavailable", () => {
    for (const provider of ["claude-code", "custom"] as const) {
      const spec = platformProvider(provider)!;
      expect(hostedPhase(spec)).not.toBe("runtime_unavailable");
      expect(availableInDesktop(spec, hostedPhase(spec), "web")).toBe(false);
    }
  });

  it("offers Claude Code too on a web Hubble that cannot run agents at all", () => {
    const claude = platformProvider("claude-code")!;
    const phase = connectionPhase({ provider: claude, surface: "web", executable: false, local: false });
    expect(phase).toBe("runtime_unavailable");
    expect(availableInDesktop(claude, phase, "web")).toBe(true);
  });

  it("never offers an agent the desktop app cannot run either", () => {
    const custom = platformProvider("custom")!;
    expect(custom.surfaces).not.toContain("desktop");
    expect(availableInDesktop(custom, "runtime_unavailable", "web")).toBe(false);
  });

  it("is never true inside the desktop app", () => {
    for (const spec of PLATFORM_PROVIDERS) {
      expect(availableInDesktop(spec, "runtime_unavailable", "desktop")).toBe(false);
    }
  });

  it("is never true for any phase but runtime_unavailable", () => {
    const codex = platformProvider("openai-codex")!;
    for (const phase of ["not_installed", "sign_in_required", "connected", "unknown", "error"] as const) {
      expect(availableInDesktop(codex, phase, "web")).toBe(false);
    }
  });
});
