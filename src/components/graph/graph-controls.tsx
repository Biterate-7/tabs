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
    <div className="absolute bottom-4 right-4 z-10 flex flex-col gap-0.5 rounded-lg border border-subtle bg-popover/95 p-1 shadow-md ring-1 ring-foreground/10 backdrop-blur-sm">
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
