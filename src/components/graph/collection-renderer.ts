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
} & Partial<Pick<CanvasRenderingContext2D, "roundRect" | "quadraticCurveTo">>;

const LABEL_MAX_WIDTH = 140;

/**
 * Corner radius, in screen pixels, for a boundary square.
 *
 * Rounded corners are not decoration here: at the low contrast a boundary has
 * to sit at, a hard 90-degree corner is the single most legible cue that
 * there IS an enclosing shape, and rounding reads as a deliberate container
 * rather than as a stray axis-aligned line. Clamped against the rect's own
 * size below so a small box doesn't turn into a lozenge.
 */
const CORNER_RADIUS = 10;

/**
 * Length of the corner brackets drawn on an unselected boundary, as a
 * fraction of the shorter side (capped in pixels below).
 *
 * The brackets are what make a quiet box findable. A uniform 0.13-alpha
 * outline all the way round is, by construction, equally faint everywhere and
 * therefore reads as noise; concentrating a small amount of extra contrast at
 * the four corners tells the eye exactly where the region begins and ends
 * without raising the box's overall visual weight — the same trick a camera
 * viewfinder uses. Total extra ink is a few percent of the perimeter.
 */
const BRACKET_FRACTION = 0.16;
const BRACKET_MAX = 26;

/**
 * Per-state opacity for a boundary's fill and stroke.
 *
 * These were 0.035 fill / 0.22 stroke, multiplied by a per-tier `emphasis` of
 * 0.6 for Category boxes — an effective 0.021 fill and 0.132 stroke, which on
 * TabDump's dark background is under one JND against the canvas. That is the
 * "extremely faint, blends into the background" report: the boxes were being
 * drawn correctly, at an opacity that made them not worth drawing.
 *
 * The values below roughly triple the resting stroke and quadruple the fill,
 * which is enough to read as a defined region at a glance while staying well
 * below every node, edge and label painted on top. `emphasis` still separates
 * the tiers, but is now applied as a floor-respecting multiplier (see
 * `applyEmphasis`) so the outermost tier can be quieter than a Collection
 * without being erased.
 */
const FILL_ALPHA = { resting: 0.05, hovered: 0.075, selected: 0.11 } as const;
const STROKE_ALPHA = { resting: 0.42, hovered: 0.62, selected: 0.85 } as const;
const BRACKET_ALPHA = { resting: 0.72, hovered: 0.9, selected: 1 } as const;
const LABEL_ALPHA = { resting: 0.68, hovered: 0.85, selected: 0.95 } as const;

/**
 * A tier's `emphasis` scales a boundary DOWN from a Collection's full weight,
 * but never below this share of it. Without a floor, the 0.6 emphasis a
 * Category box carries was compounding with an already-low base alpha into
 * invisibility; with it, the tiers stay visually ordered (Collection >
 * Subcategory > Category) while every tier stays legible.
 */
const MIN_EMPHASIS = 0.72;

function applyEmphasis(alpha: number, emphasis: number): number {
  return alpha * Math.max(MIN_EMPHASIS, Math.min(1, emphasis));
}

type BoundaryState = "resting" | "hovered" | "selected";

/** Traces a rounded rectangle, falling back to a plain one where `roundRect` is unavailable (older canvas implementations, and the recording fakes used in tests). */
function traceRoundedRect(ctx: CollectionDrawContext, rect: CollectionBoundaryRect, radius: number): void {
  const { x, y, width, height } = rect;
  ctx.beginPath();
  if (typeof ctx.roundRect === "function" && radius > 0) {
    ctx.roundRect(x, y, width, height, radius);
    return;
  }
  ctx.moveTo(x, y);
  ctx.lineTo(x + width, y);
  ctx.lineTo(x + width, y + height);
  ctx.lineTo(x, y + height);
  ctx.closePath();
}

