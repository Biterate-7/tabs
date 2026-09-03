import { describe, expect, it } from "vitest";
import { computeCollectionBoundary, pointInRect, rectsOverlap, selectNonOverlappingRects } from "./collection-layout";

describe("computeCollectionBoundary", () => {
  it("returns null for no points", () => {
    expect(computeCollectionBoundary([])).toBeNull();
  });

  it("pads a single point's radius on every side", () => {
    const rect = computeCollectionBoundary([{ x: 100, y: 100, radius: 5 }], 10);
    expect(rect).toEqual({ x: 85, y: 85, width: 30, height: 30 });
  });

  it("encloses every point's own radius, not just its center", () => {
    const rect = computeCollectionBoundary(
      [
        { x: 0, y: 0, radius: 5 },
        { x: 100, y: 50, radius: 8 },
      ],
      0
    );
    expect(rect).toEqual({ x: -5, y: -5, width: 113, height: 63 });
  });
});

describe("pointInRect", () => {
  const rect = { x: 0, y: 0, width: 100, height: 50 };

  it("is true for a point inside", () => {
    expect(pointInRect(50, 25, rect)).toBe(true);
  });

  it("is true on the boundary edge", () => {
    expect(pointInRect(0, 0, rect)).toBe(true);
    expect(pointInRect(100, 50, rect)).toBe(true);
  });

  it("is false outside", () => {
    expect(pointInRect(150, 25, rect)).toBe(false);
    expect(pointInRect(50, -5, rect)).toBe(false);
  });
});

describe("rectsOverlap", () => {
  it("is true for overlapping rects", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
  });

  it("is false for disjoint rects", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it("is false for rects that only touch at an edge", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("selectNonOverlappingRects", () => {
  // Reproduces the real failure this guards against: category/subcategory
  // boundary boxes drawn unconditionally, as graph-canvas.tsx used to, would
  // stack two overlapping translucent rects on screen — which is exactly
  // what the reported bug's screenshot showed. Before this function existed,
  // nothing suppressed the second draw.
  it("drops a later rect that overlaps an earlier (higher-priority) one", () => {
    const entries = [
      { id: "big", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "small", rect: { x: 50, y: 50, width: 100, height: 100 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("big")).toBe(true);
    expect(drawable.has("small")).toBe(false);
  });

  it("keeps every rect when none overlap", () => {
    const entries = [
      { id: "a", rect: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "b", rect: { x: 100, y: 100, width: 10, height: 10 } },
      { id: "c", rect: { x: 200, y: 200, width: 10, height: 10 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.size).toBe(3);
  });

  it("never suppresses alwaysDrawId even when it overlaps an earlier rect", () => {
    const entries = [
      { id: "big", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "selected", rect: { x: 50, y: 50, width: 100, height: 100 } },
    ];
    const drawable = selectNonOverlappingRects(entries, "selected");
    expect(drawable.has("big")).toBe(true);
    expect(drawable.has("selected")).toBe(true);
  });

  it("lets a rect overlapping only a suppressed rect still draw (transitively takes over its spot)", () => {
    // a suppresses b (overlap), b would have suppressed c, but since b never
    // actually draws, c should be judged only against what's really on screen (a).
    const entries = [
      { id: "a", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "b", rect: { x: 90, y: 0, width: 100, height: 100 } },
      { id: "c", rect: { x: 300, y: 300, width: 10, height: 10 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("a")).toBe(true);
    expect(drawable.has("b")).toBe(false);
    expect(drawable.has("c")).toBe(true);
  });

  it("treats identical-position rects the same as any other overlap: only the first survives", () => {
    const entries = [
      { id: "first", rect: { x: 10, y: 10, width: 50, height: 50 } },
      { id: "duplicate", rect: { x: 10, y: 10, width: 50, height: 50 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("first")).toBe(true);
    expect(drawable.has("duplicate")).toBe(false);
  });

  // Priority is deliberately a function of *input order*, not id, size, or
  // any other rect property — the contract (see the function's doc comment)
  // is that the caller supplies entries already sorted by priority (weight
  // desc in graph-canvas.tsx). This test locks that contract in: the same
  // two overlapping rects produce the opposite winner when the caller's
  // order is reversed, so a regression that started ignoring input order
  // (e.g. sorting by id internally) would be caught here.
  it("is driven entirely by input order, not id or any property of the rect", () => {
    const rectA = { x: 0, y: 0, width: 100, height: 100 };
    const rectB = { x: 50, y: 50, width: 100, height: 100 };

    const drawableWhenAFirst = selectNonOverlappingRects(
      [
        { id: "a", rect: rectA },
        { id: "b", rect: rectB },
      ],
      null
    );
    expect(drawableWhenAFirst.has("a")).toBe(true);
    expect(drawableWhenAFirst.has("b")).toBe(false);

    const drawableWhenBFirst = selectNonOverlappingRects(
      [
        { id: "b", rect: rectB },
        { id: "a", rect: rectA },
      ],
      null
    );
    expect(drawableWhenBFirst.has("b")).toBe(true);
    expect(drawableWhenBFirst.has("a")).toBe(false);
  });

  it("never lets a lower-priority (later) rect suppress a higher-priority (earlier) one", () => {
    // Encodes the "a category with many nodes must never disappear just
    // because a smaller one happens to be processed first" invariant —
    // guaranteed here because graph-canvas.tsx always feeds entries in
    // weight-desc order, so "earlier" always means "bigger/more populated."
    const entries = [
      { id: "many-nodes", rect: { x: 0, y: 0, width: 200, height: 200 } },
      { id: "few-nodes", rect: { x: 100, y: 100, width: 200, height: 200 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("many-nodes")).toBe(true);
  });
});
