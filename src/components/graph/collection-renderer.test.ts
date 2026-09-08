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

  it("omitting emphasis behaves exactly like emphasis: 1 (regression guard for existing Collection callers)", () => {
    const withoutEmphasis = makeCtx();
    const alphas: number[] = []
    withoutEmphasis.fill = () => alphas.push(withoutEmphasis.globalAlpha)
    drawCollectionBoundary(withoutEmphasis, palette, rect, { name: "X", isSelected: false, showLabel: false, textSize: 1 });

    const withEmphasis1 = makeCtx();
    const alphas2: number[] = []
    withEmphasis1.fill = () => alphas2.push(withEmphasis1.globalAlpha)
    drawCollectionBoundary(withEmphasis1, palette, rect, { name: "X", isSelected: false, showLabel: false, textSize: 1, emphasis: 1 });

    expect(alphas).toEqual(alphas2);
  });

  it("emphasis quiets a boundary relative to a Collection's, but never past the legibility floor", () => {
    const alphaAt = (emphasis?: number) => {
      const ctx = makeCtx();
      let fillAlpha = 0
      let strokeAlpha = 0
      ctx.fill = () => { fillAlpha = ctx.globalAlpha }
      ctx.stroke = () => { if (strokeAlpha === 0) strokeAlpha = ctx.globalAlpha }
      drawCollectionBoundary(ctx, palette, rect, { name: "X", isSelected: false, showLabel: false, textSize: 1, emphasis });
      return { fillAlpha, strokeAlpha }
    }

    const full = alphaAt(1);
    const quiet = alphaAt(0.6);

    // Still ordered: an outer tier reads as quieter than a Collection's own box.
    expect(quiet.fillAlpha).toBeLessThan(full.fillAlpha);
    expect(quiet.strokeAlpha).toBeLessThan(full.strokeAlpha);

    // ...but the multiplier is floored, which is the actual fix. Compounding a
    // 0.6 tier emphasis with an already-low base alpha is what rendered
    // Category boxes at an effective 0.13 stroke — drawn, and invisible.
    expect(quiet.strokeAlpha).toBeGreaterThanOrEqual(full.strokeAlpha * 0.7);
  });

  it("draws a resting boundary at an alpha that is actually visible", () => {
    // Regression guard for the reported "group boxes blend into the
    // background" bug. The old renderer stroked an unselected Category box at
    // 0.22 * 0.6 = 0.132 and filled it at 0.021, which on the app's dark
    // canvas is under one just-noticeable difference. These bounds are
    // deliberately loose — they pin the failure mode, not the exact values.
    const ctx = makeCtx();
    let fillAlpha = 0
    let strokeAlpha = 0
    ctx.fill = () => { fillAlpha = ctx.globalAlpha }
    ctx.stroke = () => { if (strokeAlpha === 0) strokeAlpha = ctx.globalAlpha }
    drawCollectionBoundary(ctx, palette, rect, { name: "X", isSelected: false, showLabel: false, textSize: 1, emphasis: 0.6 });

    expect(strokeAlpha).toBeGreaterThan(0.25);
    expect(fillAlpha).toBeGreaterThan(0.03);
    // ...and still quiet enough to sit behind the graph rather than in front
    // of it: this is a background region, not a UI panel.
    expect(strokeAlpha).toBeLessThan(0.6);
    expect(fillAlpha).toBeLessThan(0.12);
  });

  it("draws a hovered boundary louder than a resting one but quieter than a selected one", () => {
    const strokeAt = (opts: { isHovered?: boolean; isSelected?: boolean }) => {
      const ctx = makeCtx();
      let strokeAlpha = 0
      ctx.stroke = () => { if (strokeAlpha === 0) strokeAlpha = ctx.globalAlpha }
      drawCollectionBoundary(ctx, palette, rect, {
        name: "X",
        isSelected: opts.isSelected ?? false,
        isHovered: opts.isHovered,
        showLabel: false,
        textSize: 1,
      });
      return strokeAlpha
    }

    expect(strokeAt({ isHovered: true })).toBeGreaterThan(strokeAt({}));
    expect(strokeAt({ isSelected: true })).toBeGreaterThan(strokeAt({ isHovered: true }));
  });

  it("marks each corner so the region's extent reads without raising its overall weight", () => {
    const ctx = makeCtx();
    drawCollectionBoundary(ctx, palette, rect, { name: "X", isSelected: false, showLabel: false, textSize: 1 });
    // Outline + brackets: two stroked passes, not one.
    expect(ctx.calls.filter((c) => c === "stroke").length).toBe(2);
  });

  it("does not draw corner brackets on a box too small to hold them", () => {
    const ctx = makeCtx();
    drawCollectionBoundary(ctx, palette, { x: 0, y: 0, width: 8, height: 8 }, {
      name: "X",
      isSelected: false,
      showLabel: false,
      textSize: 1,
    });
    expect(ctx.calls.filter((c) => c === "stroke").length).toBe(1);
  });
});
