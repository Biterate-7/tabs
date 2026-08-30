import { EXIT_DURATION_MS, type IntroPhase } from "./phase"

const LABEL_BY_PHASE: Partial<Record<IntroPhase, string>> = {
  converge: "Organizing…",
  machine: "Organizing…",
  organized: "Sorted",
  graph: "Structured",
}

/**
 * The wordmark plays its entrance once on mount (a plain CSS animation, not
 * phase-gated — see intro-title-in in globals.css) and then never moves
 * again. Only the quiet state label beneath it changes, and only via an
 * opacity crossfade — this is the "possible subtle treatment" from the spec,
 * deliberately not a marketing headline.
 */
export function IntroTitle({ phase }: { phase: IntroPhase }) {
  const label = LABEL_BY_PHASE[phase] ?? ""
  const exiting = phase === "exit"

  return (
    <div
      className="pointer-events-none absolute top-[9%] left-1/2 -translate-x-1/2 text-center"
      style={{ animation: "intro-title-in 700ms var(--ease-standard) both" }}
    >
      {/* A second, inner transform layer for the exit lift — kept separate
          from the wrapper above so it never fights the entrance keyframe's
          own `transform` (an active/filling CSS animation wins the cascade
          over a plain inline style on the same property, which would
          silently drop the wrapper's -50% centering). */}
      <div
        style={{
          transform: exiting ? "translateY(-8px)" : "translateY(0)",
          transition: exiting ? `transform ${EXIT_DURATION_MS}ms var(--ease-standard)` : undefined,
        }}
      >
        <p className="text-display font-semibold tracking-tight text-foreground">TABDUMP</p>
        <div className="mx-auto mt-3 h-px w-24 bg-border" />
        <p
          key={label}
          className="mt-3 h-4 text-label text-tertiary uppercase transition-opacity duration-300 ease-(--ease-standard)"
          style={{ opacity: label ? 1 : 0 }}
        >
          {label}
        </p>
      </div>
    </div>
  )
}
