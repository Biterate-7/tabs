import { truncateToWidth } from "@/lib/graph/canvas-text";
import type { DrawContext } from "./node-renderer";
import type { AgentEdgeKind } from "@/lib/agents/spatial/types";
import type { AgentRunStatus } from "@/lib/agents/types";

/**
 * Drawing the agent layer.
 *
 * Deliberately separate from node-renderer.ts: a tab is a circle with a
 * favicon, and an agent run is a labelled card with a status and two counts.
 * Forcing both through one function would mean a `kind` switch inside every
 * branch of it.
 *
 * Like its neighbour, this module is pure drawing — it takes screen-space
 * coordinates and knows nothing about cameras, zoom, domain state or React,
 * which is what lets it be tested against a plain recording fake instead of a
 * real canvas (jsdom has no canvas backend).
 *
 * It is also provider-neutral. Nothing here knows what Claude Code is; a node
 * carries a provider string only so the card can print it.
 */

/**
 * Status presentation.
 *
 * Every status carries a **glyph and a label** as well as a colour, because
 * colour alone is not an accessible way to say "this failed" — and on a canvas
 * there is no text alternative underneath to fall back on.
 */
export type StatusVisual = {
  glyph: string;
  label: string;
  /** Token name, resolved by the caller against the live palette. */
  tone: "live" | "idle" | "good" | "bad" | "muted";
  /** Whether this state should read as in-motion. Only genuinely live work does. */
  animated: boolean;
};

export const AGENT_STATUS_VISUALS: Record<AgentRunStatus | "idle", StatusVisual> = {
  working: { glyph: "▶", label: "Working", tone: "live", animated: true },
  waiting: { glyph: "◷", label: "Waiting", tone: "idle", animated: false },
  completed: { glyph: "✓", label: "Completed", tone: "good", animated: false },
  failed: { glyph: "✕", label: "Failed", tone: "bad", animated: false },
  blocked: { glyph: "▲", label: "Blocked", tone: "bad", animated: false },
  cancelled: { glyph: "—", label: "Cancelled", tone: "muted", animated: false },
  idle: { glyph: "○", label: "Idle", tone: "muted", animated: false },
};

/**
 * Edge presentation.
 *
 * Each relationship is distinguishable by **dash pattern and width**, not by
 * colour — the same accessibility reason, and it survives the dimming applied
 * to unemphasized edges. `owns` is the structural spine and reads solid;
 * relationship edges are progressively lighter as they get less committal.
 */
export type EdgeVisual = {
  dash: number[];
  width: number;
  label: string;
};

export const AGENT_EDGE_VISUALS: Record<AgentEdgeKind, EdgeVisual> = {
  owns: { dash: [], width: 1.6, label: "runs" },
  edited: { dash: [], width: 1.4, label: "edited" },
  created: { dash: [], width: 1.8, label: "created" },
  deleted: { dash: [2, 3], width: 1.2, label: "deleted" },
  inspected: { dash: [4, 4], width: 1 , label: "inspected" },
  produced: { dash: [], width: 1.4, label: "produced" },
  context: { dash: [4, 4], width: 1, label: "context" },
};

export type AgentNodeVisual = {
  kind: "agent" | "run" | "artifact";
  /** Already in screen space — this module has no camera awareness. */
  x: number;
  y: number;
  /** Card width and height in screen pixels, already scaled by the caller. */
  width: number;
  height: number;
  label: string;
  /** Second line: a run's activity, an artifact's path, an agent's provider. */
  detail?: string;
  status?: AgentRunStatus | "idle";
  /** e.g. "4 files · 2 tabs". Already assembled — this module composes no counts. */
  meta?: string;
  /**
   * Work-item progress, drawn as a ring in the card's top-right corner.
   *
   * Present only when the run actually has countable work items — the scene
   * omits it otherwise, and this module draws nothing rather than an empty
   * ring. An empty ring would read as "0% done", which is a measurement; the
   * truth in that case is that nothing was measured.
   */
  progress?: { completed: number; total: number };
  isSelected: boolean;
  isHovered: boolean;
  isDimmed: boolean;
  /** 0..1, driven by the canvas's own animation loop. */
  visualAlpha?: number;
  /** 0..1 phase for the working indicator. Static states ignore it. */
  pulse?: number;
  colors: AgentNodeColors;
};

export type AgentNodeColors = {
  surface: string;
  border: string;
  selectedBorder: string;
  text: string;
  mutedText: string;
  live: string;
  idle: string;
  good: string;
  bad: string;
  muted: string;
};

function toneColor(colors: AgentNodeColors, tone: StatusVisual["tone"]): string {
  switch (tone) {
    case "live":
      return colors.live;
    case "idle":
      return colors.idle;
    case "good":
      return colors.good;
    case "bad":
      return colors.bad;
    default:
      return colors.muted;
  }
}

