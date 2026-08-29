import { describe, expect, it } from "vitest";
import { clampZoom, computeFitCamera, screenToWorld, worldToScreen, zoomAroundPoint } from "./layout";

describe("screenToWorld / worldToScreen", () => {
  it("round-trips a point through the camera transform", () => {
    const camera = { x: 10, y: -5, zoom: 2 };
    const world = { x: 42, y: 17 };
    const screen = worldToScreen(camera, world, 800, 600);
    const back = screenToWorld(camera, screen, 800, 600);
    expect(back.x).toBeCloseTo(world.x);
    expect(back.y).toBeCloseTo(world.y);
  });
});

describe("clampZoom", () => {
  it("clamps to the configured bounds", () => {
    expect(clampZoom(100)).toBeLessThanOrEqual(4);
    expect(clampZoom(-5)).toBeGreaterThan(0);
  });
});

describe("zoomAroundPoint", () => {
  it("keeps the world point under the anchor fixed on screen", () => {
    const camera = { x: 0, y: 0, zoom: 1 };
    const anchor = { x: 500, y: 300 };
    const worldUnderAnchorBefore = screenToWorld(camera, anchor, 1000, 600);

    const next = zoomAroundPoint(camera, anchor, 2, 1000, 600);
    const worldUnderAnchorAfter = screenToWorld(next, anchor, 1000, 600);

    expect(worldUnderAnchorAfter.x).toBeCloseTo(worldUnderAnchorBefore.x);
    expect(worldUnderAnchorAfter.y).toBeCloseTo(worldUnderAnchorBefore.y);
    expect(next.zoom).toBe(2);
  });
});

describe("computeFitCamera", () => {
  it("frames every point within the viewport", () => {
    const points = [
      { x: -100, y: 0, radius: 5 },
      { x: 100, y: 0, radius: 5 },
      { x: 0, y: 50, radius: 5 },
    ];
    const camera = computeFitCamera(points, 800, 600);
    expect(camera.x).toBeCloseTo(0);
    expect(camera.zoom).toBeGreaterThan(0);
  });

  it("falls back to the default camera with no points", () => {
    const camera = computeFitCamera([], 800, 600);
    expect(camera).toEqual({ x: 0, y: 0, zoom: 1 });
  });
});
