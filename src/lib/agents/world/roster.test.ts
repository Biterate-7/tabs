import { describe, expect, it } from "vitest";
import { buildWorldRoster } from "./roster";
import type { ConnectorView } from "@/lib/agents/connectors/manager";
import type { ConnectorStatusKind } from "@/lib/agents/connectors/types";

/**
 * The roster is the one derivation behind the idle world, and the thing it
 * has to get right is the distinction it exists to preserve: "here and idle"
 * and "not connected at all" must never collapse into each other, however
 * convenient a single "idle" bucket would be for the renderer.
 */

function view(
  provider: string,
  kind: ConnectorStatusKind,
  displayName = provider
): ConnectorView {
  return {
    descriptor: { provider, displayName, summary: "", capabilities: [] },
    status: { kind },
    health: { state: "unknown" },
    enabled: kind === "connected",
  } as unknown as ConnectorView;
}

describe("who is in the world", () => {
  it("draws only connected providers by default", () => {
    const roster = buildWorldRoster([
      view("claude-code", "connected"),
      view("gemini", "disconnected"),
    ]);

    expect(roster.map((entry) => entry.provider)).toEqual(["claude-code"]);
  });

  it("draws the whole catalogue when the surface asked for it", () => {
    const roster = buildWorldRoster(
      [view("claude-code", "connected"), view("gemini", "disconnected")],
      { includeAvailable: true }
    );

    expect(roster.map((entry) => entry.provider)).toEqual(["claude-code", "gemini"]);
  });

  it("never reports an unconnected provider as connected", () => {
    // The whole point of `presence`. An available agent is drawn so the world
    // is explorable; saying it was connected would be the one piece of
    // theatre this feature is built to avoid.
    const roster = buildWorldRoster(
      [
        view("claude-code", "connected"),
        view("openai-codex", "unavailable"),
        view("gemini", "configuration_required"),
      ],
      { includeAvailable: true }
    );

    expect(roster.map((entry) => entry.presence)).toEqual([
      "connected",
      "available",
      "available",
    ]);
  });

  it("uses the connector layer's own status words rather than inventing any", () => {
    const roster = buildWorldRoster(
      [view("openai-codex", "unavailable"), view("gemini", "configuration_required")],
      { includeAvailable: true }
    );

    expect(roster.map((entry) => entry.statusLabel)).toEqual(["Unavailable", "Needs setup"]);
  });

  it("keeps catalogue order, so figures do not reshuffle as connectors settle", () => {
    const connectors = [
      view("claude-code", "connecting"),
      view("openai-codex", "connected"),
      view("gemini", "disconnected"),
    ];

    expect(buildWorldRoster(connectors, { includeAvailable: true }).map((e) => e.provider)).toEqual([
      "claude-code",
      "openai-codex",
      "gemini",
    ]);
  });

  it("is empty for an empty catalogue rather than inventing a default agent", () => {
    expect(buildWorldRoster([], { includeAvailable: true })).toEqual([]);
  });
});
