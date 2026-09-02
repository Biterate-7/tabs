import { describe, expect, it } from "vitest";
import { resolveLabelOverlaps, type LabelBox } from "./label-layout";

function box(overrides: Partial<LabelBox> & { id: string }): LabelBox {
  return { x: 0, y: 0, width: 50, height: 12, priority: 0, ...overrides };
}

describe("resolveLabelOverlaps", () => {
  it("keeps both boxes when they don't overlap", () => {
    const boxes = [box({ id: "a", x: 0, y: 0 }), box({ id: "b", x: 200, y: 0 })];
    expect(resolveLabelOverlaps(boxes)).toEqual(new Set());
  });

  it("suppresses the lower-priority box when two overlap", () => {
    const boxes = [box({ id: "high", x: 0, y: 0, priority: 2 }), box({ id: "low", x: 10, y: 0, priority: 1 })];
    expect(resolveLabelOverlaps(boxes)).toEqual(new Set(["low"]));
  });

  it("breaks priority ties by id for determinism", () => {
    const boxes = [box({ id: "b", x: 0, y: 0, priority: 1 }), box({ id: "a", x: 10, y: 0, priority: 1 })];
    // "a" sorts before "b" on a tie, so "a" is placed first and "b" is suppressed.
    expect(resolveLabelOverlaps(boxes)).toEqual(new Set(["b"]));
  });

  it("resolves a 3-way overlap chain deterministically by priority", () => {
    const boxes = [
      box({ id: "low", x: 0, y: 0, priority: 0 }),
      box({ id: "mid", x: 5, y: 0, priority: 1 }),
      box({ id: "high", x: 10, y: 0, priority: 2 }),
    ];
    // All three mutually overlap (each within 50px width of the others) —
    // only the highest-priority one should survive.
    expect(resolveLabelOverlaps(boxes)).toEqual(new Set(["low", "mid"]));
  });

  it("returns an empty set for zero boxes", () => {
    expect(resolveLabelOverlaps([])).toEqual(new Set());
  });
});
