import { describe, expect, it } from "vitest";
import { drawNode, type DrawContext } from "./node-renderer";
import type { GraphPalette } from "@/lib/graph/palette";

function makeCtx(): DrawContext & { calls: string[] } {
  const calls: string[] = [];
  const ctx = {
    calls,
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "center" as CanvasTextAlign,
    textBaseline: "top" as CanvasTextBaseline,
    globalAlpha: 1,
    save: () => calls.push("save"),
    restore: () => calls.push("restore"),
    beginPath: () => calls.push("beginPath"),
    arc: () => calls.push("arc"),
    fill: () => calls.push("fill"),
    stroke: () => calls.push("stroke"),
    clip: () => calls.push("clip"),
    drawImage: () => calls.push("drawImage"),
    fillText: (text: string) => calls.push(`fillText:${text}`),
    measureText: (text: string) => ({ width: text.length * 6 }) as TextMetrics,
  };
  return ctx;
}

const palette: GraphPalette = {
  nodeDefault: "#888",
  nodeStroke: "#333",
  nodeSelectedRing: "#f00",
  nodeCenterRing: "#0f0",
  textPrimary: "#fff",
  textDim: "#999",
  edge: { domain: "#1", workspace: "#2", category: "#3", group: "#4", manual: "#5" },
  edgeHighlighted: "#6",
  edgeDim: "#7",
  edgeDependency: "#8",
  edgeDependencyHighlighted: "#9",
  collectionBoundary: "#c1",
  collectionBoundarySelected: "#c2",
  collectionLabel: "#c3",
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

describe("drawNode", () => {
  it("fills with the node color when there is no favicon", () => {
    const ctx = makeCtx();
    drawNode(ctx, palette, {
      x: 10,
      y: 10,
      radius: 6,
      label: "Example",
      color: "#123456",
      favicon: null,
      isSelected: false,
      isHovered: false,
      isCenter: false,
      isDimmed: false,
      isMatch: false,
      showLabel: false,
      textSize: 1,
    });
    expect(ctx.calls).toContain("fill");
    expect(ctx.calls).not.toContain("clip");
  });

  it("clips and draws the favicon image when one is loaded", () => {
    const ctx = makeCtx();
    const favicon = { complete: true, naturalWidth: 16 } as unknown as HTMLImageElement;
    drawNode(ctx, palette, {
      x: 0,
      y: 0,
      radius: 8,
      label: "",
      color: "#000",
      favicon,
      isSelected: false,
      isHovered: false,
      isCenter: false,
      isDimmed: false,
      isMatch: false,
      showLabel: false,
      textSize: 1,
    });
    expect(ctx.calls).toContain("clip");
    expect(ctx.calls).toContain("drawImage");
  });

  it("ignores an incomplete favicon image and falls back to the fill color", () => {
    const ctx = makeCtx();
    const favicon = { complete: false, naturalWidth: 0 } as unknown as HTMLImageElement;
    drawNode(ctx, palette, {
      x: 0,
      y: 0,
      radius: 8,
      label: "",
      color: "#000",
      favicon,
      isSelected: false,
      isHovered: false,
      isCenter: false,
      isDimmed: false,
      isMatch: false,
      showLabel: false,
      textSize: 1,
    });
    expect(ctx.calls).toContain("fill");
    expect(ctx.calls).not.toContain("drawImage");
  });

  it("draws a truncated label only when showLabel is true", () => {
    const withLabel = makeCtx();
    drawNode(withLabel, palette, {
      x: 0,
      y: 0,
      radius: 5,
      label: "A very long tab title that should be truncated",
      color: "#000",
      favicon: null,
      isSelected: false,
      isHovered: false,
      isCenter: false,
      isDimmed: false,
      isMatch: false,
      showLabel: true,
      textSize: 1,
    });
    expect(withLabel.calls.some((c) => c.startsWith("fillText:") && c.includes("…"))).toBe(true);

    const withoutLabel = makeCtx();
    drawNode(withoutLabel, palette, {
      x: 0,
      y: 0,
      radius: 5,
      label: "Some title",
      color: "#000",
      favicon: null,
      isSelected: false,
      isHovered: false,
      isCenter: false,
      isDimmed: false,
      isMatch: false,
      showLabel: false,
      textSize: 1,
    });
    expect(withoutLabel.calls.some((c) => c.startsWith("fillText:"))).toBe(false);
  });
});
