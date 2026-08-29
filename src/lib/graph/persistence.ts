import {
  DEFAULT_CAMERA,
  DEFAULT_CONNECTION_FILTERS,
  DEFAULT_GRAPH_SETTINGS,
  type ConnectionFilters,
  type GraphDepth,
  type GraphPersistedState,
  type GraphSettings,
  type ManualConnection,
} from "./types";

const STORAGE_KEY = "tabdump:graph:v1";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function sanitizePositions(value: unknown): Record<string, { x: number; y: number }> {
  if (!value || typeof value !== "object") return {};
  const out: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of Object.entries(value as Record<string, unknown>)) {
    if (!pos || typeof pos !== "object") continue;
    const { x, y } = pos as Record<string, unknown>;
    if (isFiniteNumber(x) && isFiniteNumber(y)) out[id] = { x, y };
  }
  return out;
}

function sanitizeManualConnections(value: unknown): ManualConnection[] {
  if (!Array.isArray(value)) return [];
  const out: ManualConnection[] = [];
  for (const entry of value) {
    if (!entry || typeof entry !== "object") continue;
    const { a, b, createdAt } = entry as Record<string, unknown>;
    if (typeof a === "string" && typeof b === "string" && a !== b) {
      out.push({ a, b, createdAt: isFiniteNumber(createdAt) ? createdAt : Date.now() });
    }
  }
  return out;
}

function sanitizeFilters(value: unknown): ConnectionFilters {
  if (!value || typeof value !== "object") return DEFAULT_CONNECTION_FILTERS;
  const v = value as Record<string, unknown>;
  return {
    domain: typeof v.domain === "boolean" ? v.domain : DEFAULT_CONNECTION_FILTERS.domain,
    workspace: typeof v.workspace === "boolean" ? v.workspace : DEFAULT_CONNECTION_FILTERS.workspace,
    category: typeof v.category === "boolean" ? v.category : DEFAULT_CONNECTION_FILTERS.category,
    group: typeof v.group === "boolean" ? v.group : DEFAULT_CONNECTION_FILTERS.group,
    manual: typeof v.manual === "boolean" ? v.manual : DEFAULT_CONNECTION_FILTERS.manual,
  };
}

function sanitizeDepth(value: unknown): GraphDepth {
  if (value === "infinite" || value === 1 || value === 2 || value === 3) return value;
  return DEFAULT_GRAPH_SETTINGS.depth;
}

function sanitizeSettings(value: unknown): GraphSettings {
  if (!value || typeof value !== "object") return DEFAULT_GRAPH_SETTINGS;
  const v = value as Record<string, unknown>;
  const display = (v.display ?? {}) as Record<string, unknown>;
  const camera = (v.camera ?? {}) as Record<string, unknown>;
  return {
    view: v.view === "local" ? "local" : "global",
    depth: sanitizeDepth(v.depth),
    filters: sanitizeFilters(v.filters),
    display: {
      nodeSize:
        display.nodeSize === "uniform" || display.nodeSize === "relevance"
          ? display.nodeSize
          : DEFAULT_GRAPH_SETTINGS.display.nodeSize,
      edgeStrength: isFiniteNumber(display.edgeStrength)
        ? display.edgeStrength
        : DEFAULT_GRAPH_SETTINGS.display.edgeStrength,
      textSize: isFiniteNumber(display.textSize)
        ? display.textSize
        : DEFAULT_GRAPH_SETTINGS.display.textSize,
    },
    sidebarOpen: typeof v.sidebarOpen === "boolean" ? v.sidebarOpen : DEFAULT_GRAPH_SETTINGS.sidebarOpen,
    workspaceFilter: typeof v.workspaceFilter === "string" ? v.workspaceFilter : "all",
    camera: {
      x: isFiniteNumber(camera.x) ? camera.x : DEFAULT_CAMERA.x,
      y: isFiniteNumber(camera.y) ? camera.y : DEFAULT_CAMERA.y,
      zoom: isFiniteNumber(camera.zoom) && camera.zoom > 0 ? camera.zoom : DEFAULT_CAMERA.zoom,
    },
    selectedTabId: typeof v.selectedTabId === "string" ? v.selectedTabId : null,
  };
}

export function defaultGraphState(): GraphPersistedState {
  return {
    version: 1,
    positions: {},
    manualConnections: [],
    settings: DEFAULT_GRAPH_SETTINGS,
  };
}

/** Never throws — corrupted or missing graph state degrades to sensible defaults rather than blocking the graph from opening. */
export function loadGraphState(): GraphPersistedState {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultGraphState();
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultGraphState();
    const v = parsed as Record<string, unknown>;
    return {
      version: 1,
      positions: sanitizePositions(v.positions),
      manualConnections: sanitizeManualConnections(v.manualConnections),
      settings: sanitizeSettings(v.settings),
    };
  } catch {
    return defaultGraphState();
  }
}

export function saveGraphState(state: GraphPersistedState): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops positions and manual connections referencing tab ids that no longer
 * exist (deleted tabs, cleared workspaces) so the persisted blob doesn't
 * grow forever and a stale manual link never resurrects a ghost edge.
 */
export function pruneGraphState(state: GraphPersistedState, validTabIds: Set<string>): GraphPersistedState {
  const positions: Record<string, { x: number; y: number }> = {};
  for (const [id, pos] of Object.entries(state.positions)) {
    if (validTabIds.has(id)) positions[id] = pos;
  }
  const manualConnections = state.manualConnections.filter(
    (c) => validTabIds.has(c.a) && validTabIds.has(c.b)
  );
  const selectedTabId =
    state.settings.selectedTabId && validTabIds.has(state.settings.selectedTabId)
      ? state.settings.selectedTabId
      : null;

  return {
    ...state,
    positions,
    manualConnections,
    settings: { ...state.settings, selectedTabId },
  };
}
