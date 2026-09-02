import type { GraphPalette } from "@/lib/graph/palette";
import { primaryEdgeReason } from "@/lib/graph/palette";
import type { EdgeReason } from "@/lib/graph/types";
import type { DrawContext } from "./node-renderer";

export type EdgeVisual = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  reasons: EdgeReason[];
  isHighlighted: boolean;
  isDimmed: boolean;
  /** True when the edge's two endpoints belong to different top-level cluster regions — dimmed further so cross-cluster connections stay subtle without disappearing (see clusters.ts's ClusterTree.clusterPathOfTab). Optional/falsy by default so existing callers are unaffected. */
  isCrossCluster?: boolean;
  /** True when the edge's only reason is a broad, low-signal relationship (currently "domain" or "workspace") — dimmed slightly so stronger signals (category/section/manual/dependency) read more clearly. Optional/falsy by default. */
  isWeak?: boolean;
};

export type EdgeDrawContext = Pick<DrawContext, "beginPath" | "stroke"> & {
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  moveTo: CanvasRenderingContext2D["moveTo"];
  lineTo: CanvasRenderingContext2D["lineTo"];
};

export function drawEdge(ctx: EdgeDrawContext, palette: GraphPalette, edge: EdgeVisual): void {
  ctx.beginPath();
  ctx.moveTo(edge.x1, edge.y1);
  ctx.lineTo(edge.x2, edge.y2);

  if (edge.isHighlighted) {
    ctx.strokeStyle = palette.edgeHighlighted;
    ctx.lineWidth = 1.6;
    ctx.globalAlpha = 0.9;
  } else if (edge.isDimmed) {
    ctx.strokeStyle = palette.edgeDim;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 1;
  } else {
    ctx.strokeStyle = palette.edge[primaryEdgeReason(edge.reasons)];
    ctx.lineWidth = 1;
    ctx.globalAlpha = (edge.isCrossCluster ? 0.35 : 1) * (edge.isWeak ? 0.6 : 1);
  }

  ctx.stroke();
}

export type DependencyEdgeVisual = {
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  /** Screen-space radius of the target (child) node — the line and arrowhead stop short of it instead of drawing under the node. */
  targetRadius: number;
  isHighlighted: boolean;
  isDimmed: boolean;
  /** Extra 0..1 opacity multiplier for ephemeral create/remove effects. Defaults to 1 (no change) so existing callers are unaffected. */
  opacity?: number;
};

export type DependencyEdgeDrawContext = EdgeDrawContext & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  closePath: CanvasRenderingContext2D["closePath"];
  fill: CanvasRenderingContext2D["fill"];
};

const ARROW_LENGTH = 7;
const ARROW_WIDTH = 5;
const ARROW_GAP = 2;

/**
 * Draws a directional dependency edge: a line from parent to child plus a
 * small filled triangular arrowhead pointing at the child, offset outside
 * the child node's radius so it never overlaps the node itself. Kept as a
 * separate draw function (rather than a branch inside drawEdge) since
 * dependency edges are a distinct concept from the undirected EdgeReason
 * edges — see GraphDependencyEdge's doc comment in lib/graph/types.ts.
 */
export function drawDependencyEdge(
  ctx: DependencyEdgeDrawContext,
  palette: GraphPalette,
  edge: DependencyEdgeVisual
): void {
  const dx = edge.x2 - edge.x1;
  const dy = edge.y2 - edge.y1;
  const distance = Math.hypot(dx, dy) || 1;
  const ux = dx / distance;
  const uy = dy / distance;
  const stopDistance = edge.targetRadius + ARROW_LENGTH + ARROW_GAP;
  const lineEndX = edge.x2 - ux * stopDistance;
  const lineEndY = edge.y2 - uy * stopDistance;
  const tipX = edge.x2 - ux * (edge.targetRadius + ARROW_GAP);
  const tipY = edge.y2 - uy * (edge.targetRadius + ARROW_GAP);

  const color = edge.isHighlighted
    ? palette.edgeDependencyHighlighted
    : edge.isDimmed
      ? palette.edgeDim
      : palette.edgeDependency;

  const opacity = edge.opacity ?? 1;

  ctx.beginPath();
  ctx.moveTo(edge.x1, edge.y1);
  ctx.lineTo(lineEndX, lineEndY);
  ctx.strokeStyle = color;
  ctx.lineWidth = edge.isHighlighted ? 1.6 : 1.1;
  ctx.globalAlpha = (edge.isDimmed ? 1 : edge.isHighlighted ? 0.95 : 0.85) * opacity;
  ctx.stroke();

  // Arrowhead: a small filled triangle whose tip sits just outside the
  // target node, base perpendicular to the travel direction.
  const perpX = -uy;
  const perpY = ux;
  const baseX = tipX - ux * ARROW_LENGTH;
  const baseY = tipY - uy * ARROW_LENGTH;

  ctx.beginPath();
  ctx.moveTo(tipX, tipY);
  ctx.lineTo(baseX + perpX * ARROW_WIDTH, baseY + perpY * ARROW_WIDTH);
  ctx.lineTo(baseX - perpX * ARROW_WIDTH, baseY - perpY * ARROW_WIDTH);
  ctx.closePath();
  ctx.fillStyle = color;
  ctx.fill();
}