/** Rounded rectangle, drawn with lines and arcs so DrawContext stays narrow. */
function roundedRect(
  ctx: DrawContext,
  x: number,
  y: number,
  width: number,
  height: number,
  radius: number
): void {
  const r = Math.min(radius, width / 2, height / 2);
  ctx.beginPath();
  ctx.arc(x + r, y + r, r, Math.PI, Math.PI * 1.5);
  ctx.arc(x + width - r, y + r, r, Math.PI * 1.5, 0);
  ctx.arc(x + width - r, y + height - r, r, 0, Math.PI * 0.5);
  ctx.arc(x + r, y + height - r, r, Math.PI * 0.5, Math.PI);
}

/**
 * Draws one agent-layer node as a card.
 *
 * A card rather than a circle so that a run can carry its title, its state and
 * its counts at a glance — which is the whole point of making runs
 * first-class. Artifacts are drawn the same way but quieter, because a file is
 * context for the work rather than the work itself.
 */
export function drawAgentNode(ctx: DrawContext, node: AgentNodeVisual): void {
  const alpha = node.visualAlpha ?? (node.isDimmed ? 0.3 : 1);
  if (alpha <= 0.01) return;

  const { colors } = node;
  const left = node.x - node.width / 2;
  const top = node.y - node.height / 2;

  ctx.save();
  ctx.globalAlpha = alpha;

  // Body.
  roundedRect(ctx, left, top, node.width, node.height, node.kind === "artifact" ? 5 : 9);
  ctx.fillStyle = colors.surface;
  ctx.fill();

  ctx.lineWidth = node.isSelected ? 2 : 1;
  ctx.strokeStyle = node.isSelected
    ? colors.selectedBorder
    : node.isHovered
      ? colors.text
      : colors.border;
  ctx.stroke();

  const padding = node.kind === "artifact" ? 7 : 10;
  let cursorY = top + padding;

  // Status row. Drawn before the label so a failed run reads as failed even
  // when the title is long enough to be truncated.
  if (node.status) {
    const visual = AGENT_STATUS_VISUALS[node.status];
    const color = toneColor(colors, visual.tone);

    // The working indicator is the ONLY thing that moves, and only while a run
    // genuinely is working. Everything else is still, so motion on this canvas
    // always means something.
    const dotAlpha = visual.animated ? 0.55 + 0.45 * Math.abs(Math.sin((node.pulse ?? 0) * Math.PI)) : 1;
    ctx.save();
    ctx.globalAlpha = alpha * dotAlpha;
    ctx.beginPath();
    ctx.arc(left + padding + 3, cursorY + 5, 3.5, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();

    ctx.fillStyle = color;
    ctx.font = `600 10px ui-sans-serif, system-ui, sans-serif`;
    ctx.textAlign = "left";
    ctx.textBaseline = "top";
    // Glyph as well as colour, so the state survives a colour-blind reading.
    ctx.fillText(`${visual.glyph} ${visual.label}`, left + padding + 12, cursorY);
    cursorY += 14;
  }

  // Label.
  ctx.fillStyle = colors.text;
  ctx.font = `${node.kind === "artifact" ? "500 11px" : "600 12px"} ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "left";
  ctx.textBaseline = "top";
  ctx.fillText(truncateToWidth(ctx, node.label, node.width - padding * 2), left + padding, cursorY);
  cursorY += node.kind === "artifact" ? 13 : 15;

  // Detail line.
  if (node.detail) {
    ctx.fillStyle = colors.mutedText;
    ctx.font = `10px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(
      truncateToWidth(ctx, node.detail, node.width - padding * 2),
      left + padding,
      cursorY
    );
    cursorY += 13;
  }

  // Counts.
  if (node.meta) {
    ctx.fillStyle = colors.mutedText;
    ctx.font = `10px ui-sans-serif, system-ui, sans-serif`;
    ctx.fillText(truncateToWidth(ctx, node.meta, node.width - padding * 2), left + padding, cursorY);
  }

  // Work progress, last so it sits over the card rather than in the text flow.
  if (node.progress) drawProgressRing(ctx, node, left, top, padding);

  ctx.restore();
}

/** Radius of the work-progress ring, in screen pixels before scaling. */
const PROGRESS_RING_RADIUS = 9;

/**
 * A small ring in the card's top-right corner showing how much of a run's
 * work is done.
 *
 * Three deliberate properties:
 *
 *   - **It adds nothing to the layout.** The ring is drawn inside the card's
 *     existing bounds, over the corner the text flow does not reach, so a run
 *     that gains work items does not grow, does not reflow, and — because
 *     placement reads only `kind` and `createdAt` — does not move itself or
 *     anything near it.
 *   - **It is never the only signal.** The fraction is written beside it as
 *     text ("3/7"), and the inspector states it in words. A ring alone would
 *     put the information in geometry and colour, which is exactly what the
 *     accessibility rule for this layer forbids.
 *   - **It does not animate.** Progress changes when work completes, not
 *     continuously, so there is nothing for motion to express. The only
 *     moving thing on this canvas stays the working-status dot.
 */
