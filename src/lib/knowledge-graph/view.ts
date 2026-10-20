import { aiProviderName } from "@/lib/providers/registry";
import type { KnowledgeNode, Point } from "./types";

/** Where the camera looks (world coordinates at the viewport's centre) and how close. */
export type Camera = { x: number; y: number; k: number };

export const MIN_ZOOM = 0.12;
export const MAX_ZOOM = 4;

export type Viewport = { width: number; height: number };
/** Screen space a panel covers (the inspector on the right), which a fit should frame around. */
export type Insets = { top?: number; right?: number; bottom?: number; left?: number };

export function clampZoom(k: number): number {
  return Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, k));
}

export function worldToScreen(point: Point, camera: Camera, viewport: Viewport): Point {
  return { x: (point.x - camera.x) * camera.k + viewport.width / 2, y: (point.y - camera.y) * camera.k + viewport.height / 2 };
}

export function screenToWorld(point: Point, camera: Camera, viewport: Viewport): Point {
  return { x: (point.x - viewport.width / 2) / camera.k + camera.x, y: (point.y - viewport.height / 2) / camera.k + camera.y };
}

/** Zoom about a screen point, so what is under the pointer stays under it. */
export function zoomAt(camera: Camera, screen: Point, nextK: number, viewport: Viewport): Camera {
  const k = clampZoom(nextK);
  const before = screenToWorld(screen, camera, viewport);
  const moved = { ...camera, k };
  const after = screenToWorld(screen, moved, viewport);
  return { x: camera.x + (before.x - after.x), y: camera.y + (before.y - after.y), k };
}

/**
 * The camera that frames `points` (each with its radius) inside the part of
 * the viewport no panel covers, with `padding` screen pixels to spare.
 */
export function fitCamera(points: readonly (Point & { r?: number })[], viewport: Viewport, options: { padding?: number; insets?: Insets; maxZoom?: number } = {}): Camera {
  const padding = options.padding ?? 64;
  const insets = { top: 0, right: 0, bottom: 0, left: 0, ...options.insets };
  if (points.length === 0 || viewport.width <= 0 || viewport.height <= 0) return { x: 0, y: 0, k: 1 };
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const p of points) {
    const r = p.r ?? 0;
    minX = Math.min(minX, p.x - r);
    minY = Math.min(minY, p.y - r);
    maxX = Math.max(maxX, p.x + r);
    maxY = Math.max(maxY, p.y + r);
  }
  const availableW = Math.max(80, viewport.width - insets.left - insets.right - padding * 2);
  const availableH = Math.max(80, viewport.height - insets.top - insets.bottom - padding * 2);
  const k = clampZoom(Math.min(availableW / Math.max(1, maxX - minX), availableH / Math.max(1, maxY - minY), options.maxZoom ?? 1.6));
  // Centre of the free area, expressed as an offset from the viewport's centre.
  const offsetX = (insets.left - insets.right) / 2;
  const offsetY = (insets.top - insets.bottom) / 2;
  return { x: (minX + maxX) / 2 - offsetX / k, y: (minY + maxY) / 2 - offsetY / k, k };
}

/** Decelerating ease (the --ease-standard curve, as a function). */
export function easeOutQuint(t: number): number {
  return 1 - Math.pow(1 - t, 5);
}

/** Between two cameras: position linearly, zoom in log space so it feels even. */
export function mixCamera(from: Camera, to: Camera, t: number): Camera {
  const e = easeOutQuint(Math.min(1, Math.max(0, t)));
  return { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e, k: Math.exp(Math.log(from.k) + (Math.log(to.k) - Math.log(from.k)) * e) };
}

/**
 * A uniform grid over node positions: pointer hit-testing stays O(1)-ish at
 * thousands of nodes, where scanning every node per mousemove would not.
 */
export class SpatialGrid {
  private cells = new Map<string, { id: string; x: number; y: number; r: number }[]>();
  constructor(private size = 64) {}

  static from(entries: Iterable<{ id: string; x: number; y: number; r: number }>, size = 64): SpatialGrid {
    const grid = new SpatialGrid(size);
    for (const entry of entries) grid.insert(entry);
    return grid;
  }

  insert(entry: { id: string; x: number; y: number; r: number }) {
    const key = this.key(Math.floor(entry.x / this.size), Math.floor(entry.y / this.size));
    const cell = this.cells.get(key);
    if (cell) cell.push(entry);
    else this.cells.set(key, [entry]);
  }

  /** The node whose disc (plus `tolerance`, world units) contains the point; nearest wins. */
  hit(x: number, y: number, tolerance: number): string | undefined {
    const cx = Math.floor(x / this.size);
    const cy = Math.floor(y / this.size);
    const reach = Math.max(1, Math.ceil(tolerance / this.size));
    let best: string | undefined;
    let bestDistance = Infinity;
    for (let gx = cx - reach; gx <= cx + reach; gx++) {
      for (let gy = cy - reach; gy <= cy + reach; gy++) {
        for (const entry of this.cells.get(this.key(gx, gy)) ?? []) {
          const distance = Math.hypot(entry.x - x, entry.y - y) - entry.r;
          if (distance <= tolerance && distance < bestDistance) {
            best = entry.id;
            bestDistance = distance;
          }
        }
      }
    }
    return best;
  }

  private key(x: number, y: number) {
    return `${x},${y}`;
  }
}

export type Direction = "up" | "down" | "left" | "right";

/**
 * Keyboard traversal: the nearest node in a direction, within a 120° cone,
 * preferring nodes straight ahead over nodes merely close.
 */
export function nodeInDirection(fromId: string, direction: Direction, positions: Readonly<Record<string, Point>>, candidates: Iterable<string>): string | undefined {
  const from = positions[fromId];
  if (!from) return undefined;
  const [ux, uy] = direction === "up" ? [0, -1] : direction === "down" ? [0, 1] : direction === "left" ? [-1, 0] : [1, 0];
  let best: string | undefined;
  let bestScore = Infinity;
  for (const id of candidates) {
    if (id === fromId) continue;
    const p = positions[id];
    if (!p) continue;
    const dx = p.x - from.x;
    const dy = p.y - from.y;
    const distance = Math.hypot(dx, dy);
    if (distance === 0) continue;
    const along = (dx * ux + dy * uy) / distance;
    if (along < 0.5) continue; // outside the cone
    const score = distance * (2 - along);
    if (score < bestScore) {
      best = id;
      bestScore = score;
    }
  }
  return best;
}

/**
 * Nodes matching a query: by name first (starts-with before contains), then
 * by where they are or came from — their project, AI app or site.
 */
export function searchNodes(nodes: readonly KnowledgeNode[], query: string, projectName: (id: string) => string | undefined, limit = 40): KnowledgeNode[] {
  const terms = query.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return [];
  const scored: { node: KnowledgeNode; score: number }[] = [];
  for (const node of nodes) {
    const label = node.label.toLowerCase();
    const context = [node.projectId ? projectName(node.projectId) : "", node.provider ? aiProviderName(node.provider) : "", node.item?.domain ?? "", node.item?.fileName ?? ""].join(" ").toLowerCase();
    let score = 0;
    let all = true;
    for (const term of terms) {
      if (label.startsWith(term)) score += 4;
      else if (label.includes(term)) score += 2;
      else if (context.includes(term)) score += 1;
      else all = false;
    }
    if (all) scored.push({ node, score: score + (node.kind === "project" ? 0.5 : 0) });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.node.at - a.node.at)
    .slice(0, limit)
    .map((entry) => entry.node);
}
