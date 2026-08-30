"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { markIntroSeen, prefersReducedMotion, shouldPlayIntro, isMobileViewport } from "@/lib/intro"
import { buildIntroTabs } from "./intro-data"
import { IntroTitle } from "./intro-title"
import { ChaosField } from "./chaos-field"
import { ProcessingMachine } from "./processing-machine"
import { OrganizedWorkspace } from "./organized-workspace"
import { SkipButton } from "./skip-button"
import { EXIT_DURATION_MS, FULL_SCHEDULE, REDUCED_SCHEDULE, SKIP_EXIT_DURATION_MS, type IntroPhase } from "./phase"

type IntroDecision = { play: boolean; reduced: boolean; mobile: boolean }

/**
 * Reads everything needed to decide whether/how to play, once, at mount.
 * Safe to touch window/localStorage/matchMedia directly here (no lazy-init
 * SSR risk): TabDumpIntro is only ever rendered from LandingView, which
 * AppShell holds back behind its own post-mount `hydrated` gate — by the
 * time this component's function body first runs, there has already been a
 * real client-side render, never a server one (same precedent as
 * LandingView's own `useState(getOnboardingState)`).
 */
function decideIntro(): IntroDecision {
  return { play: shouldPlayIntro(), reduced: prefersReducedMotion(), mobile: isMobileViewport() }
}

/**
 * Wraps the real landing page. Plays the cinematic chaos→structure intro on
 * a first-ever visit, then reveals `children` (the actual landing page,
 * which is mounted the entire time — see the note on childrenVisible below).
 * On every later visit, or once reduced-motion/skip/completion has run its
 * course, this is a no-op passthrough.
 */
export function TabDumpIntro({ children }: { children: ReactNode }) {
  const [decision] = useState(decideIntro)
  const [phase, setPhase] = useState<IntroPhase>(decision.play ? "title" : "done")
  const [skipped, setSkipped] = useState(false)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const tabs = useMemo(() => buildIntroTabs(decision.mobile), [decision.mobile])

  useEffect(() => {
    if (!decision.play) return

    markIntroSeen()
    const schedule = decision.reduced ? REDUCED_SCHEDULE : FULL_SCHEDULE
    timersRef.current = schedule.map(({ phase: nextPhase, at }) => setTimeout(() => setPhase(nextPhase), at))

    return () => {
      for (const id of timersRef.current) clearTimeout(id)
      timersRef.current = []
    }
  }, [decision.play, decision.reduced])

  function handleSkip() {
    for (const id of timersRef.current) clearTimeout(id)
    setSkipped(true)
    setPhase("exit")
    timersRef.current = [setTimeout(() => setPhase("done"), SKIP_EXIT_DURATION_MS)]
  }

  const showOverlay = phase !== "done"
  const exiting = phase === "exit"
  const exitDurationMs = skipped ? SKIP_EXIT_DURATION_MS : EXIT_DURATION_MS
  // The real landing page starts fading in the moment "exit" begins, in
  // step with the overlay fading out — a crossfade, not a hard cut once the
  // overlay finally unmounts.
  const childrenVisible = phase === "exit" || phase === "done"

  return (
    <>
      {showOverlay && (
        <div
          className="fixed inset-0 z-50 overflow-hidden bg-background"
          data-intro-phase={phase}
          style={{
            opacity: exiting ? 0 : 1,
            transform: exiting ? "scale(1.015)" : "scale(1)",
            transition: `opacity ${exitDurationMs}ms var(--ease-standard), transform ${exitDurationMs}ms var(--ease-standard)`,
          }}
        >
          <IntroTitle phase={phase} />
          <ChaosField phase={phase} tabs={tabs} mobile={decision.mobile} />
          <ProcessingMachine phase={phase} tabs={tabs} />
          <OrganizedWorkspace phase={phase} tabs={tabs} />
          <SkipButton onSkip={handleSkip} />
        </div>
      )}
      <div
        style={{
          opacity: childrenVisible ? 1 : 0,
          transition: showOverlay ? `opacity ${exitDurationMs}ms var(--ease-standard)` : undefined,
        }}
      >
        {children}
      </div>
    </>
  )
}
