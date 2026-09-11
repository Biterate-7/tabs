"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * Fires once, the first time `ref`'s element is meaningfully on screen.
 *
 * Once, not on every crossing: a section that re-animates each time it
 * scrolls back into view reads as a nervous page, and a reader scrubbing up
 * and down would keep restarting demos mid-interaction. The observer
 * disconnects itself on the first hit, so a long page costs at most one
 * short-lived observer per revealing element rather than a permanent one.
 *
 * SSR-safe: `shown` starts false and only ever turns true from an effect, so
 * the server and the first client render agree. Where a missing observer
 * would leave content permanently invisible, the fallback is "shown" — a
 * browser without IntersectionObserver gets the whole page, unanimated.
 */
export function useInView<T extends Element>(options?: { rootMargin?: string; threshold?: number }) {
  const ref = useRef<T | null>(null)
  const [shown, setShown] = useState(false)
  // Deliberately eager. A tall demo frame that is already half on screen at
  // rest still only crosses a small fraction of its own height, so a stricter
  // threshold leaves the most important thing on the page invisible until the
  // reader scrolls past it.
  const rootMargin = options?.rootMargin ?? "0px 0px -8% 0px"
  const threshold = options?.threshold ?? 0.05

  useEffect(() => {
    const el = ref.current
    if (!el) return
    if (typeof IntersectionObserver !== "function") {
      // Reading a browser capability, which is exactly the "synchronize with
      // an external system" case an effect is for — it cannot be derived
      // during render without breaking SSR.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setShown(true)
      return
    }

    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) {
            setShown(true)
            observer.disconnect()
          }
        }
      },
      { rootMargin, threshold }
    )
    observer.observe(el)
    return () => observer.disconnect()
  }, [rootMargin, threshold])

  return { ref, shown }
}

/**
 * The visitor's reduced-motion preference, kept live.
 *
 * globals.css already collapses every CSS animation/transition duration when
 * this is set, which handles presentation. What it cannot handle is
 * *choreography* — a demo that advances itself through six timed states would
 * still run its timers and flash through the whole sequence instantly. Every
 * self-advancing demo on this page reads this and jumps straight to its
 * finished state instead, leaving the manual controls fully usable.
 *
 * Returns false during SSR and the first client render (the honest answer
 * before a media query can be consulted), then corrects in an effect.
 */
export function useReducedMotion(): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (typeof window.matchMedia !== "function") return
    const query = window.matchMedia("(prefers-reduced-motion: reduce)")
    // The initial read of a media query — the same external subscription the
    // listener below continues. There is no render-time equivalent: the
    // server has no media queries to consult.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduced(query.matches)
    const onChange = (e: MediaQueryListEvent) => setReduced(e.matches)
    query.addEventListener("change", onChange)
    return () => query.removeEventListener("change", onChange)
  }, [])

  return reduced
}

/**
 * A cancellable sequence of timed steps, for demos that play themselves.
 *
 * Exists so the page has exactly one implementation of "advance through these
 * stages, and drop every pending timer the moment the user takes over or the
 * component unmounts". Hand-rolled setTimeout chains inside each demo were
 * the alternative, and they leak: a user who clicks Replay mid-run would
 * otherwise get two overlapping sequences writing to the same state.
 */
export function useSequence() {
  const timers = useRef<ReturnType<typeof setTimeout>[]>([])

  const clear = useCallback(() => {
    for (const t of timers.current) clearTimeout(t)
    timers.current = []
  }, [])

  const run = useCallback(
    (steps: { at: number; do: () => void }[]) => {
      clear()
      for (const step of steps) {
        timers.current.push(setTimeout(step.do, step.at))
      }
    },
    [clear]
  )

  useEffect(() => clear, [clear])

  return { run, clear }
}

/**
 * Counts from 0 to `target` over `duration`, on requestAnimationFrame.
 *
 * Used for the hero's "142 tabs" readout and the duplicate tallies. rAF
 * rather than a setInterval tick so the count stays in step with the motion
 * it accompanies, and the easing is a plain cubic ease-out — a counter that
 * decelerates reads as a measurement settling, which is the point.
 */
export function useCountUp(target: number, active: boolean, duration = 900): number {
  const [value, setValue] = useState(0)
  const reduced = useReducedMotion()

  useEffect(() => {
    if (!active) return
    if (reduced || typeof requestAnimationFrame !== "function") {
      // No frames to animate over, so the count has nowhere to travel from.
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(target)
      return
    }

    let frame = 0
    const start = performance.now()
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / duration)
      const eased = 1 - Math.pow(1 - t, 3)
      setValue(Math.round(target * eased))
      if (t < 1) frame = requestAnimationFrame(tick)
    }
    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, active, duration, reduced])

  // Derived rather than reset in the effect: while inactive the counter is
  // simply zero, and the next activation starts its ramp from there.
  return active ? value : 0
}
