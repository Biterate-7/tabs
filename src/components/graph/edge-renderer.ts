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
    ctx.globalAlpha = 1;
  }

  ctx.stroke();
}
