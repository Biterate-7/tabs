import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { namespacedKey, scopedKey, setStorageNamespace } from "@/lib/storage/namespace";
import {
  AGENT_WORLD_STORAGE_KEY,
  defaultAgentWorldState,
  loadAgentWorldState,
  saveAgentWorldState,
} from "./persistence";
import {
  DEFAULT_AGENT_WORLD_SETTINGS,
  MAX_AGENT_SCALE,
  MIN_AGENT_SCALE,
  WORLD_EFFECT_KEYS,
  clampAgentScale,
  normalizeWorldName,
  settingsForWorkspace,
  setWorkspaceOverride,
  worldNameForWorkspace,
} from "./settings";
import type { AgentWorldSettings } from "./settings";

beforeEach(() => {
  window.localStorage.clear();
  setStorageNamespace(null);
});

afterEach(() => {
  setStorageNamespace(null);
  window.localStorage.clear();
});

function write(raw: unknown): void {
  window.localStorage.setItem(scopedKey(AGENT_WORLD_STORAGE_KEY), JSON.stringify(raw));
}

describe("round-tripping settings", () => {
  it("reads back everything it wrote", () => {
    const settings: AgentWorldSettings = {
      ...DEFAULT_AGENT_WORLD_SETTINGS,
      enabled: false,
      themeId: "command-center",
      density: "detailed",
      animation: "subtle",
      agentStyle: "pixel",
      camera: "follow-active",
      agentScale: 1.2,
      showIdleAgents: false,
      showCompleted: false,
      autoArrange: false,
      effects: { ...DEFAULT_AGENT_WORLD_SETTINGS.effects, particles: false, scenery: false },
      byWorkspace: { wA: { themeId: "studio", name: "Research" } },
    };

    expect(saveAgentWorldState({ version: 1, settings })).toBe(true);
    expect(loadAgentWorldState().settings).toEqual(settings);
  });

  it("starts at the defaults with nothing stored", () => {
    expect(loadAgentWorldState()).toEqual(defaultAgentWorldState());
  });
});

describe("tolerating whatever is there", () => {
  it("never throws on unparseable state", () => {
    window.localStorage.setItem(scopedKey(AGENT_WORLD_STORAGE_KEY), "{not json");
    expect(loadAgentWorldState()).toEqual(defaultAgentWorldState());
  });

  it("falls back wholesale on a version it does not know", () => {
    write({ version: 99, settings: { themeId: "studio" } });
    expect(loadAgentWorldState().settings.themeId).toBe(DEFAULT_AGENT_WORLD_SETTINGS.themeId);
  });

  it("costs one preference, not all of them, when one value is bad", () => {
    // The opposite of the connector layer's fail-closed rule, and
    // deliberately so: nothing here can act on the user, so the failure mode
    // that serves them is the one that keeps the feature working.
    write({
      version: 1,
      settings: { themeId: "not-a-theme", density: "detailed", agentStyle: 42 },
    });

    const { settings } = loadAgentWorldState();
    expect(settings.themeId).toBe(DEFAULT_AGENT_WORLD_SETTINGS.themeId);
    expect(settings.agentStyle).toBe(DEFAULT_AGENT_WORLD_SETTINGS.agentStyle);
    // The one good value survives.
    expect(settings.density).toBe("detailed");
  });

  it("restores a missing effect switch to on rather than off", () => {
    // A half-written record should degrade to the shipped experience, not to
    // an inert world that looks broken with no clue why.
    write({ version: 1, settings: { effects: { particles: false } } });

    const { effects } = loadAgentWorldState().settings;
    expect(effects.particles).toBe(false);
    for (const key of WORLD_EFFECT_KEYS) {
      if (key !== "particles") expect(effects[key]).toBe(true);
    }
  });

  it("clamps a stored scale that is out of range", () => {
    write({ version: 1, settings: { agentScale: 99 } });
    expect(loadAgentWorldState().settings.agentScale).toBe(MAX_AGENT_SCALE);

    write({ version: 1, settings: { agentScale: -4 } });
    expect(loadAgentWorldState().settings.agentScale).toBe(MIN_AGENT_SCALE);

    write({ version: 1, settings: { agentScale: Number.NaN } });
    expect(loadAgentWorldState().settings.agentScale).toBe(DEFAULT_AGENT_WORLD_SETTINGS.agentScale);
  });

  it("drops a per-workspace entry that carries nothing usable", () => {
    write({
      version: 1,
      settings: {
        byWorkspace: {
          wA: {},
          wB: { themeId: "retired-theme" },
          wC: { name: "   " },
          wD: { themeId: "city" },
        },
      },
    });

    expect(loadAgentWorldState().settings.byWorkspace).toEqual({ wD: { themeId: "city" } });
  });
});

