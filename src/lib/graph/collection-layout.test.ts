import { describe, expect, it } from "vitest";
import {
  boundaryDelimitsMembers,
  boundaryPurity,
  computeCollectionBoundary,
  measureBoundaryOccupancy,
  occupancyDelimitsMembers,
  pointInRect,
  rectContains,
  rectsOverlap,
  resolveLiveBoundaries,
  type BoundaryCandidate,
  type BoundaryOccupant,
} from "./collection-layout";

describe("computeCollectionBoundary", () => {
  it("returns null for no points", () => {
    expect(computeCollectionBoundary([])).toBeNull();
  });

  it("pads a single point's radius on every side", () => {
    const rect = computeCollectionBoundary([{ x: 100, y: 100, radius: 5 }], 10);
    expect(rect).toEqual({ x: 85, y: 85, width: 30, height: 30 });
  });

  it("encloses every point's own radius, not just its center", () => {
    const rect = computeCollectionBoundary(
      [
        { x: 0, y: 0, radius: 5 },
        { x: 100, y: 50, radius: 8 },
      ],
      0
    );
    expect(rect).toEqual({ x: -5, y: -5, width: 113, height: 63 });
  });
});

describe("pointInRect", () => {
  const rect = { x: 0, y: 0, width: 100, height: 50 };

  it("is true for a point inside", () => {
    expect(pointInRect(50, 25, rect)).toBe(true);
  });

  it("is true on the boundary edge", () => {
    expect(pointInRect(0, 0, rect)).toBe(true);
    expect(pointInRect(100, 50, rect)).toBe(true);
  });

  it("is false outside", () => {
    expect(pointInRect(150, 25, rect)).toBe(false);
    expect(pointInRect(50, -5, rect)).toBe(false);
  });
});

describe("rectsOverlap", () => {
  it("is true for overlapping rects", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 5, y: 5, width: 10, height: 10 })).toBe(true);
  });

  it("is false for disjoint rects", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 20, y: 20, width: 10, height: 10 })).toBe(false);
  });

  it("is false for rects that only touch at an edge", () => {
    expect(rectsOverlap({ x: 0, y: 0, width: 10, height: 10 }, { x: 10, y: 0, width: 10, height: 10 })).toBe(false);
  });
});

describe("rectContains", () => {
  const outer = { x: 0, y: 0, width: 100, height: 100 };

  it("is true for a rect wholly inside, including flush edges", () => {
    expect(rectContains(outer, { x: 10, y: 10, width: 20, height: 20 })).toBe(true);
    expect(rectContains(outer, outer)).toBe(true);
  });

  it("is false when the inner rect pokes out on any side", () => {
    expect(rectContains(outer, { x: -1, y: 10, width: 20, height: 20 })).toBe(false);
    expect(rectContains(outer, { x: 10, y: -1, width: 20, height: 20 })).toBe(false);
    expect(rectContains(outer, { x: 90, y: 10, width: 20, height: 20 })).toBe(false);
    expect(rectContains(outer, { x: 10, y: 90, width: 20, height: 20 })).toBe(false);
  });

  it("is false for a merely-overlapping rect", () => {
    expect(rectContains(outer, { x: 50, y: 50, width: 100, height: 100 })).toBe(false);
  });
});

describe("boundaryDelimitsMembers", () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const inside = (id: string) => ({ id, x: 50, y: 50 });
  const outside = (id: string) => ({ id, x: 500, y: 500 });

  it("accepts a box whose contents are almost entirely its own members", () => {
    const occupants = [inside("a"), inside("b"), inside("c"), outside("x"), outside("y")];
    expect(boundaryDelimitsMembers(rect, new Set(["a", "b", "c"]), occupants)).toBe(true);
  });

  // The reported 500-tab glitch, reduced: a cluster owning a tenth of the
  // graph whose box has swallowed the whole graph. Inside the box its
  // members are no more concentrated than they are anywhere else, so the
  // outline marks out nothing and must not be drawn.
  it("rejects a box that has swallowed the whole graph", () => {
    const occupants = Array.from({ length: 100 }, (_, i) => inside(`t${i}`));
    const members = new Set(Array.from({ length: 10 }, (_, i) => `t${i}`));
    expect(boundaryDelimitsMembers(rect, members, occupants)).toBe(false);
  });

  // Same 10%-of-the-graph cluster, but now its box really does mark out
  // where those tabs live: they are 4x denser inside it than graph-wide.
  it("accepts a modest share when it is well above the graph-wide baseline", () => {
    const occupants = [
      ...Array.from({ length: 8 }, (_, i) => inside(`m${i}`)),
      ...Array.from({ length: 12 }, (_, i) => inside(`f${i}`)),
      ...Array.from({ length: 80 }, (_, i) => outside(`o${i}`)),
    ];
    expect(boundaryDelimitsMembers(rect, new Set(occupants.slice(0, 8).map((o) => o.id)), occupants)).toBe(true);
  });

  it("still draws a cluster that legitimately dominates the graph", () => {
    const occupants = [
      ...Array.from({ length: 90 }, (_, i) => inside(`m${i}`)),
      ...Array.from({ length: 10 }, (_, i) => outside(`o${i}`)),
    ];
    expect(boundaryDelimitsMembers(rect, new Set(occupants.slice(0, 90).map((o) => o.id)), occupants)).toBe(true);
  });

  it("treats a box with nothing inside it as vacuously fine", () => {
    expect(boundaryDelimitsMembers(rect, new Set(["a"]), [outside("a")])).toBe(true);
  });
});

