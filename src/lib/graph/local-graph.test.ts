import { describe, expect, it } from "vitest";
import { computeLocalDistances, computeLocalNodeIds } from "./local-graph";
import type { GraphEdge } from "./types";

function edge(source: string, target: string): GraphEdge {
  return { id: `${source}::${target}`, source, target, reasons: ["domain"] };
}

// a - b - c - d - e (a chain)
const chain: GraphEdge[] = [edge("a", "b"), edge("b", "c"), edge("c", "d"), edge("d", "e")];

describe("computeLocalNodeIds", () => {
  it("depth 1 includes only direct neighbors", () => {
    expect(computeLocalNodeIds("b", chain, 1)).toEqual(new Set(["a", "b", "c"]));
  });

  it("depth 2 includes neighbors of neighbors", () => {
    expect(computeLocalNodeIds("b", chain, 2)).toEqual(new Set(["a", "b", "c", "d"]));
  });

  it("infinite depth walks the whole connected component", () => {
    expect(computeLocalNodeIds("a", chain, "infinite")).toEqual(new Set(["a", "b", "c", "d", "e"]));
  });

  it("a center with no edges resolves to just itself", () => {
    expect(computeLocalNodeIds("isolated", chain, 2)).toEqual(new Set(["isolated"]));
  });

  it("does not cross disconnected components", () => {
    const disjoint: GraphEdge[] = [edge("a", "b"), edge("x", "y")];
    expect(computeLocalNodeIds("a", disjoint, "infinite")).toEqual(new Set(["a", "b"]));
  });
});

describe("computeLocalDistances", () => {
  it("reports hop distance from the center", () => {
    const distances = computeLocalDistances("a", chain, "infinite");
    expect(distances.get("a")).toBe(0);
    expect(distances.get("b")).toBe(1);
    expect(distances.get("c")).toBe(2);
    expect(distances.get("e")).toBe(4);
  });
});
