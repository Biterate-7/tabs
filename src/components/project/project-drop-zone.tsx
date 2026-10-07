"use client"

import { useEffect, useRef, useState } from "react"
import { Plus } from "lucide-react"
import { dragCarriesResources, readDroppedResources } from "@/lib/resources/drop"
import type { DroppedResources } from "@/lib/resources/drop"

/**
 * Dropping things from Chrome into a project (Hubble 2.0).
 *
 * Listens on the window while a project is on screen, so a link can be
 * dropped anywhere over it — no target to aim for. Only drags that come from
 * outside the page count: a drag that *started* here (moving a tab into a
 * collection, selecting text) is the app's own and is left alone. Nothing
 * moves while dragging; a fixed overlay names the project, and leaving the
 * window or pressing Escape cancels with nothing added.
 *
 * Dropping is never the only way in — the project's Add source button does
 * the same thing from the keyboard.
 */
export function useExternalDrop(options: { enabled: boolean; onDrop: (dropped: DroppedResources) => void }): { active: boolean } {
  const [active, setActive] = useState(false)
  const onDropRef = useRef(options.onDrop)
  useEffect(() => {
    onDropRef.current = options.onDrop
  })

  useEffect(() => {
    if (!options.enabled) return
    let internal = false
    let depth = 0
    const reset = () => {
      depth = 0
      setActive(false)
    }
    const external = (event: DragEvent) => !internal && dragCarriesResources(event.dataTransfer)

    function onDragStart() {
      internal = true
    }
    function onDragEnd() {
      internal = false
      reset()
    }
    function onDragEnter(event: DragEvent) {
      if (!external(event)) return
      depth += 1
      setActive(true)
    }
    function onDragOver(event: DragEvent) {
      if (!external(event)) return
      // Without this the browser would navigate to a dropped link instead of handing it to the page.
      event.preventDefault()
      if (event.dataTransfer) event.dataTransfer.dropEffect = "copy"
    }
    function onDragLeave(event: DragEvent) {
      if (!external(event)) return
      depth = Math.max(0, depth - 1)
      // Leaving the window entirely reports no related target.
      if (depth === 0 || event.relatedTarget === null) reset()
    }
    function onDrop(event: DragEvent) {
      if (!external(event) || !event.dataTransfer) return
      event.preventDefault()
      reset()
      onDropRef.current(readDroppedResources(event.dataTransfer))
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") reset()
    }

    window.addEventListener("dragstart", onDragStart)
    window.addEventListener("dragend", onDragEnd)
    window.addEventListener("dragenter", onDragEnter)
    window.addEventListener("dragover", onDragOver)
    window.addEventListener("dragleave", onDragLeave)
    window.addEventListener("drop", onDrop)
    window.addEventListener("keydown", onKeyDown)
    return () => {
      window.removeEventListener("dragstart", onDragStart)
      window.removeEventListener("dragend", onDragEnd)
      window.removeEventListener("dragenter", onDragEnter)
      window.removeEventListener("dragover", onDragOver)
      window.removeEventListener("dragleave", onDragLeave)
      window.removeEventListener("drop", onDrop)
      window.removeEventListener("keydown", onKeyDown)
      reset()
    }
  }, [options.enabled])

  return { active }
}

/** The drop highlight: fixed over the content, so nothing beneath it moves. */
export function ProjectDropOverlay({ active, projectName }: { active: boolean; projectName: string }) {
  if (!active) return null
  return (
    <div
      aria-hidden
      className="pointer-events-none fixed inset-0 z-(--hb-z-overlay) flex items-center justify-center p-6"
      data-project-drop-overlay
    >
      <div className="absolute inset-3 rounded-lg border-2 border-dashed border-ring bg-background/80 backdrop-blur-[2px]" />
      <div className="relative flex flex-col items-center gap-1 text-center">
        <p className="text-h2 text-foreground">Drop into {projectName}</p>
        <p className="flex items-center gap-1 text-body text-muted-foreground">
          <Plus aria-hidden className="size-4" /> Add to project
        </p>
      </div>
    </div>
  )
}
