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
  /** Draws a soft gold halo behind the node body — independent of isSelected/isHovered, see the module doc comment below. Defaults to false so existing fixtures/tests that don't set it keep rendering unchanged. */
  isFavorite?: boolean;
  showLabel: boolean;
  textSize: number;
  /** Eased 0..1 opacity multiplier driven by the canvas's own animation loop (selection/search/hover fades, arrival pop-in). Falls back to the isDimmed boolean's snapped value when omitted, so fixtures that don't set it keep working unchanged. */
  visualAlpha?: number;
  /** Eased 0..1 scale multiplier for arrival pop-in. Defaults to 1 (no scaling) when omitted. */
  visualScale?: number;
};

const LABEL_MAX_WIDTH = 96;

export function drawNode(ctx: DrawContext, palette: GraphPalette, node: NodeVisual): void {
  const { x, y } = node;
  const scale = node.visualScale ?? 1;
  const radius = node.radius * scale;
  const bodyAlpha = node.visualAlpha ?? (node.isDimmed ? 0.22 : 1);

  ctx.save();
  ctx.globalAlpha = bodyAlpha;

  // A restrained gold halo for favorited nodes, independent of selection/
  // hover — drawn as two soft falloff rings (rather than a canvas shadow
  // blur, which DrawContext's deliberately narrow test surface doesn't
  // carry) behind the node body, which then paints over their inner portion
  // so only the outer bleed reads as a halo. Purely additive: it never
  // changes the body fill, selection ring, or hover ring drawn below.
  if (node.isFavorite) {
    ctx.save();
    ctx.globalAlpha = bodyAlpha * 0.45;
    ctx.lineWidth = 3;
    ctx.strokeStyle = `rgba(${palette.favoriteGlow}, 0.4)`;
    ctx.beginPath();
    ctx.arc(x, y, radius + 4, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = bodyAlpha * 0.85;
    ctx.lineWidth = 1.5;
    ctx.strokeStyle = `rgba(${palette.favoriteGlow}, 0.75)`;
    ctx.beginPath();
    ctx.arc(x, y, radius + 1.5, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
  }

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
    ctx.globalAlpha = node.visualAlpha !== undefined ? bodyAlpha * (node.isSelected || node.isCenter ? 1 : 0.85) : node.isDimmed ? 0.35 : 0.9;
    ctx.fillStyle = node.isSelected || node.isCenter ? palette.textPrimary : palette.textDim;
    const label = truncateToWidth(ctx, node.label, LABEL_MAX_WIDTH);
    ctx.fillText(label, x, y + radius + 4);
  }

  ctx.restore();
}
