import { describe, expect, it } from "vitest";
import {
  boundariesShareMembers,
  boundaryPenetration,
  BOUNDARY_MAX_SPEED,
  clampBodyToSandbox,
  releaseVelocity,
  stepBoundaryBodies,
  type BoundaryBody,
} from "./boundary-physics";

function makeBody(
  id: string,
  x: number,
  y: number,
  half = 50,
  memberIds: string[] = [`${id}-tab`]
): BoundaryBody {
  return {
    id,
    memberIds,
    members: new Set(memberIds),
    x,
    y,
    halfWidth: half,
    halfHeight: half,
    vx: 0,
    vy: 0,
    asleep: true,
    dragging: false,
  };
}

function overlaps(a: BoundaryBody, b: BoundaryBody): boolean {
  return (
    Math.abs(a.x - b.x) < a.halfWidth + b.halfWidth - 1 && Math.abs(a.y - b.y) < a.halfHeight + b.halfHeight - 1
  );
}

describe("boundaryPenetration", () => {
  it("reports nothing for boxes that don't touch", () => {
    expect(boundaryPenetration(makeBody("a", 0, 0), makeBody("b", 200, 0))).toBeNull();
    expect(boundaryPenetration(makeBody("a", 0, 0), makeBody("b", 0, 200))).toBeNull();
  });

  it("separates along the axis of least penetration", () => {
    // Deep overlap on y, shallow on x -> resolve on x.
    const mtv = boundaryPenetration(makeBody("a", 0, 0), makeBody("b", 90, 10))!;
    expect(mtv.y).toBe(0);
    expect(mtv.x).toBeCloseTo(10, 5);
  });

  it("points away from the first box", () => {
    expect(boundaryPenetration(makeBody("a", 0, 0), makeBody("b", -90, 0))!.x).toBeLessThan(0);
  });
});

describe("stepBoundaryBodies dragging", () => {
  it("puts the dragged body exactly where the pointer asks when nothing is in the way", () => {
    const a = makeBody("a", 0, 0);
    const deltas = stepBoundaryBodies([a], null, { id: "a", targetX: 120, targetY: -60 });
    expect(a.x).toBeCloseTo(120, 5);
    expect(a.y).toBeCloseTo(-60, 5);
    expect(deltas.get("a")).toEqual({ dx: 120, dy: -60 });
  });

  it("leaves resting bodies completely untouched", () => {
    const a = makeBody("a", 0, 0);
    const b = makeBody("b", 600, 0);
    const deltas = stepBoundaryBodies([a, b], null, { id: "a", targetX: 40, targetY: 0 });
    expect(deltas.has("b")).toBe(false);
    expect(b.x).toBe(600);
    expect(b.asleep).toBe(true);
  });

  it("does nothing at all when nothing is dragged and everything is asleep", () => {
    const a = makeBody("a", 0, 0);
    const b = makeBody("b", 130, 0);
    const deltas = stepBoundaryBodies([a, b], null, null);
    expect(deltas.size).toBe(0);
    expect(a.x).toBe(0);
    expect(b.x).toBe(130);
  });

  it("pushes a body it is dragged into instead of passing through it", () => {
    const a = makeBody("a", 0, 0);
    const b = makeBody("b", 150, 0);
    stepBoundaryBodies([a, b], null, { id: "a", targetX: 130, targetY: 0 });
    expect(overlaps(a, b)).toBe(false);
    expect(b.x).toBeGreaterThan(150);
    // Pointer control wins: the dragged box still lands on its target.
    expect(a.x).toBeCloseTo(130, 5);
  });

  it("does not tunnel through a body when the pointer jumps a long way in one frame", () => {
    const a = makeBody("a", 0, 0);
    const b = makeBody("b", 300, 0);
    stepBoundaryBodies([a, b], null, { id: "a", targetX: 400, targetY: 0 });
    expect(a.x).toBeCloseTo(400, 5);
    expect(overlaps(a, b)).toBe(false);
    expect(b.x).toBeGreaterThan(300);
  });

  it("never merges two boxes, however many times they collide", () => {
    const a = makeBody("a", 0, 0);
    const b = makeBody("b", 150, 0);
    for (let pass = 0; pass < 40; pass++) {
      stepBoundaryBodies([a, b], null, { id: "a", targetX: b.x - 10, targetY: 0 });
      stepBoundaryBodies([a, b], null, { id: "a", targetX: 0, targetY: 0 });
    }
    expect(a.id).toBe("a");
    expect(b.id).toBe("b");
    expect(a.memberIds).toEqual(["a-tab"]);
    expect(b.memberIds).toEqual(["b-tab"]);
    expect(a.halfWidth).toBe(50);
    expect(b.halfWidth).toBe(50);
    expect(overlaps(a, b)).toBe(false);
  });

  it("treats boxes that enclose the same tabs as nested, not colliding", () => {
    const parent = makeBody("parent", 0, 0, 100, ["t1", "t2"]);
    const child = makeBody("child", 0, 0, 30, ["t1"]);
    expect(boundariesShareMembers(parent, child)).toBe(true);
    stepBoundaryBodies([parent, child], null, { id: "parent", targetX: 20, targetY: 0 });
    expect(child.x).toBe(0);
    expect(child.asleep).toBe(true);
  });
});