describe("measureBoundaryOccupancy", () => {
  const rect = { x: 0, y: 0, width: 100, height: 100 };
  const inside = (id: string) => ({ id, x: 50, y: 50 });
  const outside = (id: string) => ({ id, x: 500, y: 500 });

  it("counts what the box holds, what of that is its own, and its members overall", () => {
    const occupants = [inside("a"), inside("b"), inside("x"), outside("c"), outside("y")];
    expect(measureBoundaryOccupancy(rect, new Set(["a", "b", "c"]), occupants)).toEqual({
      inside: 3,
      ownInside: 2,
      ownTotal: 3,
    });
  });

  it("agrees with boundaryDelimitsMembers, which is now defined in terms of it", () => {
    const occupants = [
      ...Array.from({ length: 5 }, (_, i) => inside(`m${i}`)),
      ...Array.from({ length: 40 }, (_, i) => inside(`f${i}`)),
      ...Array.from({ length: 55 }, (_, i) => outside(`o${i}`)),
    ];
    const members = new Set(occupants.slice(0, 5).map((o) => o.id));
    expect(occupancyDelimitsMembers(measureBoundaryOccupancy(rect, members, occupants), occupants.length)).toBe(
      boundaryDelimitsMembers(rect, members, occupants)
    );
  });
});

describe("boundaryPurity", () => {
  it("is the share of the box's contents that belongs to it", () => {
    expect(boundaryPurity({ inside: 8, ownInside: 6, ownTotal: 6 })).toBeCloseTo(0.75);
  });

  it("treats an empty box as vacuously pure", () => {
    expect(boundaryPurity({ inside: 0, ownInside: 0, ownTotal: 3 })).toBe(1);
  });
});

/**
 * The contract that replaced overlap suppression. Read alongside
 * resolveLiveBoundaries' own doc comment: a boundary square is a persistent
 * physics object, so nothing about its CURRENT geometry — overlapping a
 * neighbour, being small on screen, having drifted — may ever take it out of
 * the live set. Only its cluster ceasing to exist can.
 */