function drawProgressRing(
  ctx: DrawContext,
  node: AgentNodeVisual,
  left: number,
  top: number,
  padding: number
): void {
  const progress = node.progress;
  if (!progress || progress.total <= 0) return;

  const { colors } = node;
  const centerX = left + node.width - padding - PROGRESS_RING_RADIUS;
  const centerY = top + padding + PROGRESS_RING_RADIUS;
  const fraction = Math.max(0, Math.min(1, progress.completed / progress.total));

  // Track.
  ctx.beginPath();
  ctx.arc(centerX, centerY, PROGRESS_RING_RADIUS, 0, Math.PI * 2);
  ctx.lineWidth = 2;
  ctx.strokeStyle = colors.border;
  ctx.stroke();

  // Completed arc, from twelve o'clock clockwise. A run with nothing finished
  // draws no arc at all, which reads as "not started" rather than as an error.
  if (fraction > 0) {
    ctx.beginPath();
    ctx.arc(
      centerX,
      centerY,
      PROGRESS_RING_RADIUS,
      -Math.PI / 2,
      -Math.PI / 2 + Math.PI * 2 * fraction
    );
    ctx.lineWidth = 2;
    ctx.strokeStyle = fraction >= 1 ? colors.good : colors.live;
    ctx.stroke();
  }

  // The same fact as text, immediately left of the ring.
  ctx.fillStyle = colors.mutedText;
  ctx.font = `600 9px ui-sans-serif, system-ui, sans-serif`;
  ctx.textAlign = "right";
  ctx.textBaseline = "middle";
  ctx.fillText(
    `${progress.completed}/${progress.total}`,
    centerX - PROGRESS_RING_RADIUS - 3,
    centerY
  );
}

export type AgentEdgeVisualInput = {
  from: { x: number; y: number };
  to: { x: number; y: number };
  kind: AgentEdgeKind;
  isEmphasized: boolean;
  color: string;
  /** 0..1, applied on top of the emphasis dimming. */
  visualAlpha?: number;
};

/**
 * Draws one relationship.
 *
 * Unemphasized edges are drawn faintly rather than hidden: a workspace with a
 * hundred relationships needs the shape of the whole thing to stay legible
 * while one neighbourhood is in focus, and removing them entirely would make
 * the picture flicker as the selection moves.
 */
export function drawAgentEdge(ctx: DrawContext, edge: AgentEdgeVisualInput): void {
  const visual = AGENT_EDGE_VISUALS[edge.kind];
  const alpha = (edge.visualAlpha ?? 1) * (edge.isEmphasized ? 0.85 : 0.18);
  if (alpha <= 0.01) return;

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.strokeStyle = edge.color;
  ctx.lineWidth = visual.width * (edge.isEmphasized ? 1 : 0.8);

  const dashable = ctx as DrawContext & { setLineDash?: (segments: number[]) => void };
  dashable.setLineDash?.(visual.dash);

  ctx.beginPath();
  const line = ctx as DrawContext & {
    moveTo?: (x: number, y: number) => void;
    lineTo?: (x: number, y: number) => void;
  };
  line.moveTo?.(edge.from.x, edge.from.y);
  line.lineTo?.(edge.to.x, edge.to.y);
  ctx.stroke();

  dashable.setLineDash?.([]);
  ctx.restore();
}

/** Card sizes in world units, before the camera's zoom is applied. */
export const AGENT_NODE_SIZES: Record<AgentNodeVisual["kind"], { width: number; height: number }> = {
  agent: { width: 190, height: 68 },
  run: { width: 210, height: 82 },
  artifact: { width: 170, height: 46 },
};

/**
 * Everything the canvas needs to draw the agent layer.
 *
 * Its own type, in its own module, so the canvas and its host both depend on
 * this rather than on each other — and so nothing in the rendering path needs
 * to import a hook.
 */
export type AgentCanvasLayer = {
  scene: import("@/lib/agents/spatial/types").AgentSpatialScene;
  positions: Map<string, { x: number; y: number }>;
  /** Edge ids to draw prominently; everything else is drawn faintly. */
  emphasized: Set<string>;
  selectedId: string | null;
};

/** Whether a point is inside a node's card, for hit-testing. */
export function hitTestAgentNode(
  node: { x: number; y: number; width: number; height: number },
  point: { x: number; y: number }
): boolean {
  return (
    point.x >= node.x - node.width / 2 &&
    point.x <= node.x + node.width / 2 &&
    point.y >= node.y - node.height / 2 &&
    point.y <= node.y + node.height / 2
  );
}
