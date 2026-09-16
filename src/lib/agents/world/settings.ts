import { DEFAULT_WORLD_THEME_ID } from "./themes";
import { isWorldThemeId } from "./types";
import type { WorldThemeId } from "./types";

/**
 * What the user can change about their world.
 *
 * Every setting here gates something that actually exists. That constraint
 * did real work: the brief's list of effect toggles is longer than the four
 * this file would otherwise have needed, and rather than shipping switches
 * that flip a value nothing reads, each one below was given a specific thing
 * to turn off and the renderer was written to honour it. A preferences panel
 * whose controls do nothing is worse than a smaller one.
 *
 * Nothing here is a secret, a credential or a piece of content, so unlike
 * connector state this can be and is persisted — see ./persistence.ts.
 */

/** How much of the environment is drawn. */
export type WorldDensity = "minimal" | "balanced" | "detailed";

export const WORLD_DENSITIES: readonly WorldDensity[] = ["minimal", "balanced", "detailed"] as const;

/** How agents are drawn. */
export type WorldAgentStyle = "minimal" | "character" | "pixel" | "illustrated" | "futuristic";

export const WORLD_AGENT_STYLES: readonly WorldAgentStyle[] = [
  "minimal",
  "character",
  "pixel",
  "illustrated",
  "futuristic",
] as const;

/**
 * What the view follows.
 *
 * `static` fits the whole world into whatever space it has, which is the
 * right answer on a desktop panel where everything is already visible.
 * The other three exist because the space is not always that big — on a
 * narrow screen, or with twenty agents, framing becomes a real question.
 */
export type WorldCamera = "static" | "follow-active" | "follow-workflow" | "free";

export const WORLD_CAMERAS: readonly WorldCamera[] = [
  "static",
  "follow-active",
  "follow-workflow",
  "free",
] as const;

export type WorldAnimation = "off" | "subtle" | "full";

export const WORLD_ANIMATIONS: readonly WorldAnimation[] = ["off", "subtle", "full"] as const;

/**
 * The effect switches.
 *
 * Six, each naming one thing the renderer will not draw when it is off:
 *
 * | switch | what it turns off |
 * |---|---|
 * | `particles` | the moving element inside each mark, and the packets that travel a handoff line |
 * | `handoffTrails` | the lines between agents that shared work |
 * | `ambientLife` | the environment's own faint movement: lit screens, traffic, beacons |
 * | `completionEffects` | the one-shot flourish when a run finishes |
 * | `statusEffects` | per-state animation on characters in the world |
 * | `scenery` | the rooms and their furniture, leaving the bare floor |
 */
export type WorldEffects = {
  particles: boolean;
  handoffTrails: boolean;
  ambientLife: boolean;
  completionEffects: boolean;
  statusEffects: boolean;
  scenery: boolean;
};

export const DEFAULT_WORLD_EFFECTS: WorldEffects = {
  particles: true,
  handoffTrails: true,
  ambientLife: true,
  completionEffects: true,
  statusEffects: true,
  scenery: true,
};

export const WORLD_EFFECT_KEYS = [
  "particles",
  "handoffTrails",
  "ambientLife",
  "completionEffects",
  "statusEffects",
  "scenery",
] as const satisfies readonly (keyof WorldEffects)[];

export const WORLD_EFFECT_LABELS: Record<keyof WorldEffects, string> = {
  particles: "Data streams",
  handoffTrails: "Communication trails",
  ambientLife: "Ambient effects",
  completionEffects: "Completion effects",
  statusEffects: "Status animation",
  scenery: "Environment detail",
};

/** Bounds on the agent scale slider. Narrow, so no setting can make the world unreadable. */
export const MIN_AGENT_SCALE = 0.7;
export const MAX_AGENT_SCALE = 1.5;

/** Cap on a user-chosen world name. Bounded like every other free-text field in this codebase. */
export const MAX_WORLD_NAME_LENGTH = 40;

/**
 * One workspace's overrides.
 *
 * Only the two settings a workspace plausibly wants of its own: a research
 * workspace in the lab theme and a writing one in the studio is the case §14
 * describes. Everything else — density, motion, camera — is about the person
 * and their machine, and duplicating it per workspace would mean changing a
 * motion preference in six places.
 */
export type WorldWorkspaceOverride = {
  themeId?: WorldThemeId;
  /** What this workspace's world is called. Falls back to the workspace's own name. */
  name?: string;
};

