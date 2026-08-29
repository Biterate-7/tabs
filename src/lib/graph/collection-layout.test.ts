import { describe, expect, it } from "vitest";
import { computeCollectionBoundary, pointInRect } from "./collection-layout";

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
