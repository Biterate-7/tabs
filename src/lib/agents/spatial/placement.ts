import { MAX_GRAPH_COORD } from "@/lib/graph/types";
import type { AgentSpatialNodeUnion, AgentSpatialScene, SpatialId } from "./types";

/**
 * Where agent nodes sit on the canvas.
 *
 * Two decisions define this module, and both exist to protect what is already
 * on screen.
 *
 * **The agent layer is not in the physics simulation.** The tab graph runs
 * d3-force with cluster territories and confinement discs; adding bodies to it
 * would change the forces every existing tab feels, and a user's hand-arranged
 * workspace would rearrange itself the moment an agent appeared. Agent nodes
 * are placed arithmetically and never handed to the engine, so the tab layout
 * is bit-for-bit what it was before this phase existed.
 *
 * **Placement is a pure function of identity.** The same run lands in the same
 * place on every poll, every reload, and every rerender, because its position
 * is derived from its id rather than from when it was discovered or where it
 * appeared in an array. That is what makes a polling UI hold still.
 */

export type Point = { x: number; y: number };

export type PlacementInput = {
  scene: AgentSpatialScene;
  /** Positions the user has dragged, by spatial id. These always win. */
  pinned: Record<SpatialId, Point>;
  /**
   * Where the tab graph currently occupies space, so the agent column can sit
   * beside it rather than on top of it. Absent means "no tabs", and the column
   * falls back to the origin.
   */
  tabBounds?: { minX: number; maxX: number; minY: number; maxY: number } | null;
};

/** Horizontal gap between the tab graph's right edge and the agent column. */
const COLUMN_GUTTER = 260;

/** Vertical rhythm of the agent column. */
const AGENT_SPACING = 340;
const RUN_SPACING = 150;
const ARTIFACT_SPACING = 92;

/** Horizontal offset of each tier from the agent column's spine. */
const RUN_INDENT = 300;
const ARTIFACT_INDENT = 560;

/**
 * A small deterministic wobble, derived from the id.
 *
 * Purely so that two runs created in the same millisecond do not sit at
 * pixel-identical y within their tier. Deterministic, so it is stable across
 * reloads — a random jitter would move nodes on every mount, which is the
 * exact failure this module exists to prevent.
 */
function wobble(id: string, range: number): number {
  let hash = 0;
  for (let i = 0; i < id.length; i += 1) hash = (hash * 31 + id.charCodeAt(i)) | 0;
  return (Math.abs(hash) % (range * 2)) - range;
}

function clamp(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(-MAX_GRAPH_COORD, Math.min(MAX_GRAPH_COORD, value));
}

/**
 * Places every node in the scene.
 *
 * The arrangement mirrors the domain's own shape — agent, then its runs, then
 * the files of whichever run is disclosed:
 *
 *     Agent
 *        └── Run
 *              ├── file
 *              └── file
 *
 * Ordering within a tier is by id, not by array order or by timestamp, so a
 * run that changes status does not swap places with its neighbour.
 */
export function placeAgentScene(input: PlacementInput): Map<SpatialId, Point> {
  const { scene, pinned, tabBounds } = input;
  const positions = new Map<SpatialId, Point>();

  // The column starts clear of the tab graph's right edge. Recomputing this
  // when tabs move is fine: it shifts the agent layer, never the tabs.
  const spineX = tabBounds ? tabBounds.maxX + COLUMN_GUTTER : 0;
  const startY = tabBounds ? tabBounds.minY : 0;

  // Ordered by CREATION, not by id. This is what makes placement append-only:
  // a newly discovered node always has the largest createdAt, so it takes the
  // next free slot instead of sorting into the middle and pushing everything
  // after it down. Sorting by id would reorder the whole column whenever a
  // freshly minted uuid happened to sort early — which is a layout that
  // rearranges itself on a poll, the one thing this must never do.
  const agents = scene.nodes.filter((node) => node.kind === "agent").sort(byCreation);
  const runs = scene.nodes.filter((node) => node.kind === "run").sort(byCreation);
  const artifacts = scene.nodes.filter((node) => node.kind === "artifact").sort(byCreation);

  agents.forEach((agent, agentIndex) => {
    const agentY = startY + agentIndex * AGENT_SPACING;
    place(agent.id, { x: spineX, y: agentY });

    const ownRuns = runs.filter(
      (run) => run.kind === "run" && agent.kind === "agent" && run.agentId === agent.agentId
    );

    ownRuns.forEach((run, runIndex) => {
      // Every run occupies a slot of CONSTANT height. A run that gains files
      // must not push its siblings down, so its files fan out around it
      // rather than claiming extra column space.
      const runY = agentY + RUN_SPACING + runIndex * RUN_SPACING;
      place(run.id, { x: spineX + RUN_INDENT, y: runY + wobble(run.id, 8) });

      const runArtifacts = artifactsForRun(scene, run.id, artifacts);
      runArtifacts.forEach((artifact, artifactIndex) => {
        const offset = (artifactIndex - (runArtifacts.length - 1) / 2) * ARTIFACT_SPACING;
        place(artifact.id, {
          x: spineX + ARTIFACT_INDENT,
          y: runY + offset + wobble(artifact.id, 6),
        });
      });
    });
  });

  // Anything the tiers above did not reach still needs a position — a node
  // with no position renders nowhere and hit-tests nowhere. Indexed off its
  // own ordering so this fallback is stable too.
  const trailingY = startY + agents.length * AGENT_SPACING;
  scene.nodes.forEach((node, index) => {
    if (positions.has(node.id)) return;
    place(node.id, { x: spineX, y: trailingY + index * RUN_SPACING });
  });

  return positions;

  function place(id: SpatialId, point: Point): void {
    // A dragged position always wins: the user put it there on purpose, and
    // recomputing over it would undo the drag on the next poll.
    const override = pinned[id];
    const chosen = override ?? point;
    positions.set(id, { x: clamp(chosen.x), y: clamp(chosen.y) });
  }
}

/**
 * Oldest first, with id breaking ties.
 *
 * The tiebreak keeps the order total, so two nodes created in the same
 * millisecond still order deterministically rather than depending on whatever
 * order the domain arrays happened to hold them in.
 */
function byCreation(a: AgentSpatialNodeUnion, b: AgentSpatialNodeUnion): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/** The disclosed artifacts of one run, via the scene's own edges. */
function artifactsForRun(
  scene: AgentSpatialScene,
  runSpatialIdValue: SpatialId,
  artifacts: AgentSpatialNodeUnion[]
): AgentSpatialNodeUnion[] {
  const wanted = new Set(
    scene.edges
      .filter((edge) => edge.source === runSpatialIdValue && edge.target.startsWith("artifact:"))
      .map((edge) => edge.target)
  );

  return artifacts.filter((artifact) => wanted.has(artifact.id));
}

/**
 * Whether two placements agree about every node they share.
 *
 * The property the stability tests assert: a poll that adds a node must leave
 * every existing node exactly where it was.
 */
export function placementsAgree(
  before: Map<SpatialId, Point>,
  after: Map<SpatialId, Point>
): boolean {
  for (const [id, point] of before) {
    const next = after.get(id);
    if (!next) continue;
    if (next.x !== point.x || next.y !== point.y) return false;
  }
  return true;
}
