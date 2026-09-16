import { describe, expect, it } from "vitest";
import {
  CHARACTER_HEIGHT_UNITS,
  CHARACTER_WIDTH_UNITS,
  HALF_HEIGHT,
  HALF_WIDTH,
  ORIGIN_X,
  ORIGIN_Y,
  STAGE_HEIGHT,
  STAGE_WIDTH,
  boundsOverlap,
  boxFaces,
  isOnFloor,
  planDepth,
  projectPlan,
  projectPlanNormalized,
  projectRect,
  projectedBounds,
  rectPoints,
} from "./projection";

/**
 * The projection is the one piece of maths the whole world rests on: a room's
 * walls, a figure's feet and a handoff line all come out of it, so a sign
 * error here is not a visual bug in one component but a world that does not
 * agree with itself.
 */

describe("the isometric transform", () => {
  it("puts the far corner at the top and the near corner at the bottom", () => {
    // The camera looks at the floor from over plan (1, 1). Everything else in
    // the world — paint order, occlusion, which faces of a box are drawn —
    // follows from this one fact.
    const far = projectPlan(0, 0);
    const near = projectPlan(1, 1);

    expect(far).toEqual({ x: ORIGIN_X, y: ORIGIN_Y });
    expect(near.x).toBe(ORIGIN_X);
    expect(near.y).toBeGreaterThan(far.y);
  });

  it("sends the two floor axes to opposite sides of the stage", () => {
    expect(projectPlan(1, 0).x).toBeGreaterThan(ORIGIN_X);
    expect(projectPlan(0, 1).x).toBeLessThan(ORIGIN_X);
    // Both still move down the stage: every step away from the far corner is
    // a step towards the viewer.
    expect(projectPlan(1, 0).y).toBeGreaterThan(ORIGIN_Y);
    expect(projectPlan(0, 1).y).toBeGreaterThan(ORIGIN_Y);
  });

  it("keeps the whole floor inside the stage, with headroom above it", () => {
    for (const [x, y] of [
      [0, 0],
      [1, 0],
      [0, 1],
      [1, 1],
      [0.5, 0.5],
    ]) {
      const point = projectPlan(x, y);
      expect(point.x).toBeGreaterThanOrEqual(0);
      expect(point.x).toBeLessThanOrEqual(STAGE_WIDTH);
      expect(point.y).toBeGreaterThanOrEqual(0);
      expect(point.y).toBeLessThanOrEqual(STAGE_HEIGHT);
    }

    // The space above the far corner is where anything with height goes. A
    // projection that filled the box would have nowhere to put a tower.
    expect(ORIGIN_Y).toBeGreaterThan(CHARACTER_HEIGHT_UNITS * 3);
  });

  it("draws a square room as a square, not a lozenge", () => {
    // Both reference images use a 2:1 isometric. Much flatter and a square
    // room reads as a corridor.
    expect(HALF_WIDTH / HALF_HEIGHT).toBeGreaterThan(1.6);
    expect(HALF_WIDTH / HALF_HEIGHT).toBeLessThan(2.4);
  });

  it("normalises to the same point the stage draws", () => {
    const point = projectPlan(0.3, 0.7);
    expect(projectPlanNormalized(0.3, 0.7)).toEqual({
      x: point.x / STAGE_WIDTH,
      y: point.y / STAGE_HEIGHT,
    });
  });

  it("makes depth and screen height the same ordering", () => {
    // What licenses the painter's algorithm in the scenery renderer: a thing
    // drawn lower down is nearer, so painting in depth order and painting in
    // stage order are the same pass.
    const points: [number, number][] = [
      [0.1, 0.1],
      [0.9, 0.1],
      [0.4, 0.4],
      [0.8, 0.8],
    ];
    const byDepth = [...points].sort((a, b) => planDepth(...a) - planDepth(...b));
    const byScreen = [...points].sort((a, b) => projectPlan(...a).y - projectPlan(...b).y);

    expect(byDepth).toEqual(byScreen);
  });
});

