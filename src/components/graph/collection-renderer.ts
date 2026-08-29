import type { GraphPalette } from "@/lib/graph/palette";
import type { CollectionBoundaryRect } from "@/lib/graph/collection-layout";
import { truncateToWidth } from "@/lib/graph/canvas-text";

/** Narrow canvas surface this module needs — same "pick just what's used" convention as node-renderer.ts's DrawContext, so tests can pass a plain recording fake instead of a real canvas. */
export type CollectionDrawContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "moveTo" | "lineTo" | "closePath" | "fill" | "stroke" | "fillText" | "measureText"
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

const LABEL_MAX_WIDTH = 140;

/**
 * Draws one collection's boundary — a quiet rectangular region behind its
 * member nodes, not an edge fanning out to every member (that would clutter
 * the graph with edges that don't mean "dependency" or "manual link"). Kept
 * intentionally plain: a soft fill plus a thin border, brighter only when
 * selected, and a label that only renders when the caller says the zoom
 * level makes it legible (mirrors node-renderer.ts's showLabel gate).
 */
export function drawCollectionBoundary(
  ctx: CollectionDrawContext,
  palette: GraphPalette,
  rect: CollectionBoundaryRect,
  options: { name: string; isSelected: boolean; showLabel: boolean; textSize: number }
): void {
  const { x, y, width, height } = rect;
  const color = options.isSelected ? palette.collectionBoundarySelected : palette.collectionBoundary;

  ctx.save();

  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.closePath();

  ctx.fillStyle = color;
  ctx.globalAlpha = options.isSelected ? 0.08 : 0.035;
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = options.isSelected ? 1.5 : 1;
  ctx.globalAlpha = options.isSelected ? 0.55 : 0.22;
  ctx.stroke();

  if (options.showLabel) {
    const fontSize = Math.round(11 * options.textSize);
    ctx.font = `${fontSize}px ${palette.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = options.isSelected ? palette.collectionBoundarySelected : palette.collectionLabel;
    ctx.globalAlpha = options.isSelected ? 0.9 : 0.6;
    const label = truncateToWidth(ctx, options.name.toUpperCase(), LABEL_MAX_WIDTH);
    ctx.fillText(label, x + 4, y - 4);
  }

  ctx.restore();
}
