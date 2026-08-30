import { BUCKET_LABEL, CARD_STAGGER_MS, categoryColorVar, type IntroTab } from "./intro-data"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { EXIT_DURATION_MS, type IntroPhase } from "./phase"

const BUCKET_ORDER: IntroTab["bucket"][] = ["projects", "research", "other"]

type GraphNode = { id: string; x: number; y: number; bucket: IntroTab["bucket"] }
type GraphEdge = { id: string; x1: number; y1: number; x2: number; y2: number; kind: "relation" | "dependency" }

// Hand-placed, not physics-simulated — this is a decorative payoff, not a
// second implementation of the real Graph View's force layout. Three loose
// clusters (one per bucket) with a couple of cross-cluster "dependency"
// edges, echoing the real GraphCanvas's actual palette (see
// src/lib/graph/palette.ts: edge.domain / edgeDependency).
const GRAPH_NODES: GraphNode[] = [
  { id: "r1", x: 58, y: 48, bucket: "research" },
  { id: "r2", x: 38, y: 88, bucket: "research" },
  { id: "r3", x: 84, y: 94, bucket: "research" },
  { id: "p1", x: 262, y: 46, bucket: "projects" },
  { id: "p2", x: 282, y: 86, bucket: "projects" },
  { id: "p3", x: 236, y: 94, bucket: "projects" },
  { id: "o1", x: 160, y: 136, bucket: "other" },
  { id: "o2", x: 130, y: 154, bucket: "other" },
  { id: "o3", x: 190, y: 154, bucket: "other" },
]

const GRAPH_EDGES: GraphEdge[] = [
  { id: "re1", x1: 58, y1: 48, x2: 38, y2: 88, kind: "relation" },
  { id: "re2", x1: 38, y1: 88, x2: 84, y2: 94, kind: "relation" },
  { id: "re3", x1: 84, y1: 94, x2: 58, y2: 48, kind: "relation" },
  { id: "pe1", x1: 262, y1: 46, x2: 282, y2: 86, kind: "relation" },
  { id: "pe2", x1: 282, y1: 86, x2: 236, y2: 94, kind: "relation" },
  { id: "pe3", x1: 236, y1: 94, x2: 262, y2: 46, kind: "relation" },
  { id: "oe1", x1: 160, y1: 136, x2: 130, y2: 154, kind: "relation" },
  { id: "oe2", x1: 160, y1: 136, x2: 190, y2: 154, kind: "relation" },
  { id: "de1", x1: 84, y1: 94, x2: 160, y2: 136, kind: "dependency" },
  { id: "de2", x1: 236, y1: 94, x2: 160, y2: 136, kind: "dependency" },
]

const EDGE_COLOR: Record<GraphEdge["kind"], string> = {
  relation: "rgba(138, 157, 255, 0.4)",
  dependency: "rgba(45, 212, 191, 0.6)",
}

function edgeLength(edge: GraphEdge): number {
  return Math.hypot(edge.x2 - edge.x1, edge.y2 - edge.y1) * 1.08
}

function CollectionCard({ bucket, tabs, delayMs }: { bucket: IntroTab["bucket"]; tabs: IntroTab[]; delayMs: number }) {
  const preview = tabs.slice(0, 3)
  return (
    <div
      className="w-[152px] rounded-lg border border-subtle bg-card p-2.5 sm:w-[176px]"
      style={{ animation: `intro-card-in 420ms var(--ease-standard) ${delayMs}ms both` }}
    >
      <div className="flex items-baseline justify-between gap-2 px-0.5 pb-1.5">
        <span className="truncate text-body-sm font-medium text-foreground">{BUCKET_LABEL[bucket]}</span>
        <span className="shrink-0 text-meta text-tertiary">{tabs.length} tabs</span>
      </div>
      <div className="flex flex-col gap-1">
        {preview.map((tab) => (
          <div key={tab.id} className="flex items-center gap-1.5 px-0.5">
            <TabFavicon domain={tab.domain} size={12} />
            <span className="truncate text-meta text-tertiary">{tab.label}</span>
          </div>
        ))}
      </div>
    </div>
  )
}

/**
 * Scenes 5–6: the organized collections, then the graph they grow into.
 * Both sub-states are kept mounted the whole time (opacity-crossfaded, like
 * every other intro layer) so the graph reads as emerging from the same
 * on-screen position the cards just occupied, not a screenshot swap.
 */
export function OrganizedWorkspace({ phase, tabs }: { phase: IntroPhase; tabs: IntroTab[] }) {
  const cardsActive = phase === "organized"
  // Graph stays mounted/visible through "exit" (rather than fading out on
  // its own 260ms timer the moment "exit" starts) so it reads as expanding
  // into the full-page transition instead of vanishing just before it.
  const graphActive = phase === "graph" || phase === "exit"
  const graphExiting = phase === "exit"
  const grouped = BUCKET_ORDER.map((bucket) => ({ bucket, tabs: tabs.filter((t) => t.bucket === bucket) }))

  return (
    <div className="absolute inset-x-0 top-[32%] flex flex-col items-center" aria-hidden>
      <div
        className="flex flex-wrap justify-center gap-3 sm:gap-4"
        style={{ opacity: cardsActive ? 1 : 0, pointerEvents: "none", transition: "opacity 260ms var(--ease-standard)" }}
      >
        {cardsActive &&
          grouped.map(({ bucket, tabs: bucketTabs }, i) => (
            <CollectionCard key={bucket} bucket={bucket} tabs={bucketTabs} delayMs={CARD_STAGGER_MS[i] ?? 0} />
          ))}
      </div>

      <svg
        viewBox="0 0 320 170"
        className="absolute top-0 w-[300px] sm:w-[340px]"
        style={{
          opacity: graphActive ? 1 : 0,
          pointerEvents: "none",
          transformOrigin: "50% 40%",
          transform: graphExiting ? "scale(1.8)" : "scale(1)",
          transition: graphExiting
            ? `transform ${EXIT_DURATION_MS}ms var(--ease-standard)`
            : "opacity 260ms var(--ease-standard)",
        }}
      >
        {graphActive &&
          GRAPH_EDGES.map((edge, i) => {
            const length = edgeLength(edge)
            return (
              <line
                key={edge.id}
                x1={edge.x1}
                y1={edge.y1}
                x2={edge.x2}
                y2={edge.y2}
                stroke={EDGE_COLOR[edge.kind]}
                strokeWidth={edge.kind === "dependency" ? 1.5 : 1}
                strokeDasharray={length}
                style={{
                  ["--intro-edge-length" as string]: length,
                  animation: `intro-edge-draw 480ms var(--ease-standard) ${120 + i * 70}ms both`,
                }}
              />
            )
          })}
        {graphActive &&
          GRAPH_NODES.map((node, i) => (
            <circle
              key={node.id}
              cx={node.x}
              cy={node.y}
              r={8}
              fill={categoryColorVar(node.bucket)}
              stroke="var(--border)"
              strokeWidth={1}
              style={{
                transformOrigin: `${node.x}px ${node.y}px`,
                animation: `intro-node-in 320ms var(--ease-standard) ${380 + i * 60}ms both`,
              }}
            />
          ))}
      </svg>
    </div>
  )
}
