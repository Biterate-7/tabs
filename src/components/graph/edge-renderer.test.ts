import { describe, expect, it } from "vitest";
import { drawEdge } from "./edge-renderer";
import type { GraphPalette } from "@/lib/graph/palette";

function makeCtx() {
  const calls: string[] = [];
  return {
    calls,
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    stroke: () => calls.push("stroke"),
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
