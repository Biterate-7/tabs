export type TextMeasurer = Pick<CanvasRenderingContext2D, "measureText">;

/** Truncates `text` with an ellipsis so it fits within `maxWidth` px in the context's current font, without canvas's native (nonexistent) text-overflow support. */
export function truncateToWidth(ctx: TextMeasurer, text: string, maxWidth: number): string {
  if (ctx.measureText(text).width <= maxWidth) return text;

  const ellipsis = "…";
  let low = 0;
  let high = text.length;
  while (low < high) {
    const mid = Math.ceil((low + high) / 2);
    const candidate = text.slice(0, mid) + ellipsis;
    if (ctx.measureText(candidate).width <= maxWidth) low = mid;
    else high = mid - 1;
  }
  return low === 0 ? ellipsis : text.slice(0, low) + ellipsis;
}
