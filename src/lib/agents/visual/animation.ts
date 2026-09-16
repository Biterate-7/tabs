import { AGENT_VISUAL_STATE_PRESENTATION } from "./states";
import type { AgentAnimationConfig, AgentVisualIdentity, AgentVisualState } from "./types";

/**
 * The animation engine, such as it is.
 *
 * "Engine" overstates it on purpose: the whole of it is a lookup and a style
 * object. Every agent animation in this product is a CSS keyframe declared
 * once in globals.css under the `agent-` prefix, and this module's job is to
 * decide **which one, how fast, and whether at all**.
 *
 * That choice of mechanism is the single most consequential performance
 * decision in Phase 18, and it is worth stating plainly. A visual system
 * driven by JavaScript would need one `requestAnimationFrame` loop per moving
 * mark, each waking the main thread sixty times a second, each holding a
 * closure over React state, each needing to be cancelled on unmount. Twenty
 * agents would mean twenty of them. CSS animations on `transform` and
 * `opacity` are composited off the main thread, cost the same whether there
 * is one or fifty, stop when the element unmounts, and cannot leak a timer
 * because there is no timer. The brief asks for twenty simultaneous agents to
 * stay smooth; this is how that is achieved rather than optimised for later.
 *
 * It also means the app's existing motion controls work on the agent system
 * for free: `[data-motion="off"]` and the `prefers-reduced-motion` block in
 * globals.css already flatten every CSS animation in the document, so an
 * agent mark cannot keep moving after a user has asked the product to stop
 * moving — even if this module had a bug.
 */

/**
 * How much motion is allowed right now.
 *
 * Three levels, resolved from three inputs that can each independently say
 * "less". The resolution is a floor, never a negotiation: any input asking
 * for less wins, because every one of them is a person (or their OS) saying
 * so.
 */
export type AgentMotionPolicy = "none" | "subtle" | "full";

/**
 * The app-wide motion level, as Settings → Appearance → Motion records it.
 *
 * Declared structurally rather than imported from the appearance types so
 * this module — and everything in the visual layer — stays independent of the
 * theming system. The one caller that has a real `MotionLevel` passes it and
 * TypeScript checks the overlap.
 */
export type AppMotionLevel = "off" | "reduced" | "normal" | "expressive";

/** What the user chose for the world specifically. */
export type WorldAnimationIntensity = "off" | "subtle" | "full";

export function resolveAgentMotion(input: {
  /** The OS preference. Beats everything. */
  prefersReducedMotion: boolean;
  /** Settings → Appearance → Motion. Absent when appearance has not hydrated. */
  appLevel?: AppMotionLevel;
  /** The Agent World's own intensity control. Absent means "full", the default. */
  worldIntensity?: WorldAnimationIntensity;
}): AgentMotionPolicy {
  const { prefersReducedMotion, appLevel, worldIntensity } = input;

  // The OS preference is not a suggestion and is not overridable from inside
  // the product. Someone who set it did so once, for every application.
  if (prefersReducedMotion) return "none";
  if (appLevel === "off") return "none";
  if (worldIntensity === "off") return "none";

  // "Reduced" is the app saying "some, not much" — so a world set to full
  // still only gets subtle. The narrower of the two always applies.
  if (appLevel === "reduced") return "subtle";
  if (worldIntensity === "subtle") return "subtle";

  return "full";
}

/**
 * The animation each state gets when an identity has not specified its own.
 *
 * `null` means "this state does not move", and it is the answer for every
 * settled state. Motion on this surface always means something is happening;
 * a completed run that kept pulsing would be claiming otherwise.
 *
 * Durations are slow. The fastest loop here is 1.6s, which is roughly the
 * threshold below which a repeating animation starts to read as urgent rather
 * than alive — and this system sits in a sidebar someone is meant to be able
 * to leave open while they work.
 */
export const DEFAULT_STATE_ANIMATIONS: Record<AgentVisualState, AgentAnimationConfig | null> = {
  idle: { keyframes: "agent-breathe", durationMs: 5200, iterations: "infinite" },
  queued: null,
  starting: { keyframes: "agent-pulse", durationMs: 1800, iterations: "infinite" },
  thinking: { keyframes: "agent-think", durationMs: 2600, iterations: "infinite" },
  working: { keyframes: "agent-work", durationMs: 1600, iterations: "infinite" },
  communicating: { keyframes: "agent-signal", durationMs: 2000, iterations: "infinite" },
  waiting: null,
  // One shot, not a loop. A success that celebrated forever would stop being
  // a celebration and start being noise on a finished run.
  success: { keyframes: "agent-settle", durationMs: 520, iterations: 1 },
  error: { keyframes: "agent-falter", durationMs: 420, iterations: 1 },
};

/**
 * States that survive the `subtle` policy.
 *
 * At `subtle`, only states that mean "this is happening right now" keep
 * moving. Ambient life is the first thing to go, because it is the motion
 * that carries the least information — a resting agent looks the same
 * whether or not it breathes.
 */
const SUBTLE_STATES: readonly AgentVisualState[] = [
  "working",
  "thinking",
  "communicating",
  "starting",
] as const;

/**
 * The animation to run, or null.
 *
 * Resolution order: the identity's own animation for this state, then the
 * shared default, then nothing. An identity that declares no animations at
 * all therefore still animates correctly — which is what makes adding a
 * provider a matter of metadata rather than of implementing a state machine
 * (brief §23).
 */
export function animationFor(
  identity: Pick<AgentVisualIdentity, "animations"> | undefined,
  state: AgentVisualState,
  policy: AgentMotionPolicy
): AgentAnimationConfig | null {
  if (policy === "none") return null;
  if (policy === "subtle" && !(SUBTLE_STATES as readonly string[]).includes(state)) return null;

  // A state the presentation table says is still never animates, whatever an
  // identity asks for. An identity cannot opt a finished run into looking
  // live; that would let a provider's styling contradict the domain.
  const presentation = AGENT_VISUAL_STATE_PRESENTATION[state];
  const config = identity?.animations?.[state] ?? DEFAULT_STATE_ANIMATIONS[state];
  if (!config) return null;
  if (!presentation.animated && config.iterations === "infinite") return null;

  return config;
}

/**
 * The style object for a mark in a given state.
 *
 * Returns an empty object when nothing should move, rather than an animation
 * with a zero duration: an element with no `animation-name` is one the
 * compositor never considers at all.
 *
 * `--agent-anim-scale` lets a single CSS variable slow every agent animation
 * at once — the world's density control uses it so a crowded scene calms down
 * without each component recalculating its own timing.
 */
export function animationStyle(
  identity: Pick<AgentVisualIdentity, "animations"> | undefined,
  state: AgentVisualState,
  policy: AgentMotionPolicy
): React.CSSProperties {
  const config = animationFor(identity, state, policy);
  if (!config) return {};

  return {
    animationName: config.keyframes,
    animationDuration: `calc(${config.durationMs}ms * var(--agent-anim-scale, 1))`,
    animationIterationCount: config.iterations === "infinite" ? "infinite" : config.iterations,
    animationTimingFunction: config.easing ?? "var(--ease-standard)",
    animationFillMode: "both",
  };
}