/** The four corner brackets, as one path. */
function traceCornerBrackets(ctx: CollectionDrawContext, rect: CollectionBoundaryRect, length: number): void {
  const { x, y, width, height } = rect;
  const right = x + width;
  const bottom = y + height;
  ctx.beginPath();
  // Top-left
  ctx.moveTo(x, y + length);
  ctx.lineTo(x, y);
  ctx.lineTo(x + length, y);
  // Top-right
  ctx.moveTo(right - length, y);
  ctx.lineTo(right, y);
  ctx.lineTo(right, y + length);
  // Bottom-right
  ctx.moveTo(right, bottom - length);
  ctx.lineTo(right, bottom);
  ctx.lineTo(right - length, bottom);
  // Bottom-left
  ctx.moveTo(x + length, bottom);
  ctx.lineTo(x, bottom);
  ctx.lineTo(x, bottom - length);
}

/**
 * Draws one cluster/collection boundary — a quiet enclosing region behind its
 * member nodes, not an edge fanning out to every member (that would clutter
 * the graph with edges that don't mean "dependency" or "manual link").
 *
 * Three layers, cheapest to most specific: a soft fill so the region reads as
 * a surface distinct from the canvas, a continuous rounded outline so its
 * extent is unambiguous, and four corner brackets carrying a little extra
 * contrast so the box is findable at a glance without being loud. The label
 * only renders when the caller says the zoom level makes it legible (mirrors
 * node-renderer.ts's showLabel gate).
 */
export function drawCollectionBoundary(
  ctx: CollectionDrawContext,
  palette: GraphPalette,
  rect: CollectionBoundaryRect,
  options: {
    name: string
    isSelected: boolean
    showLabel: boolean
    textSize: number
    /** True while the pointer is over this box's interactive region — the visible answer to "what would I grab if I pressed here". Optional/false by default. */
    isHovered?: boolean
    /** Multiplies every alpha below — lets category/subcategory boundaries reuse this exact renderer at a quieter weight than a Collection's, without a second boundary-drawing implementation. Floored at MIN_EMPHASIS so "quieter" never becomes "invisible". Defaults to 1. */
    emphasis?: number
  }
): void {
  const { x, y, width, height } = rect;
  const state: BoundaryState = options.isSelected ? "selected" : options.isHovered ? "hovered" : "resting";
  const color = options.isSelected ? palette.collectionBoundarySelected : palette.collectionBoundary;
  const emphasis = options.emphasis ?? 1;
  const radius = Math.min(CORNER_RADIUS, width / 2, height / 2);

  ctx.save();

  traceRoundedRect(ctx, rect, radius);
  ctx.fillStyle = color;
  ctx.globalAlpha = applyEmphasis(FILL_ALPHA[state], emphasis);
  ctx.fill();

  ctx.strokeStyle = color;
  ctx.lineWidth = options.isSelected ? 1.75 : options.isHovered ? 1.5 : 1.15;
  ctx.globalAlpha = applyEmphasis(STROKE_ALPHA[state], emphasis);
  ctx.stroke();

  // Corner brackets. Skipped once a box is small enough that they would meet
  // in the middle and just re-draw the outline at double weight.
  const bracket = Math.min(BRACKET_MAX, Math.min(width, height) * BRACKET_FRACTION);
  if (bracket > 3) {
    traceCornerBrackets(ctx, rect, bracket);
    ctx.strokeStyle = color;
    ctx.lineWidth = options.isSelected ? 2.25 : 1.75;
    ctx.globalAlpha = applyEmphasis(BRACKET_ALPHA[state], emphasis);
    ctx.stroke();
  }

  if (options.showLabel) {
    const fontSize = Math.round(11 * options.textSize);
    ctx.font = `${fontSize}px ${palette.fontFamily}`;
    ctx.textAlign = "left";
    ctx.textBaseline = "bottom";
    ctx.fillStyle = options.isSelected ? palette.collectionBoundarySelected : palette.collectionLabel;
    ctx.globalAlpha = applyEmphasis(LABEL_ALPHA[state], emphasis);
    const label = truncateToWidth(ctx, options.name.toUpperCase(), LABEL_MAX_WIDTH);
    ctx.fillText(label, x + 4, y - 4);
  }

  ctx.restore();
}