describe("shapes", () => {
  it("projects a rectangle to four corners in draw order", () => {
    const corners = projectRect(0.2, 0.3, 0.1, 0.2);
    expect(corners).toHaveLength(4);
    expect(corners[0]).toEqual(projectPlan(0.2, 0.3));
    expect(corners[2]).toEqual(projectPlan(0.3, 0.5));
  });

  it("writes a polygon's points as pairs the SVG can take", () => {
    const points = rectPoints(0, 0, 1, 1).split(" ");
    expect(points).toHaveLength(4);
    for (const point of points) expect(point).toMatch(/^-?\d+(\.\d+)?,-?\d+(\.\d+)?$/);
  });

  it("lifts a polygon by a height without moving it sideways", () => {
    const flat = rectPoints(0.1, 0.1, 0.2, 0.2).split(" ");
    const lifted = rectPoints(0.1, 0.1, 0.2, 0.2, 40).split(" ");

    for (let index = 0; index < flat.length; index += 1) {
      const [flatX, flatY] = flat[index].split(",").map(Number);
      const [liftedX, liftedY] = lifted[index].split(",").map(Number);
      expect(liftedX).toBe(flatX);
      expect(liftedY).toBeCloseTo(flatY - 40, 5);
    }
  });

  it("draws only the two faces of a box the camera can see", () => {
    const faces = boxFaces(0.2, 0.2, 0.2, 0.2, 30);
    expect(Object.keys(faces).sort()).toEqual(["left", "right", "top"]);
    for (const face of Object.values(faces)) {
      expect(face.split(" ")).toHaveLength(4);
    }
  });

  it("puts a box's top face above its base by exactly its height", () => {
    const base = projectPlan(0.2, 0.2);
    const top = boxFaces(0.2, 0.2, 0.2, 0.2, 30).top.split(" ")[0].split(",").map(Number);
    expect(top[0]).toBeCloseTo(base.x, 5);
    expect(top[1]).toBeCloseTo(base.y - 30, 5);
  });
});

describe("bounds", () => {
  it("grows a rectangle's box upward by its height and not downward", () => {
    const flat = projectedBounds(0.3, 0.3, 0.2, 0.2);
    const tall = projectedBounds(0.3, 0.3, 0.2, 0.2, 50);

    expect(tall.minY).toBeCloseTo(flat.minY - 50, 5);
    expect(tall.maxY).toBeCloseTo(flat.maxY, 5);
    expect(tall.minX).toBeCloseTo(flat.minX, 5);
  });

  it("reports overlap only when two boxes actually intersect", () => {
    const a = { minX: 0, maxX: 10, minY: 0, maxY: 10 };
    expect(boundsOverlap(a, { minX: 5, maxX: 15, minY: 5, maxY: 15 })).toBe(true);
    expect(boundsOverlap(a, { minX: 10, maxX: 20, minY: 0, maxY: 10 })).toBe(false);
    expect(boundsOverlap(a, { minX: 0, maxX: 10, minY: 11, maxY: 20 })).toBe(false);
  });
});

describe("the floor", () => {
  it("accepts the unit square and rejects everything outside it", () => {
    expect(isOnFloor(0, 0)).toBe(true);
    expect(isOnFloor(1, 1)).toBe(true);
    expect(isOnFloor(0.5, 0.5)).toBe(true);
    // Scenery is allowed out here — a skyline stands behind the deck — but a
    // station out here would put an agent in mid-air.
    expect(isOnFloor(-0.2, 0.5)).toBe(false);
    expect(isOnFloor(0.5, 1.2)).toBe(false);
  });
});

describe("the figure", () => {
  it("keeps a character's width tied to its height", () => {
    // A figure is drawn from one 40x48 viewBox, so its width is not an
    // independent number to be tuned — and the layout's separation guarantee
    // is calibrated against both.
    expect(CHARACTER_WIDTH_UNITS).toBeCloseTo((CHARACTER_HEIGHT_UNITS * 40) / 48, 5);
  });

  it("is small enough that a room holds several and large enough to read", () => {
    expect(CHARACTER_HEIGHT_UNITS).toBeGreaterThan(20);
    expect(CHARACTER_HEIGHT_UNITS).toBeLessThan(HALF_HEIGHT / 4);
  });
});
