"use client"

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { prefersReducedMotion, shouldPlayIntro, isMobileViewport } from "@/lib/intro"
import { useIntroSound, type IntroSound } from "@/hooks/use-intro-sound"
import { buildIntroTabs, computeChaosLayout, CARD_STAGGER_MS } from "./intro-data"
import { IntroTitle } from "./intro-title"
import { ChaosField } from "./chaos-field"
import { ProcessingMachine } from "./processing-machine"
import { OrganizedWorkspace } from "./organized-workspace"
import { SkipButton } from "./skip-button"
import { IntroRevealProvider } from "./intro-reveal"
import { EXIT_DURATION_MS, FULL_SCHEDULE, REDUCED_SCHEDULE, SKIP_EXIT_DURATION_MS, type IntroPhase } from "./phase"

/**
 * Scene-level sound hooks, keyed to the same FULL_SCHEDULE phase timestamps
 * that drive the visuals — not an independent timeline. See intro-audio.ts
 * for what each one actually plays.
 */
const PHASE_SOUND: Partial<Record<IntroPhase, (sound: IntroSound) => void>> = {
  converge: (sound) => sound.convergeWhoosh(1),
  machine: (sound) => sound.machineHumStart(),
  organized: (sound) => {
    sound.machineHumStop()
    sound.sortWhoosh()
  },
  exit: (sound) => sound.transition(),
  done: (sound) => sound.dispose(),
}

/** A sparse subset of the graph's edges get a pulse — never all of them. */
const GRAPH_PULSE_EDGE_INDICES = [0, 3, 6]

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
 * Wraps the real landing page. Plays the cinematic chaos→structure intro
 * whenever the "Play intro animation" setting is on (see lib/settings.ts —
 * every fresh load, not just a first-ever visit), then reveals `children`
 * (the actual landing page, which is mounted the entire time — see the note
 * on childrenVisible below). LandingView only mounts this wrapper at all
 * when the setting is on; once reduced-motion/skip/completion has run its
 * course this is a no-op passthrough.
 */
export function TabDumpIntro({ children }: { children: ReactNode }) {
  const [decision] = useState(decideIntro)
  const [phase, setPhase] = useState<IntroPhase>(decision.play ? "title" : "done")
  const [skipped, setSkipped] = useState(false)
  const timersRef = useRef<ReturnType<typeof setTimeout>[]>([])

  const tabs = useMemo(() => buildIntroTabs(decision.mobile), [decision.mobile])
  const chaosLayout = useMemo(() => computeChaosLayout(tabs, decision.mobile), [tabs, decision.mobile])
  // Reduced motion disables audio outright (per the "minimize under reduced
  // motion" requirement) — every method below becomes a no-op, so the
  // scheduling code beneath never needs its own reduced-motion branch.
  const sound = useIntroSound(decision.play && !decision.reduced)

  useEffect(() => {
    if (!decision.play) return

    const schedule = decision.reduced ? REDUCED_SCHEDULE : FULL_SCHEDULE
    const timers: ReturnType<typeof setTimeout>[] = schedule.map(({ phase: nextPhase, at }) =>
      setTimeout(() => {
        setPhase(nextPhase)
        PHASE_SOUND[nextPhase]?.(sound)
      }, at)
    )

    // The wordmark's entrance animation starts immediately; the tone lands
    // just as it becomes visible.
    timers.push(setTimeout(() => sound.title(), 180))

    if (!decision.reduced) {
      const at = (target: IntroPhase) => FULL_SCHEDULE.find((entry) => entry.phase === target)!.at

      // A sparse handful of scattering tabs get a tiny tick, timed off the
      // exact same per-tab entrance delay that drives their CSS transition —
      // never all of them, never a fresh/independent timeline.
      let tickIndex = 0
      for (const layout of chaosLayout.values()) {
        tickIndex += 1
        if (tickIndex % 4 !== 0) continue
        timers.push(setTimeout(() => sound.chaosTick(), at("chaos") + layout.entranceDelayMs))
      }

      // A second, slightly fuller whoosh as more tabs join the funnel.
      timers.push(setTimeout(() => sound.convergeWhoosh(1.7), at("converge") + 320))

      for (const offset of [280, 620, 980, 1340]) {
        timers.push(setTimeout(() => sound.machineClick(), at("machine") + offset))
      }

      // One snap per collection card, on the same beat as its stagger.
      for (const delayMs of CARD_STAGGER_MS) {
        timers.push(setTimeout(() => sound.sortSnap(), at("organized") + delayMs))
      }
      timers.push(
        setTimeout(() => sound.resolve(), at("organized") + CARD_STAGGER_MS[CARD_STAGGER_MS.length - 1] + 260)
      )

      for (const i of GRAPH_PULSE_EDGE_INDICES) {
        timers.push(setTimeout(() => sound.graphPulse(), at("graph") + 120 + i * 70))
      }
    }

    timersRef.current = timers
    return () => {
      for (const id of timersRef.current) clearTimeout(id)
      timersRef.current = []
    }
  }, [decision.play, decision.reduced, sound, chaosLayout])

  function handleSkip() {
    for (const id of timersRef.current) clearTimeout(id)
    timersRef.current = []
    sound.dispose()
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
  // Only a session where the intro actually plays (completed or skipped)
  // gets the hero's staggered reveal — with the setting off, LandingView
  // never mounts this component at all, so the hero just renders instantly
  // with no animation.
  const revealActive = decision.play && childrenVisible

  return (
    <>
      {showOverlay && (
        <div
          className="fixed inset-0 z-50 overflow-hidden bg-background"
          data-intro-phase={phase}
          style={{
            opacity: exiting ? 0 : 1,
            // A slightly larger push than a plain crossfade would use — paired
            // with OrganizedWorkspace's own, more dramatic graph expansion,
            // it reads as a camera dollying forward through the scene rather
            // than two flat layers swapping.
            transform: exiting ? "scale(1.035)" : "scale(1)",
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
        <IntroRevealProvider active={revealActive}>{children}</IntroRevealProvider>
      </div>
    </>
  )
}
