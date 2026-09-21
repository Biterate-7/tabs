import type { AgentProviderId } from "@/lib/agents/connectors/types";

/**
 * The agent visual identity layer.
 *
 * Phases 11-17 built a model of agent work and a way to say which providers
 * can be observed. What none of them built is a way to say **who is acting**
 * in a form a person recognises at a glance. Every surface that mentions an
 * agent today prints a display name, and three separate files carry their own
 * private table of status glyphs. This layer replaces that with one registry:
 * a provider has a visual identity, and the rest of the application asks for
 * it by id.
 *
 * Two boundaries carry over unchanged from the layers beneath:
 *
 *   - **The generic domain still knows of no provider.** Nothing in
 *     `src/lib/agents/*.ts` imports this directory, and `security.test.ts`
 *     continues to fail the build if it does. This layer sits beside
 *     `connectors/`, not beneath it.
 *   - **Nothing here observes, drives or reaches anything.** It is pure
 *     presentation data: shapes, colours, animation names. No member on any
 *     type below could start a run or send a message, and
 *     `visual/security.test.ts` fails the build if one appears.
 *
 * ## What a visual state is, and is not
 *
 * `AgentVisualState` is the vocabulary an *animation* is chosen by. It is
 * deliberately NOT the same set as `AgentRunStatus`, and collapsing them
 * would be wrong in both directions:
 *
 *   - A run status is a fact about the domain. `blocked` and `failed` are
 *     different facts and stay different facts — see `AGENT_STATUS_VISUALS`
 *     in components/graph/agent-node-renderer.ts, which this phase leaves
 *     exactly as it was.
 *   - A visual state is a question about motion: should this mark move, and
 *     how. `blocked` and `failed` deserve the same answer — hold still, read
 *     as wrong — so they map onto one visual state.
 *
 * The mapping runs one way, from domain fact to visual state, and lives in
 * ./states.ts where every derivation is written beside what it derives from.
 */

/**
 * How an agent reads right now.
 *
 * Nine states, and each one has to be reachable from something the
 * application actually observes — a state no real data could produce would
 * be an animation waiting for a fact that never arrives. ./states.ts names
 * the source of every one of them.
 */
export type AgentVisualState =
  /** Known, not doing anything. The resting state, and the fallback for anything unmapped. */
  | "idle"
  /** Work exists and has not been started. From a work item that is still `pending`. */
  | "queued"
  /** Observation is being established. From a connector in `connecting` or `reconnecting`. */
  | "starting"
  /** Live, and has not said what it is doing. From a `working` run with no named activity or active item. */
  | "thinking"
  /** Live, on a named piece of work. From a `working` run that has one. */
  | "working"
  /** Handing work to, or taking it from, another agent. From an observed handoff — never invented. */
  | "communicating"
  /** Live but not progressing. From a `waiting` run. */
  | "waiting"
  /** Finished well. From a `completed` run, or a completed work item. */
  | "success"
  /** Stopped in a way worth noticing. From a `failed` or `blocked` run, or a connector error. */
  | "error";

export const AGENT_VISUAL_STATES: readonly AgentVisualState[] = [
  "idle",
  "queued",
  "starting",
  "thinking",
  "working",
  "communicating",
  "waiting",
  "success",
  "error",
] as const;

/**
 * There is deliberately no `isAgentVisualState` guard here.
 *
 * Every other closed union in this codebase has one, because every other
 * union crosses a boundary where an untrusted value has to be checked — a
 * stored record, a provider payload, a URL parameter. A visual state crosses
 * none: it is derived in `./states.ts` from values that were already
 * validated, is never persisted, and is never parsed. A guard for it would be
 * a function with nothing to guard.
 */

/**
 * The colour role a state takes.
 *
 * The same five roles the canvas already uses, so a run drawn on the graph
 * and the same run in a list cannot disagree about whether it is going well.
 */
export type AgentVisualTone = "live" | "idle" | "good" | "bad" | "muted";

/**
 * How a state is presented when it is not moving.
 *
 * A glyph **and** a word for every state, because this is the form the
 * information takes when animation is off — which it is for anyone with
 * `prefers-reduced-motion`, anyone who set Settings → Motion → Off, and
 * every screen reader. A state that existed only as an animation would be a
 * state those users could not perceive at all.
 */
export type AgentVisualStatePresentation = {
  /** A mark that is not a colour. Distinct per state. */
  glyph: string;
  /** The state in one word, for a label, a tooltip and an accessible name. */
  label: string;
  tone: AgentVisualTone;
  /**
   * Whether this state reads as in motion.
   *
   * True only for states that describe something ongoing. A finished run
   * that kept pulsing would be claiming to still be working, which is the
   * exact failure the connector layer's health derivation exists to avoid.
   */
  animated: boolean;
  /**
   * One sentence saying what this state means, for a tooltip or a legend.
   *
   * Written to be true of the derivation rather than evocative: `thinking`
   * says the run has not named its work, because that is precisely what
   * produces it.
   */
  description: string;
};

/**
 * The props every provider mark accepts.
 *
 * Narrow on purpose: a mark receives a size and a title and draws itself. It
 * cannot receive state, because a mark that changed shape per state would put
 * the state machine inside five separate drawings instead of in one place —
 * and adding a provider would then mean re-implementing it.
 */
export type AgentMarkProps = {
  /** Rendered pixel size. The mark's own geometry is viewBox-relative. */
  size: number;
  /**
   * Accessible title, or absent for a decorative mark.
   *
   * Absent is the common case: the mark almost always sits beside the name it
   * would otherwise repeat, and a screen reader announcing "Claude Code
   * Claude Code" is worse than one announcing it once.
   */
  title?: string;
  className?: string;
};

export type AgentMarkComponent = (props: AgentMarkProps) => React.ReactElement;

/**
 * Everything the application needs in order to show who is acting.
 *
 * `icon` is a component rather than a data blob because a mark is genuinely a
 * drawing, and a parametric description of one would be a worse drawing.
 * Everything else is data.
 */
export type AgentVisualIdentity = {
  /** The provider this identity belongs to. */
  id: AgentProviderId;
  /** The name shown beside the mark. Mirrors the connector descriptor's. */
  displayName: string;
  /**
   * The provider's mark.
   *
   * Must stay legible at 16px — every one is drawn on a 24-unit grid with
   * strokes no finer than 1.5 units, and `identity.test.ts` asserts the
   * contract rather than the drawing.
   */
  icon: AgentMarkComponent;
  /**
   * A richer mark used at 32px and above, when there is room for it.
   *
   * Optional. An identity without one renders `icon` at every size, which is
   * the graceful degradation §31 asks for rather than a missing asset.
   */
  detailedIcon?: AgentMarkComponent;
  /**
   * The identity's colour, as a CSS colour string.
   *
   * Used for the mark. It is a hint, not a status: a failing agent is drawn
   * in the error tone whatever its accent is, because status must never be
   * overridden by branding.
   */
  accentColor: string;
};

/** Icon sizes, in the vocabulary the components take. */
export type AgentIconSize = "xs" | "sm" | "md" | "lg";

/**
 * Pixel size per step.
 *
 * `xs` is 14 and `sm` is 18 because those are the sizes that actually occur
 * beside `text-meta` and `text-body-sm` in this product; they are not a
 * geometric progression for its own sake.
 */
export const AGENT_ICON_PIXELS: Record<AgentIconSize, number> = {
  xs: 14,
  sm: 18,
  md: 24,
  lg: 32,
};
