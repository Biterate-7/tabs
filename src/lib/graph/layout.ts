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
  padding = 64
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
  const availableW = Math.max(width - padding * 2, 1);
  const availableH = Math.max(height - padding * 2, 1);
  const zoom = clampZoom(Math.min(availableW / spanX, availableH / spanY, 2));

  return { x: (minX + maxX) / 2, y: (minY + maxY) / 2, zoom };
}
