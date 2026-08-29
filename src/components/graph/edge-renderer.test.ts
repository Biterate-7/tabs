import { describe, expect, it } from "vitest";
import { drawDependencyEdge, drawEdge } from "./edge-renderer";
import type { GraphPalette } from "@/lib/graph/palette";

function makeCtx() {
  const calls: string[] = [];
  return {
    calls,
    strokeStyle: "",
    fillStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    closePath: () => calls.push("closePath"),
    stroke: () => calls.push("stroke"),
    fill: () => calls.push("fill"),
  };
}

const palette: GraphPalette = {
  nodeDefault: "#888",
  nodeStroke: "#333",
  nodeSelectedRing: "#f00",
  nodeCenterRing: "#0f0",
  textPrimary: "#fff",
  textDim: "#999",
  edge: { domain: "#d", workspace: "#w", category: "#c", group: "#g", manual: "#m" },
  edgeHighlighted: "#h",
  edgeDim: "#dim",
  edgeDependency: "#dep",
  edgeDependencyHighlighted: "#deph",
  collectionBoundary: "#c1",
  collectionBoundarySelected: "#c2",
  collectionLabel: "#c3",
  category: {
    research: "#a",
    school: "#b",
    projects: "#c",
    shopping: "#d",
    creative: "#e",
    news: "#f",
    "read-later": "#0",
    other: "#1",
  },
  fontFamily: "Arial",
};

describe("drawEdge", () => {
  it("uses the highlighted color when isHighlighted is true, regardless of reasons", () => {
    const ctx = makeCtx();
    drawEdge(ctx, palette, { x1: 0, y1: 0, x2: 1, y2: 1, reasons: ["domain"], isHighlighted: true, isDimmed: false });
    expect(ctx.strokeStyle).toBe(palette.edgeHighlighted);
  });

  it("uses the dimmed color when isDimmed is true", () => {
    const ctx = makeCtx();
    drawEdge(ctx, palette, { x1: 0, y1: 0, x2: 1, y2: 1, reasons: ["domain"], isHighlighted: false, isDimmed: true });
    expect(ctx.strokeStyle).toBe(palette.edgeDim);
  });

  it("picks the manual color over domain when an edge has both reasons", () => {
    const ctx = makeCtx();
    drawEdge(ctx, palette, {
      x1: 0,
      y1: 0,
      x2: 1,
      y2: 1,
      reasons: ["domain", "manual"],
      isHighlighted: false,
      isDimmed: false,
    });
    expect(ctx.strokeStyle).toBe(palette.edge.manual);
  });

  it("always strokes exactly once", () => {
    const ctx = makeCtx();
    drawEdge(ctx, palette, { x1: 0, y1: 0, x2: 1, y2: 1, reasons: ["domain"], isHighlighted: false, isDimmed: false });
    expect(ctx.calls.filter((c) => c === "stroke")).toHaveLength(1);
  });
});

describe("drawDependencyEdge", () => {
  function baseEdge() {
    return { x1: 0, y1: 0, x2: 100, y2: 0, targetRadius: 10, isHighlighted: false, isDimmed: false };
  }

  it("uses the dependency color by default", () => {
    const ctx = makeCtx();
    drawDependencyEdge(ctx, palette, baseEdge());
    expect(ctx.strokeStyle).toBe(palette.edgeDependency);
    expect(ctx.fillStyle).toBe(palette.edgeDependency);
  });

  it("uses the highlighted dependency color when isHighlighted is true", () => {
    const ctx = makeCtx();
    drawDependencyEdge(ctx, palette, { ...baseEdge(), isHighlighted: true });
    expect(ctx.strokeStyle).toBe(palette.edgeDependencyHighlighted);
  });

  it("uses the dimmed color when isDimmed is true", () => {
    const ctx = makeCtx();
    drawDependencyEdge(ctx, palette, { ...baseEdge(), isDimmed: true });
    expect(ctx.strokeStyle).toBe(palette.edgeDim);
  });

  it("draws exactly one line stroke and one filled arrowhead", () => {
    const ctx = makeCtx();
    drawDependencyEdge(ctx, palette, baseEdge());
    expect(ctx.calls.filter((c) => c === "stroke")).toHaveLength(1);
    expect(ctx.calls.filter((c) => c === "fill")).toHaveLength(1);
  });

  it("stops the line short of the target node's radius instead of drawing under it", () => {
    let lastLineTo: [number, number] | null = null;
    const ctx = {
      ...makeCtx(),
      lineTo: (x: number, y: number) => {
        lastLineTo = [x, y];
      },
    };
    drawDependencyEdge(ctx, palette, baseEdge());
    expect(lastLineTo).not.toBeNull();
    const [x] = lastLineTo!;
    // Target is at x=100 with radius 10 — the line's endpoint must land
    // meaningfully before that, leaving room for the arrowhead.
    expect(x).toBeLessThan(90);
  });
});
