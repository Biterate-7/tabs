import { DEFAULT_CAMERA, type CameraState } from "./types";

export type Point = { x: number; y: number };

export const ZOOM_MIN = 0.08;
export const ZOOM_MAX = 4;

export function clampZoom(zoom: number): number {
  return Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, zoom));
}

export function screenToWorld(camera: CameraState, screen: Point, width: number, height: number): Point {
  return {
    x: (screen.x - width / 2) / camera.zoom + camera.x,
    y: (screen.y - height / 2) / camera.zoom + camera.y,
  };
}

export function worldToScreen(camera: CameraState, world: Point, width: number, height: number): Point {
  return {
    x: (world.x - camera.x) * camera.zoom + width / 2,
    y: (world.y - camera.y) * camera.zoom + height / 2,
  };
}

/** Zooms to `nextZoom` while keeping the world point under `anchor` (the cursor) fixed on screen, instead of the whole canvas scaling around its center. */
export function zoomAroundPoint(
  camera: CameraState,
  anchor: Point,
  nextZoom: number,
  width: number,
  height: number
): CameraState {
  const clamped = clampZoom(nextZoom);
  const worldBefore = screenToWorld(camera, anchor, width, height);
  const naive: CameraState = { ...camera, zoom: clamped };
  const worldAfter = screenToWorld(naive, anchor, width, height);
  return {
    zoom: clamped,
    x: camera.x + (worldBefore.x - worldAfter.x),
    y: camera.y + (worldBefore.y - worldAfter.y),
  };
}

export type BoundedPoint = { x: number; y: number; radius: number };

/** Computes the camera that frames every point (with its radius) inside the viewport, with `padding` screen pixels of margin. Falls back to the default camera when there's nothing to frame. */
export function computeFitCamera(
  points: BoundedPoint[],
  width: number,
  height: number,
  padding = 64,
  /**
   * Width of chrome overlaying the canvas's right edge — the graph panel.
   *
   * The canvas element runs the full width of the view and the panel floats
   * on top of it, so "fit" used to centre the graph across a region a
   * 288px-wide panel was covering the right quarter of: on open, the
   * right-hand clusters sat underneath it and the leftmost nodes ran off
   * the other edge. Fitting to the *visible* region instead is the same
   * calculation with a narrower box and an offset centre.
   *
   * Not folded into `padding` because padding is symmetric and this is not:
   * the space is missing from one side only, and the camera has to move to
   * compensate as well as zoom.
   */
  insetRight = 0
): CameraState {
  if (points.length === 0 || width <= 0 || height <= 0) return DEFAULT_CAMERA;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    minX = Math.min(minX, p.x - p.radius);
    maxX = Math.max(maxX, p.x + p.radius);
    minY = Math.min(minY, p.y - p.radius);
    maxY = Math.max(maxY, p.y + p.radius);
  }

  const spanX = Math.max(maxX - minX, 1);
  const spanY = Math.max(maxY - minY, 1);
  // Never let the inset eat the whole canvas: a panel wider than the view
  // (possible at `max-w-[85vw]` on a phone) would otherwise produce a
  // zero-width box and a NaN zoom.
  const inset = Math.max(0, Math.min(insetRight, Math.max(width - padding * 2, 0)));
  const availableW = Math.max(width - inset - padding * 2, 1);
  const availableH = Math.max(height - padding * 2, 1);
  const zoom = clampZoom(Math.min(availableW / spanX, availableH / spanY, 2));

  // The camera centres the world on the canvas's midpoint, but the visible
  // region's midpoint is `inset / 2` to the left of it. Shifting the target
  // by that much — converted to world units, hence the divide by zoom —
  // lands the content in the middle of what can actually be seen.
  const centerShift = inset / 2 / zoom;

  return { x: (minX + maxX) / 2 + centerShift, y: (minY + maxY) / 2, zoom };
}
