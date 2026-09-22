"use client"

import { useEffect, useState } from "react"

/**
 * The current time, as a value that re-renders.
 *
 * ## Why a hook rather than `Date.now()` in the component
 *
 * `Date.now()` called during render is impure — it makes the same props
 * produce different output — and the two places this exists for genuinely need
 * the value to *move*: an approval counting down to its expiry, and a session
 * list saying how long ago each one was touched. A frozen timestamp would show
 * "Expires in 5m" until something unrelated caused a re-render.
 *
 * The default interval is coarse on purpose. Relative labels are rounded to
 * minutes, so ticking faster would re-render the list for no visible change.
 * A caller that is showing seconds passes something shorter.
 */
export function useNow(intervalMs = 30_000): number {
  const [now, setNow] = useState(() => Date.now())

  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), intervalMs)
    return () => clearInterval(timer)
  }, [intervalMs])

  return now
}
