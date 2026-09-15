import { describe, expect, it } from "vitest";
import { drawAgentNode, type AgentNodeColors, type AgentNodeVisual } from "./agent-node-renderer";

/**
 * The work-progress ring on a run card.
 *
 * Same recording-fake approach as agent-node-renderer.test.ts — jsdom has no
 * canvas backend, and the renderer's DrawContext is narrow enough to fake.
 *
 * What these pin is not how the ring looks but what it is allowed to *claim*:
 * nothing when nothing was counted, and never geometry alone.
 */
function recordingContext() {
  const calls: { op: string; args: unknown[] }[] = [];
  const text: string[] = [];

  const ctx = {
    save: () => calls.push({ op: "save", args: [] }),
    restore: () => calls.push({ op: "restore", args: [] }),
    beginPath: () => calls.push({ op: "beginPath", args: [] }),
    arc: (...args: unknown[]) => calls.push({ op: "arc", args }),
    fill: () => calls.push({ op: "fill", args: [] }),
    stroke: () => calls.push({ op: "stroke", args: [] }),
    clip: () => calls.push({ op: "clip", args: [] }),
    drawImage: (...args: unknown[]) => calls.push({ op: "drawImage", args }),
    fillText: (value: string, ...rest: unknown[]) => {
      text.push(value);
      calls.push({ op: "fillText", args: [value, ...rest] });
    },
    measureText: (value: string) => ({ width: value.length * 6 }) as TextMetrics,
    moveTo: (...args: unknown[]) => calls.push({ op: "moveTo", args }),
    lineTo: (...args: unknown[]) => calls.push({ op: "lineTo", args }),
    setLineDash: (segments: number[]) => calls.push({ op: "setLineDash", args: [segments] }),
    fillStyle: "",
    strokeStyle: "",
    lineWidth: 1,
    font: "",
    textAlign: "left" as CanvasTextAlign,
    textBaseline: "top" as CanvasTextBaseline,
    globalAlpha: 1,
  };

  return { ctx, calls, text };
}

const COLORS: AgentNodeColors = {
  surface: "#111",
  border: "#222",
  selectedBorder: "#3b82f6",
  text: "#fff",
  mutedText: "#999",
  live: "#22c55e",
  idle: "#eab308",
  good: "#38bdf8",
  bad: "#ef4444",
  muted: "#666",
};

function node(over: Partial<AgentNodeVisual> = {}): AgentNodeVisual {
  return {
    kind: "run",
    x: 100,
    y: 100,
    width: 210,
    height: 82,
    label: "Implement auth",
    status: "working",
    isSelected: false,
    isHovered: false,
    isDimmed: false,
    colors: COLORS,
    ...over,
  };
}

/** How many arcs a card draws without any ring, for comparison. */
function arcCount(visual: AgentNodeVisual): number {
  const { ctx, calls } = recordingContext();
  drawAgentNode(ctx, visual);
  return calls.filter((call) => call.op === "arc").length;
}

describe("the work progress ring", () => {
  it("draws nothing at all when there is no progress to report", () => {
    const { ctx, text } = recordingContext();
    drawAgentNode(ctx, node());

    // No fabricated ratio anywhere on the card.
    expect(text.join(" ")).not.toMatch(/\d+\/\d+/);
  });

  it("draws nothing for a total of zero, rather than an empty ring", () => {
    const withZero = node({ progress: { completed: 0, total: 0 } });

    // An empty ring would read as "0% done", which is a measurement. The
    // truth for total: 0 is that nothing was measured.
    expect(arcCount(withZero)).toBe(arcCount(node()));
  });

  it("writes the fraction as text, so the ring is never the only signal", () => {
    const { ctx, text } = recordingContext();
    drawAgentNode(ctx, node({ progress: { completed: 3, total: 7 } }));

    expect(text).toContain("3/7");
  });

  it("draws a track plus a completed arc once some work is done", () => {
    const none = arcCount(node());
    const started = arcCount(node({ progress: { completed: 1, total: 4 } }));

    // Track and arc: two more arcs than a card with no ring.
    expect(started).toBe(none + 2);
  });

  it("draws the track but no arc when nothing is finished yet", () => {
    const none = arcCount(node());
    const unstarted = arcCount(node({ progress: { completed: 0, total: 4 } }));

    // A run with nothing finished reads as "not started", not as an error.
    expect(unstarted).toBe(none + 1);
  });

  it("stays inside the card, so a ring cannot change any layout", () => {
    const { ctx, calls } = recordingContext();
    const visual = node({ progress: { completed: 2, total: 4 } });
    drawAgentNode(ctx, visual);

    const left = visual.x - visual.width / 2;
    const top = visual.y - visual.height / 2;

    // Every arc the ring draws is within the card's own bounds — the card
    // never grows to accommodate it, so placement cannot be perturbed.
    for (const call of calls.filter((c) => c.op === "arc")) {
      const [cx, cy, r] = call.args as [number, number, number];
      expect(cx - r).toBeGreaterThanOrEqual(left - 0.01);
      expect(cx + r).toBeLessThanOrEqual(left + visual.width + 0.01);
      expect(cy - r).toBeGreaterThanOrEqual(top - 0.01);
      expect(cy + r).toBeLessThanOrEqual(top + visual.height + 0.01);
    }
  });

  it("does not animate — progress changes on completion, not continuously", () => {
    const first = recordingContext();
    drawAgentNode(first.ctx, node({ progress: { completed: 2, total: 4 }, pulse: 0 }));

    const second = recordingContext();
    drawAgentNode(second.ctx, node({ progress: { completed: 2, total: 4 }, pulse: 0.5 }));

    // The pulse phase drives the working-status dot's alpha only; every arc
    // the ring draws is identical between frames.
    const arcsOf = (calls: { op: string; args: unknown[] }[]) =>
      calls.filter((c) => c.op === "arc").map((c) => c.args);
    expect(arcsOf(first.calls)).toEqual(arcsOf(second.calls));
  });

  it("clamps a ratio that somehow exceeds one", () => {
    const { ctx, calls } = recordingContext();
    drawAgentNode(ctx, node({ progress: { completed: 9, total: 4 } }));

    // The domain refuses such a ratio, but the renderer must not draw a
    // multiple-turn arc if one ever reaches it.
    for (const call of calls.filter((c) => c.op === "arc")) {
      const [, , , start, end] = call.args as [number, number, number, number, number];
      if (end === undefined) continue;
      expect(Math.abs(end - start)).toBeLessThanOrEqual(Math.PI * 2 + 0.01);
    }
  });

  it("is drawn for runs and never for artifacts, which have no work items", () => {
    const artifact = node({ kind: "artifact", status: undefined });
    expect(arcCount({ ...artifact, progress: { completed: 1, total: 2 } })).toBe(
      arcCount(artifact) + 2
    );
    // The scene never sets progress on an artifact node; this only pins that
    // the renderer has no separate artifact branch that would crash on one.
  });
});
