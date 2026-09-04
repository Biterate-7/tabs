import { describe, expect, it } from "vitest";
import { computeCollectionBoundary, pointInRect, rectsOverlap, selectNonOverlappingRects } from "./collection-layout";

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

describe("selectNonOverlappingRects", () => {
  // Reproduces the real failure this guards against: category/subcategory
  // boundary boxes drawn unconditionally, as graph-canvas.tsx used to, would
  // stack two overlapping translucent rects on screen — which is exactly
  // what the reported bug's screenshot showed. Before this function existed,
  // nothing suppressed the second draw.
  it("drops a later rect that overlaps an earlier (higher-priority) one", () => {
    const entries = [
      { id: "big", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "small", rect: { x: 50, y: 50, width: 100, height: 100 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("big")).toBe(true);
    expect(drawable.has("small")).toBe(false);
  });

  it("keeps every rect when none overlap", () => {
    const entries = [
      { id: "a", rect: { x: 0, y: 0, width: 10, height: 10 } },
      { id: "b", rect: { x: 100, y: 100, width: 10, height: 10 } },
      { id: "c", rect: { x: 200, y: 200, width: 10, height: 10 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.size).toBe(3);
  });

  it("never suppresses alwaysDrawId even when it overlaps an earlier rect (evicting that earlier rect instead)", () => {
    const entries = [
      { id: "big", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "selected", rect: { x: 50, y: 50, width: 100, height: 100 } },
    ];
    const drawable = selectNonOverlappingRects(entries, "selected");
    expect(drawable.has("selected")).toBe(true);
    // "big" is evicted, not left drawn alongside "selected" — the two rects
    // overlap and neither is exempt, so keeping both would be exactly the
    // visible crossing this function exists to prevent. See the dedicated
    // "always-drawn entries evict conflicting bystanders" tests below.
    expect(drawable.has("big")).toBe(false);
  });

  it("lets a rect overlapping only a suppressed rect still draw (transitively takes over its spot)", () => {
    // a suppresses b (overlap), b would have suppressed c, but since b never
    // actually draws, c should be judged only against what's really on screen (a).
    const entries = [
      { id: "a", rect: { x: 0, y: 0, width: 100, height: 100 } },
      { id: "b", rect: { x: 90, y: 0, width: 100, height: 100 } },
      { id: "c", rect: { x: 300, y: 300, width: 10, height: 10 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("a")).toBe(true);
    expect(drawable.has("b")).toBe(false);
    expect(drawable.has("c")).toBe(true);
  });

  it("treats identical-position rects the same as any other overlap: only the first survives", () => {
    const entries = [
      { id: "first", rect: { x: 10, y: 10, width: 50, height: 50 } },
      { id: "duplicate", rect: { x: 10, y: 10, width: 50, height: 50 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("first")).toBe(true);
    expect(drawable.has("duplicate")).toBe(false);
  });

  // Priority is deliberately a function of *input order*, not id, size, or
  // any other rect property — the contract (see the function's doc comment)
  // is that the caller supplies entries already sorted by priority (weight
  // desc in graph-canvas.tsx). This test locks that contract in: the same
  // two overlapping rects produce the opposite winner when the caller's
  // order is reversed, so a regression that started ignoring input order
  // (e.g. sorting by id internally) would be caught here.
  it("is driven entirely by input order, not id or any property of the rect", () => {
    const rectA = { x: 0, y: 0, width: 100, height: 100 };
    const rectB = { x: 50, y: 50, width: 100, height: 100 };

    const drawableWhenAFirst = selectNonOverlappingRects(
      [
        { id: "a", rect: rectA },
        { id: "b", rect: rectB },
      ],
      null
    );
    expect(drawableWhenAFirst.has("a")).toBe(true);
    expect(drawableWhenAFirst.has("b")).toBe(false);

    const drawableWhenBFirst = selectNonOverlappingRects(
      [
        { id: "b", rect: rectB },
        { id: "a", rect: rectA },
      ],
      null
    );
    expect(drawableWhenBFirst.has("b")).toBe(true);
    expect(drawableWhenBFirst.has("a")).toBe(false);
  });

  it("never lets a lower-priority (later) rect suppress a higher-priority (earlier) one", () => {
    // Encodes the "a category with many nodes must never disappear just
    // because a smaller one happens to be processed first" invariant —
    // guaranteed here because graph-canvas.tsx always feeds entries in
    // weight-desc order, so "earlier" always means "bigger/more populated."
    const entries = [
      { id: "many-nodes", rect: { x: 0, y: 0, width: 200, height: 200 } },
      { id: "few-nodes", rect: { x: 100, y: 100, width: 200, height: 200 } },
    ];
    const drawable = selectNonOverlappingRects(entries, null);
    expect(drawable.has("many-nodes")).toBe(true);
  });

  // Regression coverage for the Category/Subcategory cross-tier overlap that
  // survived the first same-tier-only suppression fix: a Subcategory's ring
  // sits around its own parent Category's anchor at an arbitrary angle (see
  // clusters.ts's computeClusterAnchors), so its bounding box can reach into
  // a completely unrelated Category's box. That's unintended overlap and
  // must be suppressed same as any other; only the intentional
  // parent-inside-its-own-parent nesting should be exempt.
  describe("isExemptOverlap (cross-tier nesting)", () => {
    it("suppresses an overlap between unrelated rects even when a predicate is supplied", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "sub-of-cat-b", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      // Predicate present, but this pair isn't parent/child — still suppressed.
      const drawable = selectNonOverlappingRects(entries, null, () => false);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("sub-of-cat-b")).toBe(false);
    });

    it("draws both members of an exempt (parent/child) pair even though their rects overlap", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "sub-of-cat-a", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const isParentChild = (a: string, b: string) =>
        (a === "cat-a" && b === "sub-of-cat-a") || (a === "sub-of-cat-a" && b === "cat-a");
      const drawable = selectNonOverlappingRects(entries, null, isParentChild);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("sub-of-cat-a")).toBe(true);
    });

    it("still suppresses a third, unrelated rect that overlaps only the exempt pair", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "sub-of-cat-a", rect: { x: 50, y: 50, width: 100, height: 100 } },
        { id: "cat-b", rect: { x: 60, y: 60, width: 100, height: 100 } },
      ];
      const isParentChild = (a: string, b: string) =>
        (a === "cat-a" && b === "sub-of-cat-a") || (a === "sub-of-cat-a" && b === "cat-a");
      const drawable = selectNonOverlappingRects(entries, null, isParentChild);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("sub-of-cat-a")).toBe(true);
      expect(drawable.has("cat-b")).toBe(false);
    });

    it("omitting the predicate keeps the old all-pairs-mutually-exclusive behavior", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "sub-of-cat-a", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, null);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("sub-of-cat-a")).toBe(false);
    });
  });

  // Regression coverage for the Collection<->Category/Subcategory overlap
  // discovered after the Category<->Subcategory fix: Collections share the
  // exact same computeCollectionBoundary/drawCollectionBoundary pipeline but
  // were suppressed only against other Collections, never against a
  // Category/Subcategory box they happen to cross — measured live to be a
  // genuine PARTIAL overlap (a Collection box's edge extending outside a
  // Category box's edge, not clean containment), the same visually-crossing
  // mesh the Category<->Subcategory fix exists to prevent, one tier over.
  // The fix folds all three tiers into one combined pass; a Collection gets
  // no automatic exemption merely for being a Collection — only an actual
  // tree parent/child relationship (its own majority-parent Category, same
  // as a Subcategory's parent) is exempt.
  describe("mixed Category/Subcategory/Collection suppression", () => {
    it("suppresses a Collection that overlaps an unrelated Category, same as any other unintended overlap", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "coll-x", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, null, () => false);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("coll-x")).toBe(false);
    });

    it("draws a Collection nested inside its own majority-parent Category even though the rects overlap", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "coll-x", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const isTreeParentChild = (a: string, b: string) =>
        (a === "cat-a" && b === "coll-x") || (a === "coll-x" && b === "cat-a");
      const drawable = selectNonOverlappingRects(entries, null, isTreeParentChild);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("coll-x")).toBe(true);
    });

    it("does not exempt a Collection against a Category/Subcategory that isn't its own tree parent", () => {
      const entries = [
        { id: "cat-a", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "coll-x", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      // coll-x's real parent is "cat-b" (not present here) — cat-a is a
      // stranger to it, so the predicate correctly returns false for this pair.
      const isTreeParentChild = (a: string, b: string) =>
        (a === "cat-b" && b === "coll-x") || (a === "coll-x" && b === "cat-b");
      const drawable = selectNonOverlappingRects(entries, null, isTreeParentChild);
      expect(drawable.has("cat-a")).toBe(true);
      expect(drawable.has("coll-x")).toBe(false);
    });

    it("keeps Collections mutually exclusive of each other within the combined pass", () => {
      const entries = [
        { id: "coll-big", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "coll-small", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, null);
      expect(drawable.has("coll-big")).toBe(true);
      expect(drawable.has("coll-small")).toBe(false);
    });

    it("a dense mix of Category, Subcategory, and Collection rects produces zero unintended overlaps among the drawn set", () => {
      // Mirrors the real bug: a dominant Category (cat-0) whose box spans
      // most of the area, its own Subcategory nested inside it, and several
      // small Collections scattered so some overlap cat-0 and some don't.
      const entries: { id: string; rect: { x: number; y: number; width: number; height: number } }[] = [
        { id: "cat-0", rect: { x: 0, y: 0, width: 400, height: 400 } },
        { id: "sub-0-a", rect: { x: 50, y: 50, width: 150, height: 150 } }, // nested in cat-0
        { id: "coll-1", rect: { x: 350, y: 350, width: 100, height: 100 } }, // overlaps cat-0's corner
        { id: "coll-2", rect: { x: 500, y: 500, width: 80, height: 80 } }, // clear of everything
        { id: "coll-3", rect: { x: 520, y: 520, width: 80, height: 80 } }, // overlaps coll-2
      ];
      const parentOf: Record<string, string | null> = {
        "cat-0": null,
        "sub-0-a": "cat-0",
        "coll-1": "cat-0",
        "coll-2": null,
        "coll-3": null,
      };
      const isParentChild = (a: string, b: string) => parentOf[a] === b || parentOf[b] === a;
      const drawable = selectNonOverlappingRects(entries, null, isParentChild);

      // cat-0 and its real nested child both survive.
      expect(drawable.has("cat-0")).toBe(true);
      expect(drawable.has("sub-0-a")).toBe(true);
      // coll-1 is exempt against cat-0 (its own parent) despite overlapping it.
      expect(drawable.has("coll-1")).toBe(true);
      // coll-2 and coll-3 overlap each other and aren't exempt — only one survives.
      expect(drawable.has("coll-2")).toBe(true);
      expect(drawable.has("coll-3")).toBe(false);

      // Zero unintended overlaps among whatever ends up drawn.
      const drawnRects = entries.filter((e) => drawable.has(e.id));
      for (let i = 0; i < drawnRects.length; i++) {
        for (let j = i + 1; j < drawnRects.length; j++) {
          const a = drawnRects[i];
          const b = drawnRects[j];
          const overlap = rectsOverlap(a.rect, b.rect);
          if (overlap) expect(isParentChild(a.id, b.id)).toBe(true);
        }
      }
    });
  });

  describe("alwaysDrawId as a Set (multiple independent selections)", () => {
    it("exempts every id in the Set from suppressing each other, e.g. a selected cluster AND a separately selected collection", () => {
      const entries = [
        { id: "selected-cluster", rect: { x: 20, y: 20, width: 100, height: 100 } },
        { id: "selected-collection", rect: { x: 40, y: 40, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, new Set(["selected-cluster", "selected-collection"]));
      expect(drawable.has("selected-cluster")).toBe(true);
      expect(drawable.has("selected-collection")).toBe(true);
    });

    it("an empty Set exempts nothing, same as null", () => {
      const entries = [
        { id: "big", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "small", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, new Set());
      expect(drawable.has("big")).toBe(true);
      expect(drawable.has("small")).toBe(false);
    });
  });

  // Regression coverage for a real bug found while auditing the combined
  // Category/Subcategory/Collection suppression pass: a higher-priority,
  // unrelated rect drawn BEFORE a selected one used to stay on screen even
  // though the always-draw exemption then forced the selected rect to draw
  // on top of it — satisfying "selected boundaries must remain visible" at
  // the direct expense of "unrelated boundaries must never visually cross".
  // Measured on a ~280-tab synthetic dataset: selecting any non-dominant
  // Category/Subcategory/Collection produced a real, visible crossing
  // (overlap area up to 100% of the smaller rect) with whichever unrelated
  // rect had already won the draw. The fix: an always-drawn entry evicts
  // any non-exempt, non-always-drawn rect it conflicts with instead of
  // merely drawing alongside it.
  describe("always-drawn entries evict conflicting bystanders (no forced crossing)", () => {
    it("evicts an unrelated higher-priority rect that already overlaps the selected one", () => {
      const entries = [
        { id: "big-unselected", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "selected", rect: { x: 20, y: 20, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, "selected");
      expect(drawable.has("selected")).toBe(true);
      expect(drawable.has("big-unselected")).toBe(false);
    });

    it("does not evict a bystander that doesn't actually overlap the selected rect", () => {
      const entries = [
        { id: "far-away", rect: { x: 1000, y: 1000, width: 50, height: 50 } },
        { id: "selected", rect: { x: 0, y: 0, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, "selected");
      expect(drawable.has("selected")).toBe(true);
      expect(drawable.has("far-away")).toBe(true);
    });

    it("does not evict a bystander the selected rect overlaps only via an exempt (parent/child) relationship", () => {
      const entries = [
        { id: "parent", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "selected-child", rect: { x: 20, y: 20, width: 100, height: 100 } },
      ];
      const isParentChild = (a: string, b: string) => (a === "parent" && b === "selected-child") || (a === "selected-child" && b === "parent");
      const drawable = selectNonOverlappingRects(entries, "selected-child", isParentChild);
      expect(drawable.has("parent")).toBe(true);
      expect(drawable.has("selected-child")).toBe(true);
    });

    it("never evicts another always-drawn entry — two simultaneous selections may still cross each other", () => {
      const entries = [
        { id: "selected-cluster", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "selected-collection", rect: { x: 50, y: 50, width: 100, height: 100 } },
      ];
      const drawable = selectNonOverlappingRects(entries, new Set(["selected-cluster", "selected-collection"]));
      expect(drawable.has("selected-cluster")).toBe(true);
      expect(drawable.has("selected-collection")).toBe(true);
    });

    it("a bystander evicted to make room for one selection is not resurrected by a later, unrelated selection", () => {
      const entries = [
        { id: "bystander", rect: { x: 0, y: 0, width: 100, height: 100 } },
        { id: "selected-a", rect: { x: 20, y: 20, width: 100, height: 100 } },
        { id: "selected-b", rect: { x: 500, y: 500, width: 50, height: 50 } },
      ];
      const drawable = selectNonOverlappingRects(entries, new Set(["selected-a", "selected-b"]));
      expect(drawable.has("selected-a")).toBe(true);
      expect(drawable.has("selected-b")).toBe(true);
      expect(drawable.has("bystander")).toBe(false);
    });

    // Distinct from the case above: here the bystander overlaps BOTH
    // simultaneous selections (not just one) — e.g. a selected cluster and a
    // separately selected collection whose boxes both happen to cross a
    // third, unrelated category nobody selected. Both selections must
    // survive and the bystander must be evicted regardless of which
    // selection's turn in priority order triggers the eviction.
    it("evicts a bystander that overlaps both of two simultaneous selections", () => {
      const entries = [
        { id: "bystander", rect: { x: 0, y: 0, width: 200, height: 200 } },
        { id: "selected-a", rect: { x: 10, y: 10, width: 50, height: 50 } },
        { id: "selected-b", rect: { x: 100, y: 100, width: 50, height: 50 } },
      ];
      const drawable = selectNonOverlappingRects(entries, new Set(["selected-a", "selected-b"]));
      expect(drawable.has("selected-a")).toBe(true);
      expect(drawable.has("selected-b")).toBe(true);
      expect(drawable.has("bystander")).toBe(false);
    });
  });
});
