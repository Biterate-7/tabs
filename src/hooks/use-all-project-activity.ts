"use client"

import { useMemo, useSyncExternalStore } from "react"
import { parseProjectActivity, projectActivitySnapshot, subscribeProjectActivity } from "@/lib/projects/activity"
import type { ProjectEvent } from "@/lib/projects/activity"

/** Every project's history at once (Home's activity column), live as anything records into it. */
export function useAllProjectActivity(): ProjectEvent[] {
  const snapshot = useSyncExternalStore(subscribeProjectActivity, projectActivitySnapshot, () => null)
  return useMemo(() => parseProjectActivity(snapshot), [snapshot])
}
