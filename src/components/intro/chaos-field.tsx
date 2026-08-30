import { useMemo, type CSSProperties } from "react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { computeChaosLayout, type IntroTab } from "./intro-data"
import type { IntroPhase } from "./phase"

const CONVERGE_MS = 760

function chipStyle(layout: ReturnType<typeof computeChaosLayout> extends Map<string, infer V> ? V : never, phase: IntroPhase): CSSProperties {
  // Depth ordering carries through chaos and converge so nearby chips
  // visibly pass over/under each other during the funnel, not just slide on
  // one flat plane.
  const base: CSSProperties = { position: "absolute", zIndex: layout.zIndex }

  if (phase === "chaos") {
    return {
      ...base,
      left: `${layout.xPct}%`,
      top: `${layout.yPct}%`,
      opacity: 1,
      transform: `translate(-50%, -50%) rotate(${layout.rotDeg}deg) scale(${layout.scale})`,
      transition: `opacity 420ms var(--ease-standard) ${layout.entranceDelayMs}ms, transform 420ms var(--ease-standard) ${layout.entranceDelayMs}ms`,
    }
  }

  if (phase === "converge" || phase === "machine") {
    const arrived = phase === "machine"
    return {
      ...base,
      left: "50%",
      top: "50%",
      opacity: arrived ? 0 : 1,
      transform: `translate(-50%, -50%) rotate(0deg) scale(${arrived ? 0.18 : 0.5})`,
      transition: [
        `left ${CONVERGE_MS}ms var(--ease-intro-converge) ${layout.convergeDelayMs}ms`,
        `top ${CONVERGE_MS}ms var(--ease-intro-converge) ${layout.convergeDelayMs}ms`,
        `transform ${CONVERGE_MS}ms var(--ease-intro-converge) ${layout.convergeDelayMs}ms`,
        `opacity 320ms var(--ease-standard) ${arrived ? 0 : layout.convergeDelayMs}ms`,
      ].join(", "),
    }
  }

  // "title" (not yet arrived) and everything past "machine" — invisible, no transition (avoids a stray fade-in replaying if a phase is ever revisited).
  return { ...base, left: `${layout.xPct}%`, top: `${layout.yPct}%`, opacity: 0, transform: "translate(-50%, -50%) scale(0.9)" }
}

function IntroChip({ tab, mobile }: { tab: IntroTab; mobile: boolean }) {
  return (
    <div className="flex items-center gap-1.5 rounded-md border border-subtle bg-card px-2 py-1.5 shadow-sm">
      <TabFavicon domain={tab.domain} size={14} />
      <span className={mobile ? "max-w-[64px] truncate text-body-sm text-foreground" : "max-w-[104px] truncate text-body-sm text-foreground"}>
        {tab.label}
      </span>
    </div>
  )
}

/**
 * Scene 2–4's scattered tabs. Mounted for the whole intro lifetime (not just
 * while visually relevant) so the "converge" phase's transform transition has
 * something to animate from — a fresh mount would just pop into place.
 * Positions/timing come from a memoized, seeded layout (intro-data.ts), never
 * recomputed on re-render, and the per-chip motion is a plain CSS transition
 * driven by a handful of phase changes — not a per-frame state update.
 */
export function ChaosField({ phase, tabs, mobile }: { phase: IntroPhase; tabs: IntroTab[]; mobile: boolean }) {
  const layout = useMemo(() => computeChaosLayout(tabs, mobile), [tabs, mobile])
  // Each chip already animates its own opacity (see chipStyle); by the time
  // "machine" hands off to "organized" every chip has finished fading to 0
  // (the converge+funnel transition completes well inside the "machine"
  // phase's hold time), so this wrapper only needs a hard toggle — no
  // transition of its own to coordinate with the per-chip ones.
  const visible = phase === "chaos" || phase === "converge" || phase === "machine"

  return (
    <div
      className="absolute inset-0"
      style={{ opacity: visible ? 1 : 0, pointerEvents: "none" }}
      aria-hidden
    >
      {tabs.map((tab) => {
        const tabLayout = layout.get(tab.id)
        if (!tabLayout) return null
        return (
          <div key={tab.id} style={chipStyle(tabLayout, phase)}>
            <IntroChip tab={tab} mobile={mobile} />
          </div>
        )
      })}
    </div>
  )
}
