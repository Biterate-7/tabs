"use client"

import { useMemo, useSyncExternalStore } from "react"
import { projectActivitySnapshot, projectEventsIn, subscribeProjectActivity } from "@/lib/projects/activity"
import type { ProjectEvent } from "@/lib/projects/activity"

/** One project's history, newest first, live across every surface that records into it. */
export function useProjectActivity(workspaceId: string | undefined): ProjectEvent[] {
  // The raw string is the snapshot: stable while nothing is written, so this re-renders only on a real change.
  const snapshot = useSyncExternalStore(subscribeProjectActivity, projectActivitySnapshot, () => null)
  return useMemo(() => projectEventsIn(snapshot, workspaceId), [snapshot, workspaceId])
}
