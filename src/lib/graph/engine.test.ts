import { describe, expect, it } from "vitest";
import { createGraphSimulation } from "./engine";
import type { GraphNode } from "./types";

function makeGraphNode(id: string): GraphNode {
  return {
    id,
    tab: { id, url: `https://example.com/${id}`, normalizedUrl: `https://example.com/${id}`, domain: "example.com" },
    workspaceId: "ws-1",
    workspaceName: "Workspace",
  };
}

describe("createGraphSimulation collection clustering", () => {
  it("pulls a collection's members closer together over time", () => {
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("a"), makeGraphNode("b")];
    sim.setNodes(nodes, () => 5, { a: { x: -300, y: 0 }, b: { x: 300, y: 0 } });
    sim.setEdges([], 1);
    sim.setCollections([{ tabIds: ["a", "b"] }]);
    sim.reheat(1);

    const before = Math.hypot(
      sim.findNode("a")!.x! - sim.findNode("b")!.x!,
      sim.findNode("a")!.y! - sim.findNode("b")!.y!
    );

    for (let i = 0; i < 60; i++) sim.tick();

    const after = Math.hypot(
      sim.findNode("a")!.x! - sim.findNode("b")!.x!,
      sim.findNode("a")!.y! - sim.findNode("b")!.y!
    );

    expect(after).toBeLessThan(before);
  });

  it("ignores a single-member collection (nothing to cluster toward)", () => {
    const sim = createGraphSimulation();
    const nodes = [makeGraphNode("a")];
    sim.setNodes(nodes, () => 5, { a: { x: 50, y: 50 } });
    sim.setEdges([], 1);
    // Should not throw, and should not pin the lone node to its own position.
    expect(() => sim.setCollections([{ tabIds: ["a"] }])).not.toThrow();
    sim.reheat(1);
    for (let i = 0; i < 10; i++) sim.tick();
    expect(sim.findNode("a")).toBeDefined();
  });

  it("silently ignores tab ids that aren't currently physics nodes", () => {
    const sim = createGraphSimulation();
    sim.setNodes([makeGraphNode("a")], () => 5, {});
    expect(() => sim.setCollections([{ tabIds: ["a", "ghost"] }])).not.toThrow();
  });
});
