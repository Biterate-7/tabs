import type { ConnectorStatusKind } from "@/lib/agents/connectors/types";
import type { AgentRunStatus, AgentWorkItemStatus } from "@/lib/agents/types";
import type { AgentVisualState, AgentVisualStatePresentation, AgentVisualTone } from "./types";

/**
 * Where a visual state comes from.
 *
 * Every function in this file maps a fact the application already observed
 * onto one of the nine visual states. Nothing here invents a state, and
 * nothing here runs a timer: a mark changes because the domain changed, not
 * because time passed. That is the difference between a visualisation of
 * work and a loading spinner wearing a costume.
 *
 * This module is provider-neutral. It maps *statuses*, and a status means the
 * same thing whichever provider reported it — which is what lets the whole
 * visual system be connector-agnostic (brief §23).
 */

/**
 * How each state looks when it is standing still.
 *
 * The glyphs are distinct from one another and, deliberately, mostly distinct
 * from `AGENT_STATUS_VISUALS` in the canvas renderer: a run's *status* and an
 * agent's *visual state* are different vocabularies, and reusing one set of
 * marks for both would suggest they are interchangeable. The two that do
 * coincide — `✓` for success and `◷` for waiting — coincide because they mean
 * the same thing in both vocabularies.
 */
export const AGENT_VISUAL_STATE_PRESENTATION: Record<
  AgentVisualState,
  AgentVisualStatePresentation
> = {
  idle: {
    glyph: "○",
    label: "Idle",
    tone: "muted",
    animated: false,
    description: "Not doing anything right now.",
  },
  queued: {
    glyph: "◌",
    label: "Queued",
    tone: "muted",
    animated: false,
    description: "Work is planned and has not started.",
  },
  starting: {
    glyph: "◍",
    label: "Starting",
    tone: "idle",
    animated: true,
    description: "Connecting, so work can be observed.",
  },
  thinking: {
    glyph: "◑",
    label: "Thinking",
    tone: "live",
    animated: true,
    description: "Running, and has not reported what it is working on.",
  },
  working: {
    glyph: "▶",
    label: "Working",
    tone: "live",
    animated: true,
    description: "Running, on a task it has named.",
  },
  communicating: {
    glyph: "⇄",
    label: "Handing off",
    tone: "live",
    animated: true,
    description: "Sharing work with another agent.",
  },
  waiting: {
    glyph: "◷",
    label: "Waiting",
    tone: "idle",
    animated: false,
    description: "Live, but not making progress.",
  },
  success: {
    glyph: "✓",
    label: "Completed",
    tone: "good",
    animated: false,
    description: "Finished.",
  },
  error: {
    glyph: "▲",
    label: "Needs attention",
    tone: "bad",
    animated: false,
    description: "Stopped in a way worth looking at.",
  },
};

/**
 * What a run looks like.
 *
 * The one derivation worth defending is the `working` / `thinking` split.
 * Both come from a run whose status is `working`; what separates them is
 * whether the run has told us *what* it is doing — `currentActivity` is a
 * sanitised one-liner the provider supplied, and an active work item is a
 * named unit of work. A run with neither is live and silent, and the mark
 * says so.
 *
 * This is a claim about our own observation, not about the model's cognition.
 * We cannot see an agent think, and nothing here pretends we can: `thinking`
 * means "running, has not said what it is working on", which is what its
 * description reads out to a screen reader.
 */
export function visualStateForRun(input: {
  status: AgentRunStatus;
  /** The run's own sanitised activity line, when it reported one. */
  currentActivity?: string;
  /** Whether any of this run's work items is currently `active`. */
  hasNamedWork?: boolean;
  /**
   * Whether this run is part of an observed handoff right now.
   *
   * Supplied by the caller from a real relationship — this module never
   * guesses at one.
   *
   * **No shipped caller supplies it today**, so `communicating` is currently
   * unreachable from a run. Its only supplier was the Agent World's handoff
   * derivation, which went with the world. The parameter is kept rather than
   * removed because a provider adapter can genuinely observe one — a Claude
   * Code session dispatching to a subagent is exactly this — and it must
   * arrive as an observed fact, not as something inferred here from two runs
   * that happen to overlap.
   */
  isHandingOff?: boolean;
}): AgentVisualState {
  const { status, currentActivity, hasNamedWork, isHandingOff } = input;

  switch (status) {
    case "working": {
      // A handoff is the more specific fact, so it wins over plain work —
      // but only while the run is live. A finished run that once handed
      // something over is finished, not communicating.
      if (isHandingOff) return "communicating";
      const named = hasNamedWork === true || Boolean(currentActivity?.trim());
      return named ? "working" : "thinking";
    }
    case "waiting":
      return "waiting";
    case "completed":
      return "success";
    case "failed":
    case "blocked":
      // Two different domain facts, one visual answer: hold still and read as
      // wrong. The *word* stays different everywhere the status itself is
      // shown, so the distinction is never lost — only the animation is
      // shared.
      return "error";
    case "cancelled":
      // Deliberately not `error`. Cancelled work was stopped on purpose and
      // drawing it as a problem would invent one.
      return "idle";
  }
}

