import { scopedKey } from "@/lib/storage/namespace";
import { MAX_GRAPH_COORD } from "@/lib/graph/types";
import { DEFAULT_AGENT_SPATIAL_FILTER, isAgentSpatialFilter } from "./types";
import type { AgentSpatialFilter, SpatialId } from "./types";

/**
 * Where the user has dragged agent nodes, and what they are filtering by.
 *
 * Layout state only. Nothing here can change an agent, a run, a status or a
 * relationship — dragging a node is a statement about the canvas, not about
 * the work, and this phase deliberately gives the UI no way to say otherwise.
 *
 * Keyed by SPATIAL id (`run:<id>`), never by array position, so a position
 * survives polling, reloads and workspace switches, and cannot be inherited by
 * whatever happens to occupy an index later.
 *
 * Positions are kept per workspace, because the same run cannot appear in two,
 * and a flat map would otherwise grow without any natural pruning point.
 */

const STORAGE_KEY = "tabdump:agent-layout:v1";

export type Point = { x: number; y: number };

export type AgentLayoutState = {
  version: 1;
  /** workspaceId → spatial id → point. */
  positions: Record<string, Record<SpatialId, Point>>;
  filter: AgentSpatialFilter;
};

export function defaultAgentLayoutState(): AgentLayoutState {
  return { version: 1, positions: {}, filter: DEFAULT_AGENT_SPATIAL_FILTER };
}

function isUsablePoint(value: unknown): value is Point {
  if (!value || typeof value !== "object") return false;
  const { x, y } = value as Record<string, unknown>;
  return (
    typeof x === "number" &&
    typeof y === "number" &&
    Number.isFinite(x) &&
    Number.isFinite(y) &&
    Math.abs(x) <= MAX_GRAPH_COORD &&
    Math.abs(y) <= MAX_GRAPH_COORD
  );
}

/**
 * Only these prefixes are honoured.
 *
 * A stored key that is not a recognised spatial id is dropped rather than
 * carried: it can only have come from a hand-edited file or a build that meant
 * something else by it, and a position nothing claims is dead weight that the
 * pruning rule below would never reach.
 */
function isSpatialKey(key: string): boolean {
  return key.startsWith("agent:") || key.startsWith("run:") || key.startsWith("artifact:");
}

/** Never throws — unreadable layout state degrades to "nothing has been dragged". */
export function loadAgentLayout(): AgentLayoutState {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return defaultAgentLayoutState();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultAgentLayoutState();

    const record = parsed as Record<string, unknown>;
    if (record.version !== 1) return defaultAgentLayoutState();

    const positions: AgentLayoutState["positions"] = {};
    if (record.positions && typeof record.positions === "object") {
      for (const [workspaceId, byNode] of Object.entries(record.positions as object)) {
        if (!workspaceId || !byNode || typeof byNode !== "object") continue;

        const kept: Record<SpatialId, Point> = {};
        for (const [key, point] of Object.entries(byNode as object)) {
          if (!isSpatialKey(key) || !isUsablePoint(point)) continue;
          kept[key] = { x: point.x, y: point.y };
        }
        if (Object.keys(kept).length > 0) positions[workspaceId] = kept;
      }
    }

    return {
      version: 1,
      positions,
      filter: isAgentSpatialFilter(record.filter) ? record.filter : DEFAULT_AGENT_SPATIAL_FILTER,
    };
  } catch {
    return defaultAgentLayoutState();
  }
}

export function saveAgentLayout(state: AgentLayoutState): boolean {
  try {
    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/** The dragged positions for one workspace. Empty when nothing has been moved there. */
export function positionsForWorkspace(
  state: AgentLayoutState,
  workspaceId: string
): Record<SpatialId, Point> {
  return state.positions[workspaceId] ?? {};
}

/** Records where the user dropped a node. */
export function setNodePosition(
  state: AgentLayoutState,
  workspaceId: string,
  id: SpatialId,
  point: Point
): AgentLayoutState {
  if (!workspaceId || !isSpatialKey(id) || !isUsablePoint(point)) return state;

  return {
    ...state,
    positions: {
      ...state.positions,
      [workspaceId]: { ...positionsForWorkspace(state, workspaceId), [id]: point },
    },
  };
}

export function setAgentFilter(
  state: AgentLayoutState,
  filter: AgentSpatialFilter
): AgentLayoutState {
  return state.filter === filter ? state : { ...state, filter };
}

/**
 * Drops saved positions for nodes that no longer exist.
 *
 * Deliberately NOT called on every render. A run that is merely filtered out,
 * or whose observer has nothing to say this poll, is not gone — and discarding
 * its position because it was briefly invisible would lose a deliberate user
 * arrangement for no reason. Pruning is for ids the DOMAIN no longer contains,
 * which the caller establishes from persisted domain state rather than from
 * what happens to be on screen.
 */
export function pruneAgentLayout(
  state: AgentLayoutState,
  workspaceId: string,
  liveIds: Set<SpatialId>
): AgentLayoutState {
  const current = state.positions[workspaceId];
  if (!current) return state;

  const kept: Record<SpatialId, Point> = {};
  for (const [id, point] of Object.entries(current)) {
    if (liveIds.has(id)) kept[id] = point;
  }

  if (Object.keys(kept).length === Object.keys(current).length) return state;

  const positions = { ...state.positions };
  if (Object.keys(kept).length === 0) delete positions[workspaceId];
  else positions[workspaceId] = kept;

  return { ...state, positions };
}

export const AGENT_LAYOUT_STORAGE_KEY = STORAGE_KEY;
