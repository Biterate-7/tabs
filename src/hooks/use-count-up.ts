"use client"

import { useEffect, useRef, useState } from "react"

export function useCountUp(target: number, options?: { durationMs?: number }): number {
  const durationMs = options?.durationMs ?? 500
  const [value, setValue] = useState(0)
  const previousTarget = useRef<number | null>(null)

  useEffect(() => {
    if (previousTarget.current === target) return
    previousTarget.current = target

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
