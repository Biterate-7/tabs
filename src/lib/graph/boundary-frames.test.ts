import { describe, expect, it } from "vitest";
import {
  adoptPersistedOffsets,
  buildBoundaryFrames,
  clampFramesWithinParents,
  rigidMove,
  translateFrames,
} from "./boundary-frames";
import type { ClusterAnchorAssignment } from "./clusters";

/**
 * A two-category world with one subdivided category, matching what
 * computePackedClusterAnchors produces:
 *
 *   cat:A  disc (0,0,r=200)   — tabs a1, a2 directly, plus sub:A1's a3, a4
 *   sub:A1 disc (40,0,r=60)   — tabs a3, a4, nested inside cat:A
 *   cat:B  disc (600,0,r=150) — tabs b1, b2
 */
function anchors(): Map<string, ClusterAnchorAssignment> {
  const catA = { x: 0, y: 0, r: 200 };
  const subA1 = { x: 40, y: 0, r: 60 };
  const catB = { x: 600, y: 0, r: 150 };
  const inCategory = (region: typeof catA, id: string): ClusterAnchorAssignment => ({
    categoryAnchor: { x: region.x, y: region.y },
    subcategoryAnchor: null,
    confineTo: region,
    confineToId: id,
    confineWithin: null,
    confineWithinId: null,
  });
  const inSub = (): ClusterAnchorAssignment => ({
    categoryAnchor: { x: catA.x, y: catA.y },
    subcategoryAnchor: { x: subA1.x, y: subA1.y },
    confineTo: subA1,
    confineToId: "sub:A1",
    confineWithin: catA,
    confineWithinId: "cat:A",
  });
  return new Map<string, ClusterAnchorAssignment>([
    ["a1", inCategory(catA, "cat:A")],
    ["a2", inCategory(catA, "cat:A")],
    ["a3", inSub()],
    ["a4", inSub()],
    ["b1", inCategory(catB, "cat:B")],
    ["b2", inCategory(catB, "cat:B")],
  ]);
}

const ALL_TABS = ["a1", "a2", "a3", "a4", "b1", "b2"];

