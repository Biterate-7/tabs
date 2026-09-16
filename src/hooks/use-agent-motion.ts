"use client"

import { useEffect, useState } from "react"
import { useOptionalAppearanceContext } from "@/components/appearance-provider"
import { resolveAgentMotion } from "@/lib/agents/visual/animation"
import type {
  AgentMotionPolicy,
  WorldAnimationIntensity,
} from "@/lib/agents/visual/animation"

/**
 * How much the agent visuals are allowed to move.
 *
 * Three independent voices can each ask for less, and the narrowest wins:
 *
 *   1. the OS, through `prefers-reduced-motion`;
 *   2. the product, through Settings → Appearance → Motion;
 *   3. the feature, through the Agent World's own intensity control.
 *
 * Reading all three in one place is what keeps them from being checked
 * inconsistently — the failure this replaces is a component that honours the
 * OS preference but not the app setting, which is invisible until someone
 * with vestibular sensitivity turns the app setting off and the icons keep
 * pulsing.
 *
 * This is a *second* line of defence, not the only one. `globals.css` already
 * flattens every CSS animation in the document under both
 * `prefers-reduced-motion` and `[data-motion="off"]`, so agent animation
 * would stop even if this hook were wrong. What the hook adds is the ability
 * to not schedule the animation at all, which is cheaper, and to reason about
 * the policy in code — the world uses it to decide whether a character
 * *moves between stations* or simply appears at the new one, which is a
 * layout decision CSS cannot make.
 */

/**
 * Whether the OS asks for reduced motion, for callers outside
 * AppearanceProvider.
 *
 * Starts false and corrects itself in an effect, exactly as
 * `useAppearance` does — the first render has to match the server's, and the
 * server has no media queries. Guarded with `?.` because jsdom does not
 * implement `matchMedia`, and a hook that threw there would take down every
 * test that rendered an agent.
 */
function useSystemReducedMotion(enabled: boolean): boolean {
  const [reduced, setReduced] = useState(false)

  useEffect(() => {
    if (!enabled) return
    const media = window.matchMedia?.("(prefers-reduced-motion: reduce)")
    if (!media) return

    // The same shape `useAppearance` uses, and the same reason it is allowed:
    // the first render has to match the server's, so the media query can only
    // be consulted after mounting.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setReduced(media.matches)
    const onChange = () => setReduced(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [enabled])

  return reduced
}

export function useAgentMotion(worldIntensity?: WorldAnimationIntensity): AgentMotionPolicy {
  const appearance = useOptionalAppearanceContext()

  // Only subscribe to the media query when nothing else is already watching
  // it. Inside AppearanceProvider — which is everywhere in the real app —
  // this adds no listener at all.
  const fallbackReduced = useSystemReducedMotion(appearance === null)

  return resolveAgentMotion({
    prefersReducedMotion: appearance?.prefersReducedMotion ?? fallbackReduced,
    appLevel: appearance?.settings?.motion.level,
    worldIntensity,
  })
}
