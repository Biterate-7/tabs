import { describe, expect, it } from "vitest";
import { drawCollectionBoundary, type CollectionDrawContext } from "./collection-renderer";
import type { GraphPalette } from "@/lib/graph/palette";

function makeCtx(): CollectionDrawContext & { calls: string[] } {
  const calls: string[] = [];
  return {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    globalAlpha: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "bottom" as CanvasTextBaseline,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    moveTo: () => calls.push("moveTo"),
    lineTo: () => calls.push("lineTo"),
    closePath: () => calls.push("closePath"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    fillText: (text: string) => calls.push(`fillText:${text}`),
    measureText: (text: string) => ({ width: text.length * 6 }) as TextMetrics,
  };
}

const palette: GraphPalette = {
  nodeDefault: "#888",
  nodeStroke: "#333",
  nodeSelectedRing: "#f00",
  nodeCenterRing: "#0f0",
  textPrimary: "#fff",
  textDim: "#999",
  edge: { domain: "#1", workspace: "#2", category: "#3", group: "#4", section: "#4b", manual: "#5" },
  edgeHighlighted: "#6",
  edgeDim: "#7",
  edgeDependency: "#8",
  edgeDependencyHighlighted: "#9",
  collectionBoundary: "#quiet",
  collectionBoundarySelected: "#bright",
  collectionLabel: "#label",
  favoriteGlow: "234, 179, 8",
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

const rect = { x: 10, y: 10, width: 100, height: 60 };

describe("drawCollectionBoundary", () => {
  it("draws a filled, stroked rectangle", () => {
    const ctx = makeCtx();
    drawCollectionBoundary(ctx, palette, rect, { name: "Physics IA", isSelected: false, showLabel: false, textSize: 1 });
    expect(ctx.calls).toContain("fill");
    expect(ctx.calls).toContain("stroke");
  });

  it("uses the quiet color when not selected", () => {
    const ctx = makeCtx();
    drawCollectionBoundary(ctx, palette, rect, { name: "Physics IA", isSelected: false, showLabel: false, textSize: 1 });
    expect(ctx.strokeStyle).toBe(palette.collectionBoundary);
  });

  it("uses the brighter selected color when selected", () => {
    const ctx = makeCtx();
    drawCollectionBoundary(ctx, palette, rect, { name: "Physics IA", isSelected: true, showLabel: false, textSize: 1 });
    expect(ctx.strokeStyle).toBe(palette.collectionBoundarySelected);
  });

  it("only draws the label text when showLabel is true", () => {
    const withLabel = makeCtx();
    drawCollectionBoundary(withLabel, palette, rect, { name: "Physics IA", isSelected: false, showLabel: true, textSize: 1 });
    expect(withLabel.calls.some((c) => c.startsWith("fillText:"))).toBe(true);

    const withoutLabel = makeCtx();
    drawCollectionBoundary(withoutLabel, palette, rect, { name: "Physics IA", isSelected: false, showLabel: false, textSize: 1 });
    expect(withoutLabel.calls.some((c) => c.startsWith("fillText:"))).toBe(false);
  });

  it("uppercases the label", () => {
    const ctx = makeCtx();
    drawCollectionBoundary(ctx, palette, rect, { name: "Physics IA", isSelected: false, showLabel: true, textSize: 1 });
    expect(ctx.calls.some((c) => c === "fillText:PHYSICS IA")).toBe(true);
  });
});
