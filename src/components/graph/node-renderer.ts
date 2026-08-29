import type { GraphPalette } from "@/lib/graph/palette";
import { truncateToWidth } from "@/lib/graph/canvas-text";

/** The exact canvas 2D context surface node drawing needs — kept narrow so tests can pass a plain recording fake instead of a real canvas (jsdom has no canvas backend). */
export type DrawContext = Pick<
  CanvasRenderingContext2D,
  "save" | "restore" | "beginPath" | "arc" | "fill" | "stroke" | "clip" | "drawImage" | "fillText" | "measureText"
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
  globalAlpha: number;
};

export type NodeVisual = {
  /** Already in screen space — this module has no camera/zoom awareness. */
  x: number;
  y: number;
  radius: number;
  label: string;
  color: string;
  favicon: HTMLImageElement | null;
  isSelected: boolean;
  isHovered: boolean;
  isCenter: boolean;
  isDimmed: boolean;
  isMatch: boolean;
  showLabel: boolean;
  textSize: number;
};

const LABEL_MAX_WIDTH = 96;

export function drawNode(ctx: DrawContext, palette: GraphPalette, node: NodeVisual): void {
  const { x, y, radius } = node;

  ctx.save();
  ctx.globalAlpha = node.isDimmed ? 0.22 : 1;

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  const hasFavicon = Boolean(node.favicon && node.favicon.complete && node.favicon.naturalWidth > 0);
  if (hasFavicon && node.favicon) {
    ctx.save();
    ctx.clip();
    ctx.drawImage(node.favicon, x - radius, y - radius, radius * 2, radius * 2);
    ctx.restore();
  } else {
    ctx.fillStyle = node.color;
    ctx.fill();
  }

  ctx.beginPath();
  ctx.arc(x, y, radius, 0, Math.PI * 2);
  ctx.lineWidth = node.isSelected ? 2.5 : node.isCenter ? 2 : 1;
  ctx.strokeStyle = node.isSelected
    ? palette.nodeSelectedRing
    : node.isCenter
      ? palette.nodeCenterRing
      : node.isMatch
        ? palette.nodeSelectedRing
        : palette.nodeStroke;
  ctx.stroke();

  if (node.isHovered) {
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = palette.nodeSelectedRing;
    ctx.stroke();
  }

  if (node.showLabel && node.label) {
    const fontSize = Math.round(10.5 * node.textSize);
    ctx.font = `${fontSize}px ${palette.fontFamily}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    ctx.globalAlpha = node.isDimmed ? 0.35 : 0.9;
    ctx.fillStyle = node.isSelected || node.isCenter ? palette.textPrimary : palette.textDim;
    const label = truncateToWidth(ctx, node.label, LABEL_MAX_WIDTH);
    ctx.fillText(label, x, y + radius + 4);
  }

  ctx.restore();
}
