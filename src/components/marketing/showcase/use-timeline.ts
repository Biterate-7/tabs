"use client"

import { useCallback, useEffect, useRef, useState } from "react"

/**
 * The clock behind a product demo: a list of frames, each held for its own
 * duration, played while the demo's window is on screen.
 *
 *  - Before it starts — on the server, without script, without an
 *    IntersectionObserver, or for a visitor who prefers reduced motion — the
 *    demo shows `restFrame`: a complete, meaningful frame, never an empty one.
 *  - A demo below the fold is wound back to `startFrame` while it is still
 *    off screen, so it plays from the beginning when the visitor reaches it.
 *    One already on screen at mount starts from where it rests.
 *  - It runs only while at least `threshold` of the window is visible and
 *    the browser tab is in front; it pauses (keeping its place) otherwise.
 *  - `go(frame)` is the visitor taking over: it jumps there and holds for
 *    `resumeAfter` ms before playing on.
 *
 * Frames advance by re-rendering with a new number; the demo turns that into
 * CSS transitions on data attributes, so nothing remounts between frames.
 */
export type Timeline = {
  /** Attach to the demo's outermost element. */
  attach: (element: HTMLElement | null) => void
  frame: number
  /** Advancing on its own right now. */
  playing: boolean
  /** Whether this visitor gets motion at all (observer present, no reduced-motion preference). */
  animated: boolean
  /** Bumps every time a frame (re)starts — a key for anything that times itself to the frame. */
  run: number
  /** How long the current frame lasts, ms. */
  duration: number
  go: (frame: number) => void
}

export type TimelineOptions = {
  /** How long each frame is held, ms. Frame i lasts durations[i]. */
  durations: readonly number[]
  /** The frame shown before playback, and to visitors who get no motion. */
  restFrame: number
  /** Where playback begins for a demo the visitor scrolls to. */
  startFrame?: number
  /** Back to frame 0 after the last; otherwise the last frame stays. */
  loop?: boolean
  /** How much of the window must be visible for it to play. */
  threshold?: number
  /** How long a visitor's choice holds before the demo plays on, ms. */
  resumeAfter?: number
}

export function useTimeline({ durations, restFrame, startFrame = 0, loop = true, threshold = 0.35, resumeAfter = 9000 }: TimelineOptions): Timeline {
  const [element, setElement] = useState<HTMLElement | null>(null)
  const [frame, setFrame] = useState(restFrame)
  const [run, setRun] = useState(0)
  const [animated, setAnimated] = useState(false)
  const [visible, setVisible] = useState(false)
  const [pageHidden, setPageHidden] = useState(false)
  const [held, setHeld] = useState(false)
  const remaining = useRef(durations[restFrame] ?? 0)
  const durationsRef = useRef(durations)

  useEffect(() => {
    durationsRef.current = durations
  }, [durations])

  // Decide once, on mount, whether this visitor gets motion, and wind a demo
  // that is still below the fold back to its beginning.
  useEffect(() => {
    if (!element || typeof IntersectionObserver === "undefined") return
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches) return
    // eslint-disable-next-line react-hooks/set-state-in-effect -- a one-shot read of the environment the page mounted in
    setAnimated(true)
    if (startFrame !== restFrame && element.getBoundingClientRect().top >= window.innerHeight) {
      remaining.current = durationsRef.current[startFrame] ?? 0
      setFrame(startFrame)
    }
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) setVisible(entry.isIntersecting && entry.intersectionRatio >= threshold * 0.99)
      },
      { threshold: [0, threshold, Math.min(1, threshold + 0.25)] }
    )
    observer.observe(element)
    const onVisibility = () => setPageHidden(document.hidden)
    document.addEventListener("visibilitychange", onVisibility)
    return () => {
      observer.disconnect()
      document.removeEventListener("visibilitychange", onVisibility)
    }
  }, [element, restFrame, startFrame, threshold])

  const last = durations.length - 1
  const finished = !loop && frame >= last
  const playing = animated && visible && !pageHidden && !held && !finished

  useEffect(() => {
    if (!playing) return
    const startedAt = performance.now()
    let advanced = false
    const id = window.setTimeout(() => {
      advanced = true
      const next = frame >= last ? (loop ? 0 : last) : frame + 1
      remaining.current = durationsRef.current[next] ?? 0
      setFrame(next)
      setRun((value) => value + 1)
    }, remaining.current)
    return () => {
      window.clearTimeout(id)
      // Paused part-way: keep the rest of this frame for when it resumes.
      if (!advanced) remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt))
    }
  }, [playing, frame, run, last, loop])

  // A visitor's choice holds for a while, then the demo plays on from there.
  useEffect(() => {
    if (!held) return
    const id = window.setTimeout(() => setHeld(false), resumeAfter)
    return () => window.clearTimeout(id)
  }, [held, run, resumeAfter])

  const go = useCallback((next: number) => {
    remaining.current = durationsRef.current[next] ?? 0
    setFrame(next)
    setRun((value) => value + 1)
    setHeld(true)
  }, [])

  return { attach: setElement, frame, playing, animated, run, duration: durations[frame] ?? 0, go }
}

/** Whether `frame` has reached `from` (and, given `until`, not passed it). */
export function at(frame: number, from: number, until = Infinity): boolean {
  return frame >= from && frame <= until
}