describe("resolveLiveBoundaries", () => {
  const rect = (x: number, y: number, size = 100) => ({ x, y, width: size, height: size });
  const candidate = (id: string, x: number, members: string[], size = 100): BoundaryCandidate => ({
    id,
    rect: rect(x, 0, size),
    memberIds: new Set(members),
  });
  /** Two tight, well-separated clusters — both boxes pass the concentration gate. */
  const occupants: BoundaryOccupant[] = [
    { id: "a1", x: 50, y: 50 },
    { id: "a2", x: 60, y: 50 },
    { id: "b1", x: 450, y: 50 },
    { id: "b2", x: 460, y: 50 },
  ];
  const a = candidate("a", 0, ["a1", "a2"]);
  const b = candidate("b", 400, ["b1", "b2"]);

  it("admits a candidate that delimits its own cluster", () => {
    const live = new Set<string>();
    resolveLiveBoundaries([a, b], live, occupants, new Set());
    expect([...live].sort()).toEqual(["a", "b"]);
  });

  it("keeps both squares when they overlap — overlap is a collision, not a reason to vanish", () => {
    const live = new Set<string>();
    resolveLiveBoundaries([a, b], live, occupants, new Set());
    // b slides on top of a: deep, unambiguous overlap.
    const overlapping = { ...b, rect: rect(20, 0) };
    resolveLiveBoundaries([a, overlapping], live, occupants, new Set());
    expect([...live].sort()).toEqual(["a", "b"]);
  });

  it("keeps a live square whose box has since stopped delimiting anything", () => {
    const live = new Set<string>();
    resolveLiveBoundaries([a, b], live, occupants, new Set());
    // a's box balloons out to swallow the whole graph — it would never be
    // ADMITTED like this, but having been admitted it must not be revoked.
    const ballooned: BoundaryCandidate = { ...a, rect: { x: -500, y: -500, width: 2000, height: 2000 } };
    resolveLiveBoundaries([ballooned, b], live, occupants, new Set());
    expect(live.has("a")).toBe(true);
  });

  it("refuses to admit a box that has swallowed the whole graph", () => {
    const live = new Set<string>();
    const ballooned: BoundaryCandidate = { ...a, rect: { x: -500, y: -500, width: 2000, height: 2000 } };
    resolveLiveBoundaries([ballooned, b], live, occupants, new Set());
    expect(live.has("a")).toBe(false);
    expect(live.has("b")).toBe(true);
  });

  it("admits a gate-failing box anyway when it is explicitly exempt (selected, or under the pointer)", () => {
    const live = new Set<string>();
    const ballooned: BoundaryCandidate = { ...a, rect: { x: -500, y: -500, width: 2000, height: 2000 } };
    resolveLiveBoundaries([ballooned, b], live, occupants, new Set(["a"]));
    expect(live.has("a")).toBe(true);
  });

  it("drops a square only when its cluster stops being offered at all", () => {
    const live = new Set<string>();
    resolveLiveBoundaries([a, b], live, occupants, new Set());
    resolveLiveBoundaries([a], live, occupants, new Set());
    expect([...live]).toEqual(["a"]);
  });

  it("is stable across repeated frames — the same input never churns the set", () => {
    const live = new Set<string>();
    for (let frame = 0; frame < 10; frame++) resolveLiveBoundaries([a, b], live, occupants, new Set());
    expect([...live].sort()).toEqual(["a", "b"]);
  });

  /**
   * Zoom, expressed as the property that actually broke. The renderer used to
   * build these rects in SCREEN space with a fixed pixel padding, so zooming
   * out shrank the boxes toward pure padding and packed every node inside
   * every box — which changed both the concentration measurement and the
   * overlap contest, and deleted squares. Everything here is world space now,
   * so the decision has to be invariant under a uniform change of scale.
   */
  it("reaches the same decision at any scale — the camera cannot change what exists", () => {
    const scaled = (k: number) => ({
      occupants: occupants.map((o) => ({ ...o, x: o.x * k, y: o.y * k })),
      candidates: [a, b].map((c) => ({
        ...c,
        rect: { x: c.rect.x * k, y: c.rect.y * k, width: c.rect.width * k, height: c.rect.height * k },
      })),
    });
    const liveAt = (k: number) => {
      const { occupants: o, candidates: c } = scaled(k);
      const live = new Set<string>();
      resolveLiveBoundaries(c, live, o, new Set());
      return [...live].sort();
    };
    // A 200x range, far wider than the app's own zoom limits.
    expect(liveAt(0.01)).toEqual(liveAt(1));
    expect(liveAt(2)).toEqual(liveAt(1));
    expect(liveAt(1)).toEqual(["a", "b"]);
  });


  /**
   * A live square whose box has grown large and mostly foreign is still a
   * live square. There is deliberately no rule that takes it away — see the
   * note in collection-layout.ts where a size/purity guard was tried and
   * removed. If such a box reads badly, that is a layout problem to fix in
   * the layout, not by making the boundary vanish.
   */
  it("keeps a live square whose box has sprawled over the graph", () => {
    const live = new Set<string>(["wide"]);
    const spread: BoundaryOccupant[] = Array.from({ length: 20 }, (_, i) => ({
      id: `n${i}`,
      x: (i % 5) * 250,
      y: Math.floor(i / 5) * 330,
    }));
    const wide: BoundaryCandidate = {
      id: "wide",
      rect: { x: -10, y: -10, width: 1020, height: 1020 },
      memberIds: new Set(["n0", "n19"]),
    };
    resolveLiveBoundaries([wide], live, spread, new Set());
    expect(live.has("wide"), "nothing may take a live square away for its geometry").toBe(true);
  });
});