describe("boundary frames", () => {
  it("groups tabs by the disc they are confined to, nesting a subcategory in its category", () => {
    const frames = buildBoundaryFrames(anchors(), ALL_TABS);
    expect([...frames.byId.keys()].sort()).toEqual(["cat:A", "cat:B", "sub:A1"]);
    expect(frames.byId.get("cat:A")!.parentId).toBe(null);
    expect(frames.byId.get("sub:A1")!.parentId).toBe("cat:A");
    // The category's territory is its own tabs plus its subcategory's.
    expect([...frames.byId.get("cat:A")!.allTabs].sort()).toEqual(["a1", "a2", "a3", "a4"]);
    expect([...frames.byId.get("sub:A1")!.allTabs].sort()).toEqual(["a3", "a4"]);
  });

  it("groups by disc geometry when an assignment carries no territory id", () => {
    const region = { x: 10, y: 20, r: 50 };
    const bare = (): ClusterAnchorAssignment => ({
      categoryAnchor: { x: 10, y: 20 },
      subcategoryAnchor: null,
      confineTo: region,
    });
    const frames = buildBoundaryFrames(new Map([["x", bare()], ["y", bare()]]), ["x", "y"]);
    expect(frames.byId.size).toBe(1);
    expect([...frames.byId.values()][0].allTabs.size).toBe(2);
  });

  describe("rigidMove", () => {
    const frames = () => buildBoundaryFrames(anchors(), ALL_TABS);

    it("lets a category move its own territory and every sub-territory in it", () => {
      const move = rigidMove(frames(), new Set(["a1", "a2", "a3", "a4"]));
      expect(move.ok).toBe(true);
      expect(move.frameIds.sort()).toEqual(["cat:A", "sub:A1"]);
    });

    it("lets a subcategory move its own territory without carrying its parent's", () => {
      const move = rigidMove(frames(), new Set(["a3", "a4"]));
      expect(move.ok).toBe(true);
      expect(move.frameIds).toEqual(["sub:A1"]);
    });

    it("refuses a square that holds only part of a territory", () => {
      // The shape of a Collection cutting across categories: one tab from A,
      // one from B, neither territory whole. Moving it would leave a1/a2 and
      // b2 behind — which is what stretched their boxes across the gap.
      expect(rigidMove(frames(), new Set(["a3", "b1"])).ok).toBe(false);
      expect(rigidMove(frames(), new Set(["a1"])).ok).toBe(false);
      expect(rigidMove(frames(), new Set(["a3"])).ok).toBe(false);
    });

    it("refuses a square holding a category's own tabs but not its subcategory's", () => {
      expect(rigidMove(frames(), new Set(["a1", "a2"])).ok).toBe(false);
    });

    it("lets a square move tabs the layout reserved no ground for", () => {
      const move = rigidMove(frames(), new Set(["untethered-1", "untethered-2"]));
      expect(move.ok).toBe(true);
      expect(move.frameIds).toEqual([]);
    });
  });

  describe("containment", () => {
    it("keeps a nested disc inside its parent's, however far it is pushed", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      translateFrames(frames, ["sub:A1"], 5000, 0);
      expect(clampFramesWithinParents(frames)).toBe(true);

      const sub = frames.byId.get("sub:A1")!;
      const parent = frames.byId.get("cat:A")!;
      const distance = Math.hypot(
        sub.region.x + sub.offset.dx - (parent.region.x + parent.offset.dx),
        sub.region.y + sub.offset.dy - (parent.region.y + parent.offset.dy)
      );
      expect(distance).toBeLessThanOrEqual(parent.region.r - sub.region.r + 1e-6);
    });

    it("leaves a nested disc alone when its parent travels with it", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      translateFrames(frames, ["cat:A", "sub:A1"], 5000, -3000);
      expect(clampFramesWithinParents(frames)).toBe(false);
      expect(frames.byId.get("sub:A1")!.offset).toEqual({ dx: 5000, dy: -3000 });
    });
  });

  describe("persisted offsets", () => {
    it("carries a whole territory's saved displacement back", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        frames,
        new Map([
          ["b1", { dx: 120, dy: -80 }],
          ["b2", { dx: 120, dy: -80 }],
        ])
      );
      expect(frames.byId.get("cat:B")!.offset).toEqual({ dx: 120, dy: -80 });
    });

    it("re-unites a torn territory on where MOST of it sat, not on the mean", () => {
      // Exactly the shape of state written by the build that displaced tabs
      // one at a time: a few members carried far away, the rest left behind,
      // so a reload used to restore the split — and with it the stretched box.
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        frames,
        new Map([
          ["a1", { dx: 3000, dy: 0 }],
          ["a2", { dx: 0, dy: 0 }],
          ["b1", { dx: 3000, dy: 0 }],
          ["b2", { dx: 0, dy: 0 }],
        ])
      );
      // cat:A's own tabs are a1/a2 (a3/a4 belong to the subcategory), so this
      // is a 1-1 tie: it resolves toward home rather than to the 1500 that a
      // mean would give, which is a place neither tab was ever at.
      expect(frames.byId.get("cat:A")!.offset).toEqual({ dx: 0, dy: 0 });
      expect(frames.byId.get("cat:B")!.offset).toEqual({ dx: 0, dy: 0 });
    });

    it("keeps the majority where it is and brings the strays back to it", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      // Three of cat:B's four members agree on a real move; one was carried
      // off by the old boundary layer. The move survives; the stray returns.
      const wide = anchors();
      const catB = { x: 600, y: 0, r: 150 };
      for (const id of ["b3", "b4"]) {
        wide.set(id, {
          categoryAnchor: { x: catB.x, y: catB.y },
          subcategoryAnchor: null,
          confineTo: catB,
          confineToId: "cat:B",
          confineWithin: null,
          confineWithinId: null,
        });
      }
      const wider = buildBoundaryFrames(wide, [...ALL_TABS, "b3", "b4"]);
      adoptPersistedOffsets(
        wider,
        new Map([
          ["b1", { dx: 800, dy: -200 }],
          ["b2", { dx: 800, dy: -200 }],
          ["b3", { dx: 800, dy: -200 }],
          ["b4", { dx: 4000, dy: 2500 }],
        ])
      );
      expect(wider.byId.get("cat:B")!.offset).toEqual({ dx: 800, dy: -200 });
      void frames;
    });

    it("is idempotent — repairing an already-repaired record changes nothing", () => {
      const first = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        first,
        new Map([
          ["b1", { dx: 3000, dy: 0 }],
          ["b2", { dx: 3000, dy: 0 }],
        ])
      );
      const repaired = first.byId.get("cat:B")!.offset;
      expect(repaired).toEqual({ dx: 3000, dy: 0 });

      const second = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        second,
        new Map([
          ["b1", { ...repaired }],
          ["b2", { ...repaired }],
        ])
      );
      expect(second.byId.get("cat:B")!.offset).toEqual(repaired);
    });

    it("treats settle noise within the disc as agreement, not as a second group", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        frames,
        new Map([
          ["b1", { dx: 500, dy: 0 }],
          ["b2", { dx: 512, dy: 4 }],
        ])
      );
      const offset = frames.byId.get("cat:B")!.offset;
      expect(offset.dx).toBeCloseTo(506, 5);
      expect(offset.dy).toBeCloseTo(2, 5);
    });

    it("restores a subcategory's saved move without shifting its parent's disc", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        frames,
        new Map([
          ["a3", { dx: 100, dy: 0 }],
          ["a4", { dx: 100, dy: 0 }],
          ["a1", { dx: 0, dy: 0 }],
          ["a2", { dx: 0, dy: 0 }],
        ])
      );
      expect(frames.byId.get("sub:A1")!.offset).toEqual({ dx: 100, dy: 0 });
      // The category's own tabs never moved, so neither does its disc.
      expect(frames.byId.get("cat:A")!.offset).toEqual({ dx: 0, dy: 0 });
    });

    it("lets a category with no direct tabs follow the subcategories it contains", () => {
      const withoutDirectTabs = anchors();
      withoutDirectTabs.delete("a1");
      withoutDirectTabs.delete("a2");
      const frames = buildBoundaryFrames(withoutDirectTabs, ["a3", "a4", "b1", "b2"]);
      adoptPersistedOffsets(
        frames,
        new Map([
          ["a3", { dx: 70, dy: 30 }],
          ["a4", { dx: 70, dy: 30 }],
        ])
      );
      expect(frames.byId.get("sub:A1")!.offset).toEqual({ dx: 70, dy: 30 });
      expect(frames.byId.get("cat:A")!.offset).toEqual({ dx: 70, dy: 30 });
      // …and the restored nesting is legal, so nothing is dragged back.
      expect(clampFramesWithinParents(frames)).toBe(false);
    });

    it("never overwrites a territory already moved this session", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      translateFrames(frames, ["cat:B"], 90, 0);
      adoptPersistedOffsets(frames, new Map([["b1", { dx: -500, dy: -500 }]]));
      expect(frames.byId.get("cat:B")!.offset).toEqual({ dx: 90, dy: 0 });
    });

    it("ignores a non-finite saved offset instead of poisoning the disc", () => {
      const frames = buildBoundaryFrames(anchors(), ALL_TABS);
      adoptPersistedOffsets(
        frames,
        new Map([
          ["b1", { dx: Number.NaN, dy: 0 }],
          ["b2", { dx: 60, dy: 0 }],
        ])
      );
      expect(frames.byId.get("cat:B")!.offset).toEqual({ dx: 60, dy: 0 });
    });
  });

  it("carries offsets across a rebuild, so a recategorized tab never undoes a move", () => {
    const first = buildBoundaryFrames(anchors(), ALL_TABS);
    translateFrames(first, ["cat:B"], 250, 25);
    const second = buildBoundaryFrames(anchors(), [...ALL_TABS, "b3"], first);
    expect(second.byId.get("cat:B")!.offset).toEqual({ dx: 250, dy: 25 });
  });

  it("drops a territory whose tabs have all left the graph", () => {
    const frames = buildBoundaryFrames(anchors(), ["a1", "a2", "a3", "a4"]);
    expect(frames.byId.has("cat:B")).toBe(false);
  });
});