export type AgentWorldSettings = {
  /**
   * Whether the world is available at all.
   *
   * Off means the entry point is not offered and nothing is rendered. The
   * product must remain completely usable in this state (§20), which is why
   * this is a top-level switch rather than an animation level of zero.
   */
  enabled: boolean;
  themeId: WorldThemeId;
  density: WorldDensity;
  animation: WorldAnimation;
  agentStyle: WorldAgentStyle;
  camera: WorldCamera;
  effects: WorldEffects;
  /** 0.7-1.5. Clamped on write, so no stored value can put it out of range. */
  agentScale: number;
  /** Keep agents visible when they have nothing to do. */
  showIdleAgents: boolean;
  /** Keep finished runs in the world rather than letting them leave. */
  showCompleted: boolean;
  /**
   * Whether a character relocates when its run's state changes.
   *
   * On by default: an agent walking from its desk to the meeting room is how
   * the world says work moved. Off pins each character to the station it
   * first occupied, for someone who wants the arrangement to hold still — the
   * state animation still changes, so nothing is lost but the movement.
   */
  autoArrange: boolean;
  /** Per-workspace theme and name. Absent for a workspace that has not been customised. */
  byWorkspace: Record<string, WorldWorkspaceOverride>;
};

export const DEFAULT_AGENT_WORLD_SETTINGS: AgentWorldSettings = {
  // On by default. The world is the point of the phase, and a feature that
  // ships switched off is a feature nobody discovers — but every part of it
  // degrades to the existing, unchanged UI when it is turned off.
  enabled: true,
  themeId: DEFAULT_WORLD_THEME_ID,
  density: "balanced",
  animation: "full",
  agentStyle: "character",
  camera: "static",
  effects: DEFAULT_WORLD_EFFECTS,
  agentScale: 1,
  showIdleAgents: true,
  showCompleted: true,
  autoArrange: true,
  byWorkspace: {},
};

export function clampAgentScale(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_AGENT_WORLD_SETTINGS.agentScale;
  return Math.min(MAX_AGENT_SCALE, Math.max(MIN_AGENT_SCALE, value));
}

/** Collapsed, trimmed and bounded, like every other authored string in this codebase. */
export function normalizeWorldName(value: string): string {
  const collapsed = value.replace(/\s+/g, " ").trim();
  return collapsed.length > MAX_WORLD_NAME_LENGTH
    ? collapsed.slice(0, MAX_WORLD_NAME_LENGTH)
    : collapsed;
}

/**
 * The settings that apply in one workspace.
 *
 * Resolution is a single shallow merge, and only the two overridable fields
 * participate. Returning a full `AgentWorldSettings` rather than a base plus
 * an override means every consumer reads one object and none of them has to
 * remember which fields could have been overridden.
 */
export function settingsForWorkspace(
  settings: AgentWorldSettings,
  workspaceId: string | null | undefined
): AgentWorldSettings {
  if (!workspaceId) return settings;
  const override = settings.byWorkspace[workspaceId];
  if (!override?.themeId) return settings;
  return { ...settings, themeId: override.themeId };
}

/** What this workspace's world is called, or null to fall back to the workspace's own name. */
export function worldNameForWorkspace(
  settings: AgentWorldSettings,
  workspaceId: string | null | undefined
): string | null {
  if (!workspaceId) return null;
  const name = settings.byWorkspace[workspaceId]?.name;
  return name && name.trim() ? name : null;
}

/**
 * Records a per-workspace override.
 *
 * Pure. Clearing both fields removes the entry entirely rather than leaving
 * an empty object behind, so a workspace that was customised and then reset
 * stops taking up space in storage.
 */
export function setWorkspaceOverride(
  settings: AgentWorldSettings,
  workspaceId: string,
  patch: WorldWorkspaceOverride
): AgentWorldSettings {
  const current = settings.byWorkspace[workspaceId] ?? {};
  const next: WorldWorkspaceOverride = { ...current, ...patch };

  if (next.themeId === undefined && (next.name === undefined || next.name === "")) {
    if (!(workspaceId in settings.byWorkspace)) return settings;
    const byWorkspace = { ...settings.byWorkspace };
    delete byWorkspace[workspaceId];
    return { ...settings, byWorkspace };
  }

  return { ...settings, byWorkspace: { ...settings.byWorkspace, [workspaceId]: next } };
}

/** Whether a value names a density this build ships. */
export function isWorldDensity(value: unknown): value is WorldDensity {
  return typeof value === "string" && (WORLD_DENSITIES as readonly string[]).includes(value);
}

export function isWorldAgentStyle(value: unknown): value is WorldAgentStyle {
  return typeof value === "string" && (WORLD_AGENT_STYLES as readonly string[]).includes(value);
}

export function isWorldCamera(value: unknown): value is WorldCamera {
  return typeof value === "string" && (WORLD_CAMERAS as readonly string[]).includes(value);
}

export function isWorldAnimation(value: unknown): value is WorldAnimation {
  return typeof value === "string" && (WORLD_ANIMATIONS as readonly string[]).includes(value);
}

export { isWorldThemeId };
