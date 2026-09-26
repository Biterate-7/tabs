"use client"

import * as React from "react"
import { Popover as PopoverPrimitive } from "@base-ui/react/popover"

import { cn } from "@/lib/utils"
import { usePortalContainer } from "@/components/ui/portal-container"

function Popover({ ...props }: PopoverPrimitive.Root.Props) {
  return <PopoverPrimitive.Root data-slot="popover" {...props} />
}

function PopoverTrigger({ ...props }: PopoverPrimitive.Trigger.Props) {
  return <PopoverPrimitive.Trigger data-slot="popover-trigger" {...props} />
}

function PopoverContent({
  className,
  sideOffset = 8,
  align = "end",
  children,
  ...props
}: PopoverPrimitive.Popup.Props &
  Pick<PopoverPrimitive.Positioner.Props, "sideOffset" | "align">) {
  const container = usePortalContainer()
  return (
    <PopoverPrimitive.Portal container={container}>
      <PopoverPrimitive.Positioner className="isolate z-50" sideOffset={sideOffset} align={align}>
        <PopoverPrimitive.Popup
          data-slot="popover-content"
          className={cn(
            "w-72 rounded-lg border border-border bg-popover p-3 text-body text-popover-foreground shadow-md",
            "origin-(--transform-origin) transition-[transform,opacity] duration-(--duration-fast) ease-(--ease-standard)",
            "data-starting-style:scale-[0.98] data-starting-style:opacity-0 data-ending-style:scale-[0.98] data-ending-style:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </PopoverPrimitive.Popup>
      </PopoverPrimitive.Positioner>
    </PopoverPrimitive.Portal>
  )
}

export { Popover, PopoverTrigger, PopoverContent }
