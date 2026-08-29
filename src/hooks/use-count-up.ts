"use client"

import { useEffect, useState } from "react"

export function useCountUp(target: number, options?: { durationMs?: number }): number {
  const durationMs = options?.durationMs ?? 500
  const [value, setValue] = useState(0)

  // Reruns only when `target`/`durationMs` actually change — React's own
  // dependency comparison already skips re-invocation on an unchanged
  // target, so no extra "did this already run for this target" guard is
  // needed. (A previous version tracked that in a ref, but mutating the
  // ref inside the effect body meant React's dev-mode double-invoke of
  // effects — mount, cleanup, mount — poisoned the guard: the ref got set
  // during the first, soon-to-be-cleaned-up invocation, so the second,
  // real invocation saw a "no change" and skipped scheduling the
  // animation entirely, leaving the value stuck at 0.)
  useEffect(() => {
    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

    if (prefersReducedMotion) {
      // matchMedia is only readable client-side, so this can't be derived
      // during render — it's the "synchronize with an external system"
      // case effects exist for, not the derived-state anti-pattern this
      // rule targets (see the identical precedent in app-shell.tsx).
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setValue(target)
      return
    }

    const start = performance.now()
    const from = 0
    let frame: number

    function tick(now: number) {
      const elapsed = now - start
      const progress = Math.min(1, elapsed / durationMs)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(Math.round(from + (target - from) * eased))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, durationMs])

  return value
}
