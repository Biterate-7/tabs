import { scopedKey } from "@/lib/storage/namespace";
import {
  DEFAULT_AGENT_WORLD_SETTINGS,
  DEFAULT_WORLD_EFFECTS,
  WORLD_EFFECT_KEYS,
  clampAgentScale,
  isWorldAgentStyle,
  isWorldAnimation,
  isWorldCamera,
  isWorldDensity,
  isWorldThemeId,
  normalizeWorldName,
} from "./settings";
import type {
  AgentWorldSettings,
  WorldEffects,
  WorldWorkspaceOverride,
} from "./settings";

/**
 * Where the Agent World's preferences live.
 *
 * Its own key rather than a corner of `tabdump:settings:v1`, and the reason
 * is the same one that gave connectors their own: `tabdump:settings:v1` is
 * device-global by design — it holds the theme, the fonts and the intro
 * preference, and is deliberately *not* partitioned per account so that
 * signing in does not lose someone their theme. World settings are about a
 * person's workspaces, including a map keyed by workspace id, so they belong
 * on the other side of that line.
 *
 * The key is therefore registered in `SCOPED_STORAGE_KEYS`: one account's
 * world configuration is invisible to another signed into the same browser,
 * exactly as their workspaces and agent history already are.
 *
 * ## What is not here
 *
 * No run, no agent, no activity and no content — only preferences. The world
 * is derived entirely from `tabdump:agents:v1` at render time, so nothing in
 * this file needs to be migrated, reconciled or invalidated when agent state
 * changes, and deleting this key costs the user their theme choice and
 * nothing else.
 */

const STORAGE_KEY = "tabdump:agent-world:v1";

export const AGENT_WORLD_STATE_VERSION = 1;

export type AgentWorldState = {
  version: typeof AGENT_WORLD_STATE_VERSION;
  settings: AgentWorldSettings;
};

export function defaultAgentWorldState(): AgentWorldState {
  return { version: AGENT_WORLD_STATE_VERSION, settings: DEFAULT_AGENT_WORLD_SETTINGS };
}

