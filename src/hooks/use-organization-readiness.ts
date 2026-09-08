"use client"

import { useCallback, useMemo, useRef, useState } from "react"
import {
  advanceOrganization,
  beginSettling,
  completeOrganization,
  describeOrganizationStage,
  dismissOrganizationError,
  failOrganization,
  idleOrganizationState,
  isGraphAvailable,
  startOrganization,
  type OrganizationStage,
  type OrganizationState,
} from "@/lib/organize/lifecycle"

export type OrganizationReadiness = {
  state: OrganizationState
  /** True exactly when the Graph View may be entered — see lib/organize/lifecycle.ts. */
  graphAvailable: boolean
  label: string
  /** Opens a new generation and returns it. Every later transition for this dump must be given that generation back. */
  begin: (tabCount: number) => number
  advance: (generation: number, stage: OrganizationStage) => void
  /** Enters (or, with an explicit stage, moves within) the layout half. Stays in the `settling` status throughout, so a stage change here never looks like a new phase to anything watching status. */
  startSettling: (generation: number, stage?: "arranging" | "settling") => void
  complete: (generation: number) => void
  fail: (generation: number, message: string) => void
  dismissError: () => void
}

/**
 * React binding for the dump lifecycle state machine. Holds no logic of its
 * own: every transition is the corresponding pure function from
 * lib/organize/lifecycle.ts, applied through a functional update.
 *
 * That is what makes stale-dump safety free rather than something each call
 * site has to remember. `begin` is the only thing that mints a generation,
 * and every other transition is a no-op unless the generation it was given
 * is still the live one — so a first dump's pipeline resolving after a
 * second dump has already started simply does nothing, instead of unlocking
 * the graph on top of work that is still running.
 */
export function useOrganizationReadiness(): OrganizationReadiness {
  const [state, setState] = useState<OrganizationState>(idleOrganizationState)
  // Generations are minted here, not inside a state updater: `begin` has to
  // hand the caller the id synchronously (it goes straight into the async
  // pipeline call on the next line), and a functional update runs later, at
  // render time. This ref is the only writer of `generation`, so it and the
  // state can never drift.
  const generationRef = useRef(0)

  const begin = useCallback((tabCount: number) => {
    const generation = ++generationRef.current
    setState(startOrganization(generation, tabCount))
    return generation
  }, [])

  const advance = useCallback((generation: number, stage: OrganizationStage) => {
    setState((prev) => advanceOrganization(prev, generation, stage))
  }, [])

  const startSettling = useCallback((generation: number, stage: "arranging" | "settling" = "arranging") => {
    setState((prev) => beginSettling(prev, generation, stage))
  }, [])

  const complete = useCallback((generation: number) => {
    setState((prev) => completeOrganization(prev, generation))
  }, [])

  const fail = useCallback((generation: number, message: string) => {
    setState((prev) => failOrganization(prev, generation, message))
  }, [])

  const dismissError = useCallback(() => {
    setState(dismissOrganizationError)
  }, [])

  return useMemo(
    () => ({
      state,
      graphAvailable: isGraphAvailable(state),
      label: describeOrganizationStage(state),
      begin,
      advance,
      startSettling,
      complete,
      fail,
      dismissError,
    }),
    [state, begin, advance, startSettling, complete, fail, dismissError]
  )
}
