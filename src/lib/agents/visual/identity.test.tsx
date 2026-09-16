import { afterEach, describe, expect, it } from "vitest";
import { render, screen } from "@testing-library/react";
import { AGENT_PROVIDER_IDS } from "@/lib/agents/connectors/types";
import { defaultAgentVisualCatalog } from "./catalog";
import {
  agentVisualIdentity,
  allAgentVisualIdentities,
  resetAgentVisualIdentitySeeding,
} from "./app-identities";
import {
  FALLBACK_VISUAL_IDENTITY,
  clearAgentVisualIdentities,
  getAgentVisualIdentity,
  hasAgentVisualIdentity,
  listAgentVisualIdentities,
  registerAgentVisualIdentity,
} from "./registry";
import { AGENT_ICON_PIXELS } from "./types";
import type { AgentVisualIdentity } from "./types";

afterEach(() => {
  clearAgentVisualIdentities();
  resetAgentVisualIdentitySeeding();
});

describe("the shipped catalogue", () => {
  it("covers every provider the connector layer ships", () => {
    // The property that keeps a newly registered provider from rendering as a
    // blank: adding one to the connector catalogue without a visual identity
    // fails here rather than in the UI.
    const identities = allAgentVisualIdentities().map((identity) => identity.id);
    for (const provider of AGENT_PROVIDER_IDS) {
      expect(identities).toContain(provider);
    }
  });

  it("gives every provider a distinct mark and accent", () => {
    const catalog = defaultAgentVisualCatalog();
    const marks = new Set(catalog.map((identity) => identity.icon));
    expect(marks.size).toBe(catalog.length);

    // Custom deliberately has no accent of its own — it belongs to whoever
    // brought the agent — so it is excluded from the distinctness check.
    const accents = catalog
      .filter((identity) => identity.id !== "custom")
      .map((identity) => identity.accentColor);
    expect(new Set(accents).size).toBe(accents.length);
  });

  it("takes every display name from the connector descriptor rather than restating it", async () => {
    const { CLAUDE_CODE_DESCRIPTOR, GEMINI_DESCRIPTOR } = await import(
      "@/lib/agents/connectors/catalog"
    );
    expect(agentVisualIdentity("claude-code").displayName).toBe(
      CLAUDE_CODE_DESCRIPTOR.displayName
    );
    expect(agentVisualIdentity("gemini").displayName).toBe(GEMINI_DESCRIPTOR.displayName);
  });

  it("gives every identity a character the world can draw", () => {
    for (const identity of defaultAgentVisualCatalog()) {
      expect(identity.character).toBeDefined();
      expect(identity.character!.scale).toBeGreaterThanOrEqual(0.8);
      expect(identity.character!.scale).toBeLessThanOrEqual(1.2);
    }
  });

  it("seeds once, however many times it is asked", () => {
    const first = allAgentVisualIdentities().length;
    allAgentVisualIdentities();
    expect(allAgentVisualIdentities().length).toBe(first);
  });
});

describe("looking an identity up", () => {
  it("falls back for a provider this build has never heard of", () => {
    // A local-first app's state outlives its builds. Throwing here would take
    // down the panel that was rendering a piece of the user's real history.
    const identity = agentVisualIdentity("some-future-agent");
    expect(identity.icon).toBe(FALLBACK_VISUAL_IDENTITY.icon);
  });

  it("keeps an unknown provider identifiable rather than calling everything 'Agent'", () => {
    expect(agentVisualIdentity("some-future-agent").displayName).toBe("some-future-agent");
    expect(agentVisualIdentity("another-one").displayName).toBe("another-one");
  });

  it("falls back for undefined, null and empty ids", () => {
    for (const value of [undefined, null, ""]) {
      expect(agentVisualIdentity(value).icon).toBe(FALLBACK_VISUAL_IDENTITY.icon);
    }
  });

  it("still returns a usable identity from a completely empty registry", () => {
    // §31: a missing visual identity degrades to a static icon, and the agent
    // functionality is unaffected.
    clearAgentVisualIdentities();
    const identity = getAgentVisualIdentity("claude-code");
    expect(identity.icon).toBe(FALLBACK_VISUAL_IDENTITY.icon);
    expect(identity.character).toBeDefined();
  });
});