/**
 * What a work item looks like on its own.
 *
 * Used where an item is shown without its run — a plan list, a search result.
 * `blocked` maps to `error` here even though a blocked work item is not
 * terminal, because "needs attention" is exactly what it needs; the row's own
 * status word continues to say `Blocked`, which is where the distinction
 * between a blocked item and a blocked run lives.
 */
export function visualStateForWorkItem(status: AgentWorkItemStatus): AgentVisualState {
  switch (status) {
    case "pending":
      return "queued";
    case "active":
      return "working";
    case "blocked":
      return "error";
    case "completed":
      return "success";
    case "cancelled":
      return "idle";
  }
}

/**
 * What a connector looks like.
 *
 * Note what is absent: there is no visual state for "connected". A connector
 * that is connected and has observed nothing is **idle**, exactly as
 * `connectors/health.ts` reports it — rendering it as working would be the
 * app implying activity that has not happened. A connected connector shows
 * the state of its *runs*; the connector itself is simply on.
 *
 * `unavailable`, `disconnected` and `configuration_required` all read as
 * `idle` here on purpose. They are three different things to *say*, and the
 * connector layer keeps three different words for them — but none of them is
 * a state a mark should be animating, and inventing three still poses would
 * be motion carrying no information.
 */
export function visualStateForConnector(kind: ConnectorStatusKind): AgentVisualState {
  switch (kind) {
    case "connecting":
    case "reconnecting":
      return "starting";
    case "error":
      return "error";
    case "connected":
    case "disconnected":
    case "configuration_required":
    case "unavailable":
      return "idle";
  }
}

/**
 * How each connection state is marked.
 *
 * Kept as its own table rather than folded into `visualStateForConnector`,
 * and the reason is worth being explicit about, because "remove the duplicated
 * status tables" was a goal of this phase and this is the one that survived.
 *
 * Connection state and visual state answer different questions. The mapping
 * above is about **motion** — should this mark move — and correctly collapses
 * seven connection states into three, because `connected` and `disconnected`
 * both mean "hold still". But a settings page has to tell them apart, and
 * `unavailable`, `disconnected` and `configuration_required` ask three
 * different things of the user (nothing, connect it, configure it). Collapsing
 * their *glyphs* would send someone hunting for a setting that does not exist,
 * which is the failure `CONNECTOR_STATUS_LABELS` already exists to prevent.
 *
 * What is centralised here is the part that genuinely was duplicated: the
 * tone, which every surface was resolving to a Tailwind class of its own. The
 * glyph stays per-connection-state because it carries information nothing
 * else does.
 */
export const CONNECTOR_STATUS_VISUALS: Record<
  ConnectorStatusKind,
  { glyph: string; tone: AgentVisualTone }
> = {
  connected: { glyph: "●", tone: "live" },
  connecting: { glyph: "◐", tone: "idle" },
  reconnecting: { glyph: "◐", tone: "idle" },
  disconnected: { glyph: "○", tone: "muted" },
  configuration_required: { glyph: "◌", tone: "idle" },
  unavailable: { glyph: "○", tone: "muted" },
  error: { glyph: "▲", tone: "bad" },
};

/**
 * Note on what is deliberately absent.
 *
 * An earlier draft had a `mostSignificantVisualState` here, to reduce an
 * agent's several runs to one mark. It was removed rather than kept: the
 * spatial scene already computes exactly that (`AgentSpatialNode.status`,
 * "worst-attention status among its visible runs"), and a second ordering of
 * the same question is a second answer waiting to disagree with the first.
 *
 * `AGENT_VISUAL_STATE_PRESENTATION[state].animated` is likewise the only
 * "is this live?" there is, read directly rather than through a wrapper.
 */
