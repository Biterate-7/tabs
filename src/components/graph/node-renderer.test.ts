import { describe, expect, it } from "vitest";
import { drawNode, type DrawContext } from "./node-renderer";
import type { GraphPalette } from "@/lib/graph/palette";

function makeCtx(): DrawContext & { calls: string[]; arcCalls: number[][] } {
  const calls: string[] = [];
  const arcCalls: number[][] = [];
  const ctx = {
    calls,
    arcCalls,
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
    arc: (x: number, y: number, radius: number) => {
      calls.push("arc");
      arcCalls.push([x, y, radius]);
    },
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
  edge: { domain: "#1", workspace: "#2", category: "#3", group: "#4", section: "#4b", manual: "#5" },
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

  it("clips the favicon to a circle of exactly `radius` — the body's real footprint is that circle, not the square drawImage() paints into", () => {
    // drawImage's own bounding box is a `radius*2` square, but it's only
    // ever invoked right after beginPath()+arc()+clip(), so every pixel
    // outside the arc's circle is discarded before it reaches the screen.
    // This is what src/lib/graph/engine.ts's collision-radius math relies on.
    const ctx = makeCtx();
    const favicon = { complete: true, naturalWidth: 16 } as unknown as HTMLImageElement;
    drawNode(ctx, palette, {
      x: 20,
      y: 30,
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
    const clipIndex = ctx.calls.indexOf("clip");
    const drawImageIndex = ctx.calls.indexOf("drawImage");
    const arcIndex = ctx.calls.lastIndexOf("arc", clipIndex);
    expect(arcIndex).toBeGreaterThanOrEqual(0);
    expect(arcIndex).toBeLessThan(clipIndex);
    expect(clipIndex).toBeLessThan(drawImageIndex);
    // The arc immediately preceding the clip is the clip boundary itself —
    // confirm it's centered on the node at exactly `radius`.
    const arcCallsBeforeClip = ctx.arcCalls.length;
    expect(arcCallsBeforeClip).toBeGreaterThan(0);
    const [ax, ay, aradius] = ctx.arcCalls[0];
    expect(ax).toBe(20);
    expect(ay).toBe(30);
    expect(aradius).toBe(8);
  });

  it("scales the visible circle by visualScale, not just the collision radius", () => {
    const ctx = makeCtx();
    drawNode(ctx, palette, {
      x: 0,
      y: 0,
      radius: 10,
      label: "",
      color: "#000",
      favicon: null,
      isSelected: false,
      isHovered: false,
      isCenter: false,
      isDimmed: false,
      isMatch: false,
      showLabel: false,
      textSize: 1,
      visualScale: 0.5,
    });
    const [, , aradius] = ctx.arcCalls[0];
    expect(aradius).toBe(5);
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
