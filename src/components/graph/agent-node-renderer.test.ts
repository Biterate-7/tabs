import { describe, expect, it } from "vitest";
import {
  AGENT_EDGE_VISUALS,
  AGENT_NODE_SIZES,
  AGENT_STATUS_VISUALS,
  drawAgentEdge,
  drawAgentNode,
  hitTestAgentNode,
  type AgentNodeColors,
  type AgentNodeVisual,
} from "./agent-node-renderer";
import { AGENT_RUN_ARTIFACT_ROLES, AGENT_RUN_LINK_ROLES, AGENT_RUN_STATUSES } from "@/lib/agents/types";

/**
 * Recording fake instead of a real canvas — jsdom has no canvas backend, and
 * the renderer's DrawContext is deliberately narrow so this is possible.
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
    isSelected: false,
    isHovered: false,
    isDimmed: false,
    colors: COLORS,
    ...over,
  };
}

describe("status presentation", () => {
  it("covers every domain status plus idle", () => {
    for (const status of AGENT_RUN_STATUSES) {
      expect(AGENT_STATUS_VISUALS[status]).toBeDefined();
    }
    expect(AGENT_STATUS_VISUALS.idle).toBeDefined();
  });

  it("gives every status a glyph and a label, not only a colour", () => {
    for (const visual of Object.values(AGENT_STATUS_VISUALS)) {
      expect(visual.glyph.length).toBeGreaterThan(0);
      expect(visual.label.length).toBeGreaterThan(0);
    }
  });

  it("animates only genuinely live work", () => {
    const animated = Object.entries(AGENT_STATUS_VISUALS)
      .filter(([, visual]) => visual.animated)
      .map(([status]) => status);

    expect(animated).toEqual(["working"]);
  });

  it("distinguishes failed and blocked from completed by tone", () => {
    expect(AGENT_STATUS_VISUALS.failed.tone).toBe("bad");
    expect(AGENT_STATUS_VISUALS.blocked.tone).toBe("bad");
    expect(AGENT_STATUS_VISUALS.completed.tone).toBe("good");
  });
});

describe("edge presentation", () => {
  it("covers every relationship role the domain can produce", () => {
    for (const role of AGENT_RUN_LINK_ROLES) expect(AGENT_EDGE_VISUALS[role]).toBeDefined();
    for (const role of AGENT_RUN_ARTIFACT_ROLES) expect(AGENT_EDGE_VISUALS[role]).toBeDefined();
    expect(AGENT_EDGE_VISUALS.owns).toBeDefined();
  });

  it("distinguishes kinds without relying on colour", () => {
    // Every kind must differ from at least one other in dash or width, so the
    // picture survives a colour-blind reading.
    const signatures = Object.values(AGENT_EDGE_VISUALS).map(
      (visual) => `${visual.dash.join(",")}|${visual.width}`
    );
    expect(new Set(signatures).size).toBeGreaterThan(1);
  });

  it("names every kind for a legend or tooltip", () => {
    for (const visual of Object.values(AGENT_EDGE_VISUALS)) {
      expect(visual.label.length).toBeGreaterThan(0);
    }
  });
});

describe("drawing a node", () => {
  it("draws a card with its label", () => {
    const { ctx, text } = recordingContext();
    drawAgentNode(ctx, node({ label: "Implement auth" }));

    expect(text).toContain("Implement auth");
  });

  it("prints the status glyph and label, not only a coloured dot", () => {
    const { ctx, text } = recordingContext();
    drawAgentNode(ctx, node({ status: "failed" }));

    expect(text.some((line) => line.includes("Failed"))).toBe(true);
    expect(text.some((line) => line.includes(AGENT_STATUS_VISUALS.failed.glyph))).toBe(true);
  });

  it("draws the detail and meta lines when given them", () => {
    const { ctx, text } = recordingContext();
    drawAgentNode(ctx, node({ detail: "Edited sidebar.tsx", meta: "4 files · 2 tabs" }));

    expect(text).toContain("Edited sidebar.tsx");
    expect(text).toContain("4 files · 2 tabs");
  });

  it("draws nothing at all when fully transparent", () => {
    const { ctx, calls } = recordingContext();
    drawAgentNode(ctx, node({ visualAlpha: 0 }));

    expect(calls).toEqual([]);
  });

  it("balances every save with a restore", () => {
    const { ctx, calls } = recordingContext();
    drawAgentNode(ctx, node({ status: "working", detail: "x", meta: "y" }));

    const saves = calls.filter((c) => c.op === "save").length;
    const restores = calls.filter((c) => c.op === "restore").length;
    expect(saves).toBe(restores);
  });

  it("uses the selected border when selected", () => {
    const { ctx } = recordingContext();
    drawAgentNode(ctx, node({ isSelected: true }));

    expect(ctx.strokeStyle).toBe(COLORS.selectedBorder);
  });

  it("draws an artifact more quietly than a run", () => {
    const runText = recordingContext();
    drawAgentNode(runText.ctx, node({ kind: "run", status: "working" }));

    const artifactText = recordingContext();
    drawAgentNode(
      artifactText.ctx,
      node({ kind: "artifact", width: 170, height: 46, status: undefined })
    );

    // A file carries no status row; the work does.
    expect(artifactText.text.some((line) => line.includes("Working"))).toBe(false);
    expect(runText.text.some((line) => line.includes("Working"))).toBe(true);
  });

  it("truncates a label rather than overflowing its card", () => {
    const { ctx, text } = recordingContext();
    drawAgentNode(ctx, node({ label: "x".repeat(400), width: 120 }));

    const drawn = text.find((line) => line.startsWith("x"))!;
    expect(drawn.length).toBeLessThan(400);
  });
});

describe("drawing an edge", () => {
  it("draws a line between the two points", () => {
    const { ctx, calls } = recordingContext();
    drawAgentEdge(ctx, {
      from: { x: 0, y: 0 },
      to: { x: 10, y: 10 },
      kind: "edited",
      isEmphasized: true,
      color: "#fff",
    });

    expect(calls.some((c) => c.op === "moveTo")).toBe(true);
    expect(calls.some((c) => c.op === "lineTo")).toBe(true);
    expect(calls.some((c) => c.op === "stroke")).toBe(true);
  });

  it("applies the kind's dash pattern and clears it again", () => {
    const { ctx, calls } = recordingContext();
    drawAgentEdge(ctx, {
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      kind: "inspected",
      isEmphasized: true,
      color: "#fff",
    });

    const dashes = calls.filter((c) => c.op === "setLineDash").map((c) => c.args[0]);
    expect(dashes[0]).toEqual(AGENT_EDGE_VISUALS.inspected.dash);
    // Restored, so the next thing drawn on this context is not dashed.
    expect(dashes[dashes.length - 1]).toEqual([]);
  });

  it("draws an unemphasized edge faintly rather than hiding it", () => {
    const { ctx, calls } = recordingContext();
    drawAgentEdge(ctx, {
      from: { x: 0, y: 0 },
      to: { x: 1, y: 1 },
      kind: "context",
      isEmphasized: false,
      color: "#fff",
    });

    expect(calls.some((c) => c.op === "stroke")).toBe(true);
  });
});

describe("hit testing", () => {
  const box = { x: 100, y: 100, width: 200, height: 80 };

  it("accepts a point inside the card", () => {
    expect(hitTestAgentNode(box, { x: 100, y: 100 })).toBe(true);
    expect(hitTestAgentNode(box, { x: 199, y: 139 })).toBe(true);
  });

  it("rejects a point outside it", () => {
    expect(hitTestAgentNode(box, { x: 0, y: 0 })).toBe(false);
    expect(hitTestAgentNode(box, { x: 201, y: 100 })).toBe(false);
    expect(hitTestAgentNode(box, { x: 100, y: 141 })).toBe(false);
  });
});

describe("card sizes", () => {
  it("makes a run the most prominent and a file the quietest", () => {
    expect(AGENT_NODE_SIZES.run.height).toBeGreaterThan(AGENT_NODE_SIZES.agent.height);
    expect(AGENT_NODE_SIZES.artifact.height).toBeLessThan(AGENT_NODE_SIZES.agent.height);
  });
});
