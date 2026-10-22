import { MAX_GRAPH_COORD } from "@/lib/graph/types";
import { scopedKey } from "@/lib/storage/namespace";
import type { Camera } from "./view";
import type { Point } from "./types";

/**
 * Where the knowledge graph's nodes were last placed, and the camera.
 *
 * Layout positions are what keep the picture predictable between visits:
 * a project the person found in the upper left yesterday is in the upper
 * left today. Keyed by node id, which is derived from record ids, so it
 * holds no titles or addresses. Scoped per account like the tab graph's.
 */
const STORAGE_KEY = "tabdump:knowledge-graph:v1";
/** A ceiling on what is kept: positions for nodes that no longer exist are pruned on save. */
const MAX_POSITIONS = 20_000;
/**
 * Which layout produced the stored positions. The galaxy (3) places items on
 * arms around their project; positions from the earlier force layout would
 * strand them between arms, so they are dropped once, with the camera that
 * framed them. Generation 4 is the galaxy holding every saved tab (the Tab
 * map merged into the Graph): fans sized for the old population would
 * overlap once the tabs arrive, so the galaxy is laid out afresh, once.
 */
const LAYOUT_GENERATION = 4;

export type KnowledgeGraphState = {
  version: 1;
  positions: Record<string, Point>;
  camera?: Camera;
};

function finite(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= MAX_GRAPH_COORD;
}

export function loadKnowledgeGraphState(): KnowledgeGraphState {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return { version: 1, positions: {} };
    const parsed = JSON.parse(raw) as Partial<KnowledgeGraphState> & { layout?: unknown };
    if (parsed.layout !== LAYOUT_GENERATION) return { version: 1, positions: {} };
    const positions: Record<string, Point> = {};
    for (const [id, p] of Object.entries(parsed.positions ?? {})) {
      if (p && finite(p.x) && finite(p.y)) positions[id] = { x: p.x, y: p.y };
    }
    const c = parsed.camera;
    const camera = c && finite(c.x) && finite(c.y) && finite(c.k) && c.k > 0 ? { x: c.x, y: c.y, k: c.k } : undefined;
    return { version: 1, positions, ...(camera ? { camera } : {}) };
  } catch {
    return { version: 1, positions: {} };
  }
}

/** Saves positions for the nodes that exist now; anything else is dropped. */
export function saveKnowledgeGraphState(state: KnowledgeGraphState, liveIds: ReadonlySet<string>): void {
  const positions: Record<string, Point> = {};
  let count = 0;
  for (const [id, p] of Object.entries(state.positions)) {
    if (!liveIds.has(id) || count >= MAX_POSITIONS) continue;
    positions[id] = p;
    count += 1;
  }
  try {
    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify({ version: 1, layout: LAYOUT_GENERATION, positions, ...(state.camera ? { camera: state.camera } : {}) }));
  } catch {
    // A layout is a convenience: the next visit lays out again.
  }
}
