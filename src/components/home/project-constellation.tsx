import { hashUnit } from "@/lib/knowledge-graph/layout"
import { itemKind } from "@/lib/memory/kinds"
import type { KnowledgeItem } from "@/lib/memory/items"
import type { ItemKind } from "@/lib/memory/kinds"
import { cn } from "@/lib/utils"

const RING: Record<ItemKind, number> = { conversation: 0.42, note: 0.42, source: 0.7, file: 0.7 }
const COLOR: Record<ItemKind, string> = {
  conversation: "var(--kind-conversation)",
  source: "var(--kind-source)",
  file: "var(--kind-file)",
  note: "var(--kind-note)",
}
const MAX_DOTS = 36

/**
 * A project drawn as a small system: one mark per item it holds (up to
 * MAX_DOTS), in its kind's colour, on two orbits — conversations and notes
 * close in, sources and files further out — the newest the brightest. The
 * same encoding the Graph uses, so the two read as one language. Real data
 * only: an empty project is an empty orbit.
 */
export function ProjectConstellation({ items, label, className, size = 168 }: { items: readonly KnowledgeItem[]; label: string; className?: string; size?: number }) {
  const shown = items.slice(0, MAX_DOTS)
  const c = size / 2
  return (
    <svg viewBox={`0 0 ${size} ${size}`} width={size} height={size} aria-hidden className={cn("shrink-0 overflow-visible", className)} data-constellation={shown.length}>
      <circle cx={c} cy={c} r={c * 0.92} fill="none" stroke="currentColor" strokeOpacity="0.08" strokeDasharray="2 5" />
      <circle cx={c} cy={c} r={c * 0.7} fill="none" stroke="currentColor" strokeOpacity="0.1" />
      <circle cx={c} cy={c} r={c * 0.42} fill="none" stroke="currentColor" strokeOpacity="0.12" />
      {shown.map((item, index) => {
        const kind = itemKind(item)
        const angle = hashUnit(item.id) * Math.PI * 2
        const r = c * RING[kind] + (hashUnit(`${item.id}:r`) - 0.5) * c * 0.08
        const x = c + Math.cos(angle) * r
        const y = c + Math.sin(angle) * r
        const fresh = 1 - index / Math.max(1, shown.length)
        return (
          <g key={item.id} opacity={0.45 + 0.55 * fresh}>
            <line x1={c} y1={c} x2={x} y2={y} stroke={COLOR[kind]} strokeOpacity={0.12} />
            <circle cx={x} cy={y} r={kind === "conversation" ? 3.4 : 2.8} fill={COLOR[kind]} />
          </g>
        )
      })}
      <circle cx={c} cy={c} r={c * 0.16} fill="var(--card)" stroke="currentColor" strokeOpacity="0.5" />
      <text x={c} y={c} textAnchor="middle" dominantBaseline="central" fill="currentColor" fontSize={c * 0.17} fontWeight={500} style={{ fontFamily: "var(--hb-font-display)" }}>
        {(label.trim().match(/[\p{L}\p{N}]/u)?.[0] ?? "·").toUpperCase()}
      </text>
    </svg>
  )
}
