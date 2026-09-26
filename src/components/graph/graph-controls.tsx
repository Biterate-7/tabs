"use client"

import { Maximize, Minus, Plus } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"

export function GraphControls({
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  onZoomIn: () => void
  onZoomOut: () => void
  onFit: () => void
}) {
  return (
    <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-0.5 rounded-md border border-border bg-popover p-1 border border-border shadow-md">
      <IconButton aria-label="Zoom in" onClick={onZoomIn}>
        <Plus />
      </IconButton>
      <IconButton aria-label="Zoom out" onClick={onZoomOut}>
        <Minus />
      </IconButton>
      <div className="mx-1 h-px bg-border" />
      <IconButton aria-label="Fit graph" tooltip="Fit graph" onClick={onFit}>
        <Maximize />
      </IconButton>
    </div>
  )
}