function readBoolean(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/**
 * Reads the effect switches.
 *
 * Any switch missing or malformed falls back to its default rather than
 * disabling the effect. That direction matters: a half-written record should
 * degrade to the shipped experience, not to an inert world that looks broken
 * and gives the user no clue why.
 */
function readEffects(value: unknown): WorldEffects {
  if (!value || typeof value !== "object") return DEFAULT_WORLD_EFFECTS;
  const record = value as Record<string, unknown>;

  const effects = { ...DEFAULT_WORLD_EFFECTS };
  for (const key of WORLD_EFFECT_KEYS) {
    effects[key] = readBoolean(record[key], DEFAULT_WORLD_EFFECTS[key]);
  }
  return effects;
}

/**
 * Reads the per-workspace overrides.
 *
 * An entry is kept only when it carries something usable. A workspace id
 * pointing at an empty object, or at a theme this build does not ship, is
 * dropped — so a stale record shrinks rather than accumulating keys no UI
 * can reach.
 */
function readByWorkspace(value: unknown): Record<string, WorldWorkspaceOverride> {
  if (!value || typeof value !== "object") return {};
  const record = value as Record<string, unknown>;
  const out: Record<string, WorldWorkspaceOverride> = {};

  for (const [workspaceId, raw] of Object.entries(record)) {
    if (!workspaceId || !raw || typeof raw !== "object") continue;
    const { themeId, name } = raw as Record<string, unknown>;

    const override: WorldWorkspaceOverride = {};
    if (isWorldThemeId(themeId)) override.themeId = themeId;
    if (typeof name === "string") {
      const normalized = normalizeWorldName(name);
      if (normalized) override.name = normalized;
    }

    if (override.themeId !== undefined || override.name !== undefined) {
      out[workspaceId] = override;
    }
  }

  return out;
}

/**
 * Reads stored settings, tolerating anything.
 *
 * Never throws. Every field is validated independently and falls back on its
 * own, so one bad value costs one preference rather than all of them — which
 * is the opposite of the connector layer's fail-closed rule, and deliberately
 * so. Connector state decides whether the app observes someone's machine, and
 * corrupt state there must mean "off". Nothing here can do anything to the
 * user: the worst outcome of a wrong value is an unexpected theme, so the
 * failure mode that serves them is the one that keeps the feature working.
 */
export function loadAgentWorldState(): AgentWorldState {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return defaultAgentWorldState();

    const parsed: unknown = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultAgentWorldState();

    const record = parsed as Record<string, unknown>;
    if (record.version !== AGENT_WORLD_STATE_VERSION) return defaultAgentWorldState();

    const stored = (record.settings ?? {}) as Record<string, unknown>;
    const defaults = DEFAULT_AGENT_WORLD_SETTINGS;

    return {
      version: AGENT_WORLD_STATE_VERSION,
      settings: {
        enabled: readBoolean(stored.enabled, defaults.enabled),
        themeId: isWorldThemeId(stored.themeId) ? stored.themeId : defaults.themeId,
        density: isWorldDensity(stored.density) ? stored.density : defaults.density,
        animation: isWorldAnimation(stored.animation) ? stored.animation : defaults.animation,
        agentStyle: isWorldAgentStyle(stored.agentStyle) ? stored.agentStyle : defaults.agentStyle,
        camera: isWorldCamera(stored.camera) ? stored.camera : defaults.camera,
        effects: readEffects(stored.effects),
        agentScale:
          typeof stored.agentScale === "number"
            ? clampAgentScale(stored.agentScale)
            : defaults.agentScale,
        showIdleAgents: readBoolean(stored.showIdleAgents, defaults.showIdleAgents),
        showCompleted: readBoolean(stored.showCompleted, defaults.showCompleted),
        autoArrange: readBoolean(stored.autoArrange, defaults.autoArrange),
        byWorkspace: readByWorkspace(stored.byWorkspace),
      },
    };
  } catch {
    return defaultAgentWorldState();
  }
}

/**
 * Writes settings back.
 *
 * Serialised field by field rather than by stringifying what it was handed —
 * the same discipline `connectors/persistence.ts` applies, for the same
 * reason: a caller that one day passes an object carrying an extra property
 * cannot write that property, because this function only ever writes the
 * fields it names.
 */
export function saveAgentWorldState(state: AgentWorldState): boolean {
  try {
    const { settings } = state;
    const effects = {} as WorldEffects;
    for (const key of WORLD_EFFECT_KEYS) effects[key] = settings.effects[key];

    const byWorkspace: Record<string, WorldWorkspaceOverride> = {};
    for (const [workspaceId, override] of Object.entries(settings.byWorkspace)) {
      const entry: WorldWorkspaceOverride = {};
      if (override.themeId !== undefined) entry.themeId = override.themeId;
      if (override.name !== undefined) entry.name = override.name;
      if (entry.themeId !== undefined || entry.name !== undefined) byWorkspace[workspaceId] = entry;
    }

    const safe: AgentWorldState = {
      version: AGENT_WORLD_STATE_VERSION,
      settings: {
        enabled: settings.enabled,
        themeId: settings.themeId,
        density: settings.density,
        animation: settings.animation,
        agentStyle: settings.agentStyle,
        camera: settings.camera,
        effects,
        agentScale: clampAgentScale(settings.agentScale),
        showIdleAgents: settings.showIdleAgents,
        showCompleted: settings.showCompleted,
        autoArrange: settings.autoArrange,
        byWorkspace,
      },
    };

    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(safe));
    return true;
  } catch {
    // Quota, or storage disabled mid-session. Reported rather than thrown:
    // failing to remember a preference must not take down the surface the
    // user was using when they set it.
    return false;
  }
}

export const AGENT_WORLD_STORAGE_KEY = STORAGE_KEY;
