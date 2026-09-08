import type { NodeSizeMode } from "./types";

export const BASE_NODE_RADIUS = 5;
export const MAX_NODE_RADIUS = 13;

/**
 * A node's whole size model is one number.
 *
 * The rendered body is a circle of this radius (node-renderer.ts), the
 * collision geometry is a circle of this radius plus a fixed gap
 * (engine.ts's nodeCollisionRadius), and zoom multiplies it at paint time
 * without ever writing it back — so there is exactly one place a node's
 * dimensions can come from, and this is it. Nothing downstream measures the
 * DOM, and nothing feeds a rendered size back into the model.
 *
 * NaN-safe on purpose. Both inputs come from live maps that can hand over a
 * missing or malformed number (a degree map built while edges are mid-swap, a
 * center-distance map for a node the local-graph walk never reached), and
 * `Math.min(NaN, MAX)` is NaN, not MAX — an unguarded NaN here becomes a NaN
 * collision radius, which d3-force spreads into NaN positions across the
 * whole layout. A bad input is treated as "no signal" (the base radius),
 * never as a size.
 */
export function computeNodeRadius(
  mode: NodeSizeMode,
  connectionCount: number,
  distanceFromCenter: number | undefined
): number {
  if (mode === "connections") {
    const connections = Number.isFinite(connectionCount) ? Math.max(0, connectionCount) : 0;
    return clampNodeRadius(BASE_NODE_RADIUS + Math.min(connections, 12) * 0.6);
  }
  if (mode === "relevance") {
    if (distanceFromCenter === undefined || !Number.isFinite(distanceFromCenter)) return BASE_NODE_RADIUS;
    const falloff = Math.max(0, 6 - Math.max(0, distanceFromCenter) * 2.5);
    return clampNodeRadius(BASE_NODE_RADIUS + falloff);
  }
  return BASE_NODE_RADIUS;
}

/**
 * The one place a radius is bounded. Capped so a heavily-connected hub never
 * becomes an absurdly large blob (spec: "Do not make highly connected nodes
 * absurdly large") — growth flattens out well before the cap — and floored so
 * a node can never be invisible, zero-area or negative.
 */
export function clampNodeRadius(radius: number): number {
  if (!Number.isFinite(radius)) return BASE_NODE_RADIUS;
  return Math.max(BASE_NODE_RADIUS, Math.min(radius, MAX_NODE_RADIUS));
}
