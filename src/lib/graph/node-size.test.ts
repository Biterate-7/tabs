import { describe, expect, it } from "vitest";
import { BASE_NODE_RADIUS, computeNodeRadius } from "./node-size";

describe("computeNodeRadius", () => {
  it("uniform mode ignores connection count and distance", () => {
    expect(computeNodeRadius("uniform", 0, undefined)).toBe(BASE_NODE_RADIUS);
    expect(computeNodeRadius("uniform", 50, 0)).toBe(BASE_NODE_RADIUS);
  });

  it("connections mode grows with degree but caps out", () => {
    const low = computeNodeRadius("connections", 1, undefined);
    const high = computeNodeRadius("connections", 12, undefined);
    const beyondCap = computeNodeRadius("connections", 100, undefined);
    expect(low).toBeGreaterThan(BASE_NODE_RADIUS);
    expect(high).toBeGreaterThan(low);
    expect(beyondCap).toBe(high);
  });

  it("relevance mode is largest at the center and shrinks with distance", () => {
    const center = computeNodeRadius("relevance", 0, 0);
    const near = computeNodeRadius("relevance", 0, 1);
    const far = computeNodeRadius("relevance", 0, 5);
    expect(center).toBeGreaterThan(near);
    expect(near).toBeGreaterThan(far);
    expect(far).toBeGreaterThanOrEqual(BASE_NODE_RADIUS);
  });

  it("relevance mode falls back to the base radius outside local view (no distance)", () => {
    expect(computeNodeRadius("relevance", 10, undefined)).toBe(BASE_NODE_RADIUS);
  });
});
