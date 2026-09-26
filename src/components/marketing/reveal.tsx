"use client"

import { useEffect, useRef, type ComponentPropsWithoutRef, type CSSProperties } from "react"
import { cn } from "@/lib/utils"

/**
 * How much of a section has to be on screen before it reveals.
 */
export const REVEAL_THRESHOLD = 0.2

/**
 * A page section that reveals itself the first time the visitor scrolls it
 * into view, then stays revealed. Its `.m-reveal-item` descendants fade and
 * rise into place in step order (see `revealStep` and marketing.css).
 *
 * The section is visible unless this hook has positively decided to hide it,
 * so a server render, a missing IntersectionObserver or a visitor who prefers
 * reduced motion all get the page as it is. It only ever hides a section that
 * is wholly below the viewport when the page mounts, so nothing the visitor
 * can already see disappears and comes back.
 *
 * State is a `data-reveal` attribute written straight onto the element, not
 * React state: revealing re-renders nothing, the server and client markup are
 * identical, and the live window inside never learns it happened. The same
 * nearness idea as `WhenNear`, kept separate so a window's mounting and its
 * section's reveal never wait on each other.
 */
export function useReveal<T extends HTMLElement>() {
  const ref = useRef<T>(null)
  useEffect(() => {
    const element = ref.current
    if (!element || element.dataset.reveal === "revealed") return
    if (typeof IntersectionObserver === "undefined") return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return
    if (element.getBoundingClientRect().top < window.innerHeight) return

    element.dataset.reveal = "pending"
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting && entry.intersectionRatio >= REVEAL_THRESHOLD * 0.99)) {
          element.dataset.reveal = "revealed"
          observer.disconnect()
        }
      },
      { threshold: REVEAL_THRESHOLD }
    )
    observer.observe(element)
    return () => observer.disconnect()
  }, [])
  return ref
}

/** A `<section>` that reveals on first view. See `useReveal`. */
export function RevealSection({ className, ...props }: ComponentPropsWithoutRef<"section">) {
  const ref = useReveal<HTMLElement>()
  return <section ref={ref} className={cn("m-reveal", className)} {...props} />
}

/** Where an `.m-reveal-item` falls in its section's stagger, from 0. */
export function revealStep(step: number): CSSProperties {
  return { "--m-reveal-step": step } as CSSProperties
}
