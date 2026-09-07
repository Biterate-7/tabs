import { describe, expect, it } from "vitest";
import { buildBulkSeeds, packCluster, packedRadius, type SeedRegion } from "./bulk-layout";

function nearestNeighbourDistance(points: { x: number; y: number }[]): number {
  let nearest = Infinity;
  for (let i = 0; i < points.length; i++) {
    for (let j = i + 1; j < points.length; j++) {
      nearest = Math.min(nearest, Math.hypot(points[i].x - points[j].x, points[i].y - points[j].y));
    }
  }
  return nearest;
}

describe("packCluster", () => {
  const region: SeedRegion = { x: 500, y: -200, r: 300 };

  it("puts a lone member at the region's centre", () => {
    expect(packCluster(0, 1, region, 36)).toEqual({ x: 500, y: -200 });
  });

  it("is deterministic — the same index always lands in the same slot", () => {
    const first = packCluster(7, 40, region, 36);
    const second = packCluster(7, 40, region, 36);
    expect(first).toEqual(second);
  });

  // The whole point of the module. The previous seeding put every member of a
  // cluster inside a 24px disc regardless of how many there were, so a 42-tab
  // category arrived with 42 nodes effectively coincident and collide+charge
  // resolved it as an explosion.
  it("never stacks members: nearest-neighbour separation stays near the collide spacing", () => {
    for (const count of [2, 5, 12, 42, 120, 400]) {
      const points = Array.from({ length: count }, (_, i) => packCluster(i, count, region, 36));
      const nearest = nearestNeighbourDistance(points);
      expect(nearest, `count=${count}`).toBeGreaterThan(36 * 0.55);
    }
  });

  it("keeps every member inside the radius it advertises", () => {
    const count = 80;
    for (let i = 0; i < count; i++) {
      const point = packCluster(i, count, region, 36);
      const distance = Math.hypot(point.x - region.x, point.y - region.y);
      expect(distance).toBeLessThanOrEqual(packedRadius(count, 36) + 1e-9);
    }
  });

  it("grows the footprint as sqrt(count), so density stays constant", () => {
    // 4x the members should need ~2x the radius, not ~4x.
    const small = packedRadius(50, 36);
    const large = packedRadius(200, 36);
    expect(large / small).toBeGreaterThan(1.8);
    expect(large / small).toBeLessThan(2.2);
  });
});

describe("buildBulkSeeds", () => {
  it("packs each cluster around its own region", () => {
    const seeds = buildBulkSeeds(
      new Map([
        ["a", { ids: ["a1", "a2", "a3"], region: { x: 0, y: 0, r: 200 } }],
        ["b", { ids: ["b1", "b2", "b3"], region: { x: 2000, y: 0, r: 200 } }],
      ]),
      36
    );
    for (const id of ["a1", "a2", "a3"]) expect(seeds.get(id)!.x).toBeLessThan(500);
    for (const id of ["b1", "b2", "b3"]) expect(seeds.get(id)!.x).toBeGreaterThan(1500);
  });

  it("assigns slots by sorted id, so arrival order cannot change the layout", () => {
    const region = { x: 10, y: 10, r: 100 };
    const forwards = buildBulkSeeds(new Map([["a", { ids: ["x", "y", "z"], region }]]), 36);
    const backwards = buildBulkSeeds(new Map([["a", { ids: ["z", "y", "x"], region }]]), 36);
    expect([...forwards.entries()].sort()).toEqual([...backwards.entries()].sort());
  });

  it("separates clusters that have no region instead of stacking them at the origin", () => {
    const seeds = buildBulkSeeds(
      new Map([
        ["a", { ids: ["a1", "a2"], region: undefined }],
        ["b", { ids: ["b1", "b2"], region: undefined }],
        ["c", { ids: ["c1", "c2"], region: undefined }],
      ]),
      36
    );
    const centroid = (ids: string[]) => {
      const points = ids.map((id) => seeds.get(id)!);
      return {
        x: points.reduce((s, p) => s + p.x, 0) / points.length,
        y: points.reduce((s, p) => s + p.y, 0) / points.length,
      };
    };
    const a = centroid(["a1", "a2"]);
    const b = centroid(["b1", "b2"]);
    const c = centroid(["c1", "c2"]);
    expect(Math.hypot(a.x - b.x, a.y - b.y)).toBeGreaterThan(36);
    expect(Math.hypot(b.x - c.x, b.y - c.y)).toBeGreaterThan(36);
    expect(Math.hypot(a.x - c.x, a.y - c.y)).toBeGreaterThan(36);
  });

  it("seeds every id it is given, and nothing else", () => {
    const seeds = buildBulkSeeds(
      new Map([["a", { ids: ["a1", "a2"], region: { x: 0, y: 0 } }]]),
      36
    );
    expect([...seeds.keys()].sort()).toEqual(["a1", "a2"]);
  });

  it("handles an empty group without producing a seed", () => {
    const seeds = buildBulkSeeds(new Map([["a", { ids: [], region: { x: 0, y: 0 } }]]), 36);
    expect(seeds.size).toBe(0);
  });

  it("produces only finite coordinates", () => {
    const seeds = buildBulkSeeds(
      new Map([
        ["a", { ids: Array.from({ length: 300 }, (_, i) => `t${i}`), region: { x: -1200, y: 900, r: 50 } }],
      ]),
      36
    );
    for (const point of seeds.values()) {
      expect(Number.isFinite(point.x)).toBe(true);
      expect(Number.isFinite(point.y)).toBe(true);
    }
  });
});
