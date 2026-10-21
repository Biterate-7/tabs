import { clampZoom } from "./view";
import type { Camera, Insets, Viewport } from "./view";
import type { Point } from "./types";
import type { Point3 } from "./galaxy";

/**
 * The galaxy's camera: a real perspective view of the plane the layout
 * lives on, tipped toward the viewer.
 *
 * `Camera` is unchanged from the flat graph — where on the plane the view
 * is centred (x, y) and how close (k) — so a saved camera, the zoom readout
 * and every caller keep working. The `Lens` adds what makes it a view into
 * space rather than a map: the tilt of the plane, a small yaw (the pointer
 * parallax), and a focal length in screen pixels.
 *
 * The camera dollies rather than scales: its distance from the plane is
 * focal / k, so perspective reads the same at every zoom and a point that
 * would fall behind the camera is culled instead of flipping.
 */
export type Lens = { tilt: number; yaw: number; focal: number };

export type Projected = {
  x: number;
  y: number;
  /** Screen pixels per world unit at this point — what sizes a node and its strokes. */
  scale: number;
  /** Perspective factor: above 1 nearer than the focal plane, below 1 further. */
  s: number;
};

/** The resting lens for a viewport: tipped further on wide screens, where height is scarce. */
export function baseLens(viewport: Viewport): Lens {
  const aspect = viewport.width / Math.max(1, viewport.height);
  const tilt = aspect >= 1.15 ? 0.9 : aspect >= 0.8 ? 0.74 : 0.58;
  return { tilt, yaw: 0, focal: Math.max(viewport.width, viewport.height) * 1.2 };
}

/** Projects a world point; undefined when it would sit at or behind the camera. */
export function project(point: Point3, camera: Camera, viewport: Viewport, lens: Lens): Projected | undefined {
  const dx = point.x - camera.x;
  const dy = point.y - camera.y;
  const cy = Math.cos(lens.yaw);
  const sy = Math.sin(lens.yaw);
  const rx = dx * cy - dy * sy;
  const ry = dx * sy + dy * cy;
  const ct = Math.cos(lens.tilt);
  const st = Math.sin(lens.tilt);
  const vy = ry * ct - point.z * st;
  const toward = ry * st + point.z * ct;
  const denominator = lens.focal - toward * camera.k;
  if (denominator < lens.focal * 0.12) return undefined;
  const s = lens.focal / denominator;
  const scale = camera.k * s;
  return { x: viewport.width / 2 + rx * scale, y: viewport.height / 2 + vy * scale, scale, s };
}

/** The plane point (z = 0) under a screen point. Above the horizon, the furthest visible point. */
export function unproject(screen: Point, camera: Camera, viewport: Viewport, lens: Lens): Point {
  const X = screen.x - viewport.width / 2;
  const Y = screen.y - viewport.height / 2;
  const ct = Math.cos(lens.tilt);
  const st = Math.sin(lens.tilt);
  const denominator = Math.max(lens.focal * ct * 0.05, lens.focal * ct + Y * st);
  const ry = (Y * lens.focal) / (camera.k * denominator);
  const s = lens.focal / (lens.focal - ry * st * camera.k);
  const rx = X / (camera.k * s);
  const cy = Math.cos(lens.yaw);
  const sy = Math.sin(lens.yaw);
  return { x: camera.x + rx * cy + ry * sy, y: camera.y - rx * sy + ry * cy };
}

/** Zoom about a screen point, so the plane under the pointer stays under it. */
export function zoomAtLens(camera: Camera, screen: Point, nextK: number, viewport: Viewport, lens: Lens): Camera {
  const k = clampZoom(nextK);
  const before = unproject(screen, camera, viewport, lens);
  const after = unproject(screen, { ...camera, k }, viewport, lens);
  return { x: camera.x + (before.x - after.x), y: camera.y + (before.y - after.y), k };
}

/** The camera that drags the plane point under `from` to sit under `to`. */
export function panLens(camera: Camera, from: Point, to: Point, viewport: Viewport, lens: Lens): Camera {
  const a = unproject(from, camera, viewport, lens);
  const b = unproject(to, camera, viewport, lens);
  return { ...camera, x: camera.x + (a.x - b.x), y: camera.y + (a.y - b.y) };
}

/** The camera at zoom k that puts a world point (at any height) at the viewport's centre. */
export function cameraOn(point: Point3, k: number, lens: Lens): Camera {
  // Centred means its view-space height is zero: ry·cos(tilt) = z·sin(tilt).
  const ry = point.z * Math.tan(lens.tilt);
  const cy = Math.cos(lens.yaw);
  const sy = Math.sin(lens.yaw);
  return { x: point.x - ry * sy, y: point.y - ry * cy, k: clampZoom(k) };
}

/**
 * The camera that frames `points` (each with a world radius) inside the
 * part of the viewport no panel covers. Perspective has no closed form, so
 * it starts from the flat answer and corrects against real projections.
 */
export function fitLens(points: readonly (Point3 & { r?: number })[], viewport: Viewport, lens: Lens, options: { padding?: number; insets?: Insets; maxZoom?: number } = {}): Camera {
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, k: 1 };
  const padding = options.padding ?? 64;
  const insets = { top: 0, right: 0, bottom: 0, left: 0, ...options.insets };
  const availW = Math.max(80, viewport.width - insets.left - insets.right - padding * 2);
  const availH = Math.max(80, viewport.height - insets.top - insets.bottom - padding * 2);
  const target = { x: insets.left + padding + availW / 2, y: insets.top + padding + availH / 2 };
  const maxZoom = options.maxZoom ?? 1.6;

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let zSum = 0;
  for (const p of points) {
    const r = p.r ?? 0;
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
    zSum += p.z;
  }
  const flatH = (maxY - minY) * Math.cos(lens.tilt) + 60;
  let k = clampZoom(Math.min(availW / Math.max(1, maxX - minX), availH / Math.max(1, flatH), maxZoom));
  let camera = cameraOn({ x: (minX + maxX) / 2, y: (minY + maxY) / 2, z: zSum / points.length }, k, lens);

  for (let pass = 0; pass < 5; pass++) {
    let sx0 = Infinity;
    let sy0 = Infinity;
    let sx1 = -Infinity;
    let sy1 = -Infinity;
    for (const p of points) {
      const at = project(p, camera, viewport, lens);
      if (!at) continue;
      const r = (p.r ?? 0) * at.scale;
      sx0 = Math.min(sx0, at.x - r);
      sy0 = Math.min(sy0, at.y - r);
      sx1 = Math.max(sx1, at.x + r);
      sy1 = Math.max(sy1, at.y + r);
    }
    if (!Number.isFinite(sx0)) break;
    const factor = Math.min(availW / Math.max(1, sx1 - sx0), availH / Math.max(1, sy1 - sy0));
    const nextK = clampZoom(Math.min(maxZoom, k * Math.min(2.5, Math.max(0.4, factor))));
    // Shift so the projected box is centred in the free area.
    const centre = { x: (sx0 + sx1) / 2, y: (sy0 + sy1) / 2 };
    const from = unproject(centre, camera, viewport, lens);
    const to = unproject(target, camera, viewport, lens);
    camera = { x: camera.x + (from.x - to.x), y: camera.y + (from.y - to.y), k: nextK };
    if (Math.abs(nextK - k) / k < 0.01 && Math.hypot(centre.x - target.x, centre.y - target.y) < 2) break;
    k = nextK;
  }
  return camera;
}