describe("writing only what it names", () => {
  it("does not write a field a caller attached by accident", () => {
    // The same discipline connectors/persistence.ts applies: the serialiser
    // writes the fields it names and nothing else, so a property added by a
    // later change cannot reach storage by accident.
    const settings = {
      ...DEFAULT_AGENT_WORLD_SETTINGS,
      secretToken: "should-never-be-written",
    } as AgentWorldSettings & { secretToken: string };

    saveAgentWorldState({ version: 1, settings });

    const raw = window.localStorage.getItem(scopedKey(AGENT_WORLD_STORAGE_KEY))!;
    expect(raw).not.toContain("secretToken");
    expect(raw).not.toContain("should-never-be-written");
  });

  it("clamps on the way out as well as on the way in", () => {
    saveAgentWorldState({
      version: 1,
      settings: { ...DEFAULT_AGENT_WORLD_SETTINGS, agentScale: 99 },
    });
    expect(loadAgentWorldState().settings.agentScale).toBe(MAX_AGENT_SCALE);
  });
});

describe("keeping accounts apart", () => {
  it("does not let one account read another's world", () => {
    setStorageNamespace("user-a");
    saveAgentWorldState({
      version: 1,
      settings: { ...DEFAULT_AGENT_WORLD_SETTINGS, themeId: "studio" },
    });

    setStorageNamespace("user-b");
    expect(loadAgentWorldState().settings.themeId).toBe(DEFAULT_AGENT_WORLD_SETTINGS.themeId);

    setStorageNamespace("user-a");
    expect(loadAgentWorldState().settings.themeId).toBe("studio");
  });

  it("writes under the namespaced key", () => {
    setStorageNamespace("user-a");
    saveAgentWorldState(defaultAgentWorldState());
    expect(
      window.localStorage.getItem(namespacedKey(AGENT_WORLD_STORAGE_KEY, "user-a"))
    ).not.toBeNull();
    expect(window.localStorage.getItem(AGENT_WORLD_STORAGE_KEY)).toBeNull();
  });
});

describe("per-workspace worlds", () => {
  const base = DEFAULT_AGENT_WORLD_SETTINGS;

  it("uses the global theme for a workspace that has not been customised", () => {
    expect(settingsForWorkspace(base, "wA").themeId).toBe(base.themeId);
  });

  it("applies a workspace's own theme", () => {
    const withOverride = setWorkspaceOverride(base, "wA", { themeId: "studio" });
    expect(settingsForWorkspace(withOverride, "wA").themeId).toBe("studio");
    expect(settingsForWorkspace(withOverride, "wB").themeId).toBe(base.themeId);
  });

  it("names a workspace's world, and falls back when it has no name", () => {
    const named = setWorkspaceOverride(base, "wA", { name: "Research" });
    expect(worldNameForWorkspace(named, "wA")).toBe("Research");
    expect(worldNameForWorkspace(named, "wB")).toBeNull();
    expect(worldNameForWorkspace(base, "wA")).toBeNull();
  });

  it("removes an entry that has been cleared rather than leaving an empty one behind", () => {
    const named = setWorkspaceOverride(base, "wA", { name: "Research" });
    const cleared = setWorkspaceOverride(named, "wA", { name: "" });
    expect(cleared.byWorkspace).toEqual({});
  });

  it("leaves settings untouched when clearing something that was never set", () => {
    expect(setWorkspaceOverride(base, "wA", { name: "" })).toBe(base);
  });

  it("returns the same object when there is nothing to resolve", () => {
    expect(settingsForWorkspace(base, null)).toBe(base);
    expect(settingsForWorkspace(base, "")).toBe(base);
  });
});

describe("bounding what a user can type", () => {
  it("collapses, trims and truncates a world name", () => {
    expect(normalizeWorldName("  Research   Lab \n ")).toBe("Research Lab");
    expect(normalizeWorldName("x".repeat(200))).toHaveLength(40);
  });

  it("clamps a scale into the readable range", () => {
    expect(clampAgentScale(0)).toBe(MIN_AGENT_SCALE);
    expect(clampAgentScale(5)).toBe(MAX_AGENT_SCALE);
    expect(clampAgentScale(1)).toBe(1);
  });
});
