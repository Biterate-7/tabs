import { BUCKET_LABEL, categoryColorVar, type IntroTab } from "./intro-data"
import type { IntroPhase } from "./phase"

const BUCKET_ORDER: IntroTab["bucket"][] = ["research", "projects", "other"]

/**
 * Scene 4 — the "TabDump engine". Deliberately abstract (a thin frame, a
 * scanning line, a few divider ticks) rather than a literal factory, per
 * AGENTS.md. Tabs don't visually travel through this component — ChaosField
 * funnels into the same screen-center point this frame occupies, and this
 * layer's output dots pick up from there, which reads as one continuous
 * pass-through without needing to hand off live DOM elements between the two.
 */
export function ProcessingMachine({ phase, tabs }: { phase: IntroPhase; tabs: IntroTab[] }) {
  const active = phase === "machine"
  const grouped = BUCKET_ORDER.map((bucket) => ({
    bucket,
    tabs: tabs.filter((t) => t.bucket === bucket),
  }))

  return (
    <div
      className="absolute inset-x-0 top-[34%] flex flex-col items-center gap-8"
      style={{
        opacity: active ? 1 : 0,
        transition: `opacity 380ms var(--ease-standard) ${active ? "120ms" : "0ms"}`,
        pointerEvents: "none",
      }}
      aria-hidden
    >
      <div className="relative h-[104px] w-[300px] overflow-hidden rounded-xl border border-border sm:w-[360px]">
        <div className="absolute inset-x-6 top-3 flex justify-center">
          <span className="text-label tracking-[0.14em] text-tertiary uppercase">TabDump Engine</span>
        </div>
        {[25, 50, 75].map((pct, i) => (
          <div
            key={pct}
            className="absolute top-8 bottom-0 w-px bg-border/60"
            style={{
              left: `${pct}%`,
              animation: active ? `intro-divider-shift 2400ms var(--ease-standard) ${i * 220}ms infinite` : undefined,
            }}
          />
        ))}
        {active && (
          <div
            className="absolute top-0 bottom-0 w-16 bg-gradient-to-r from-transparent via-accent-text/25 to-transparent"
            style={{ animation: "intro-scan 1100ms linear infinite" }}
          />
        )}
      </div>

      <div className="flex gap-8 sm:gap-14">
        {grouped.map(({ bucket, tabs: bucketTabs }, groupIndex) => (
          <div key={bucket} className="flex flex-col items-center gap-2">
            <span className="text-label tracking-[0.08em] text-tertiary uppercase">{BUCKET_LABEL[bucket]}</span>
            <div
              className="flex max-w-[64px] flex-wrap justify-center gap-1.5 sm:max-w-[84px]"
              style={{
                animation: active
                  ? `intro-group-breathe 820ms var(--ease-standard) ${360 + groupIndex * 130}ms both`
                  : undefined,
              }}
            >
              {bucketTabs.map((tab, i) => (
                <span
                  key={tab.id}
                  className="size-2 rounded-full"
                  style={{
                    backgroundColor: categoryColorVar(tab.category),
                    opacity: active ? 1 : 0,
                    animation: active ? `intro-dot-in 380ms var(--ease-standard) ${260 + i * 90}ms both` : undefined,
                  }}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