describe("stepBoundaryBodies settling", () => {
  it("brings a pushed body to a complete stop without bouncing back", () => {
    const a = makeBody("a", 0, 0);
    const b = makeBody("b", 150, 0);
    // Hold the pointer still after the shove, so what's measured is b coasting
    // to rest rather than a being dragged into it again.
    const hold = { id: "a", targetX: 120, targetY: 0 };
    stepBoundaryBodies([a, b], null, hold);
    const shove = b.x - 150;
    const pushedTo = b.x;
    expect(b.asleep).toBe(false);

    for (let frame = 0; frame < 120 && !b.asleep; frame++) stepBoundaryBodies([a, b], null, hold);

    expect(b.asleep).toBe(true);
    expect(b.vx).toBe(0);
    // Coasts forward less than it was shoved, and never rebounds back.
    expect(b.x).toBeGreaterThanOrEqual(pushedTo - 1e-6);
    expect(b.x - pushedTo).toBeLessThan(shove);
  });

  it("caps what a fast flick hands back on release", () => {
    const a = makeBody("a", 0, 0);
    stepBoundaryBodies([a], null, { id: "a", targetX: 5000, targetY: 0 });
    expect(Math.abs(a.vx)).toBeLessThanOrEqual(BOUNDARY_MAX_SPEED);
    expect(Math.abs(releaseVelocity(a).vx)).toBeLessThan(BOUNDARY_MAX_SPEED);
  });
});

describe("clampBodyToSandbox", () => {
  const sandbox = { minX: -500, minY: -300, maxX: 500, maxY: 300 };

  it("keeps a body inside the walls and kills its velocity into them", () => {
    const body = makeBody("a", 900, 0);
    body.vx = 12;
    clampBodyToSandbox(body, sandbox);
    expect(body.x).toBe(450);
    expect(body.vx).toBe(0);
  });

  it("still allows a body right up against an edge", () => {
    const body = makeBody("a", 449, 0);
    clampBodyToSandbox(body, sandbox);
    expect(body.x).toBe(449);
  });

  it("leaves a box larger than the sandbox alone on that axis", () => {
    const body = makeBody("a", 900, 0, 800);
    clampBodyToSandbox(body, sandbox);
    expect(body.x).toBe(900);
  });

  it("holds a dragged body inside the sandbox", () => {
    const a = makeBody("a", 0, 0);
    stepBoundaryBodies([a], sandbox, { id: "a", targetX: 10_000, targetY: 10_000 });
    expect(a.x).toBe(450);
    expect(a.y).toBe(250);
  });
});