describe("registering an identity", () => {
  const custom: AgentVisualIdentity = {
    id: "custom",
    displayName: "House agent",
    icon: () => <svg data-testid="house-mark" />,
    accentColor: "#123456",
  };

  it("makes it available under its id", () => {
    registerAgentVisualIdentity(custom);
    expect(hasAgentVisualIdentity("custom")).toBe(true);
    expect(getAgentVisualIdentity("custom").displayName).toBe("House agent");
  });

  it("replaces rather than duplicating", () => {
    registerAgentVisualIdentity(custom);
    registerAgentVisualIdentity({ ...custom, displayName: "Renamed" });
    const matches = listAgentVisualIdentities().filter((identity) => identity.id === "custom");
    expect(matches).toHaveLength(1);
    expect(matches[0].displayName).toBe("Renamed");
  });

  it("survives seeding, whichever order it happens in", () => {
    // Seeding is lazy, so an override registered before anything has asked
    // for an identity has to survive the seed that follows it. Otherwise a
    // host's custom mark would work or not depending on render order.
    registerAgentVisualIdentity({ ...custom, displayName: "Registered first" });
    expect(agentVisualIdentity("custom").displayName).toBe("Registered first");

    registerAgentVisualIdentity({ ...custom, displayName: "Registered after" });
    expect(agentVisualIdentity("custom").displayName).toBe("Registered after");
  });
});

describe("the marks themselves", () => {
  it("draws every provider at every size", () => {
    for (const identity of defaultAgentVisualCatalog()) {
      for (const [, pixels] of Object.entries(AGENT_ICON_PIXELS)) {
        const Mark = identity.icon;
        const { container, unmount } = render(<Mark size={pixels} />);
        const svg = container.querySelector("svg");
        expect(svg).not.toBeNull();
        expect(svg!.getAttribute("width")).toBe(String(pixels));
        // A shared 24-unit grid is what makes the sizes interchangeable.
        expect(svg!.getAttribute("viewBox")).toBe("0 0 24 24");
        unmount();
      }
    }
  });

  it("is decorative without a title and labelled with one", () => {
    const Mark = defaultAgentVisualCatalog()[0].icon;

    const { container, unmount } = render(<Mark size={16} />);
    expect(container.querySelector("svg")?.getAttribute("aria-hidden")).toBe("true");
    unmount();

    render(<Mark size={16} title="Claude Code" />);
    expect(screen.getByRole("img", { name: "Claude Code" })).toBeTruthy();
  });

  it("inherits its colour rather than hard-coding one", () => {
    // What lets a failing agent be drawn in the error tone whatever its brand
    // colour is.
    for (const identity of defaultAgentVisualCatalog()) {
      const Mark = identity.icon;
      const { container, unmount } = render(<Mark size={24} />);
      expect(container.querySelector("svg")?.getAttribute("stroke")).toBe("currentColor");
      unmount();
    }
  });

  it("keeps strokes thick enough to survive being drawn at 14px", () => {
    for (const identity of defaultAgentVisualCatalog()) {
      const Mark = identity.icon;
      const { container, unmount } = render(<Mark size={14} />);
      const width = Number(container.querySelector("svg")?.getAttribute("stroke-width"));
      expect(width).toBeGreaterThanOrEqual(1.5);
      unmount();
    }
  });

  it("gives each mark one movable element for the animation to drive", () => {
    for (const identity of defaultAgentVisualCatalog()) {
      const Mark = identity.icon;
      const { container, unmount } = render(<Mark size={24} />);
      expect(container.querySelectorAll("[data-agent-orbit]").length).toBeGreaterThan(0);
      unmount();
    }
  });
});
