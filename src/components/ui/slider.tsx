"use client"

import { Slider as SliderPrimitive } from "@base-ui/react/slider"

import { cn } from "@/lib/utils"

function Slider({
  className,
  ...props
}: SliderPrimitive.Root.Props<number>) {
  return (
    <SliderPrimitive.Root data-slot="slider" className={cn("relative flex w-full touch-none items-center py-1.5", className)} {...props}>
      <SliderPrimitive.Control className="flex w-full items-center py-1">
        <SliderPrimitive.Track className="relative h-1.5 w-full grow rounded-full bg-border">
          <SliderPrimitive.Indicator className="absolute h-full rounded-full bg-primary" />
          <SliderPrimitive.Thumb
            data-slot="slider-thumb"
            className="block size-4 rounded-full border-2 border-primary bg-background shadow-sm transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:opacity-50"
          />
        </SliderPrimitive.Track>
      </SliderPrimitive.Control>
    </SliderPrimitive.Root>
  )
}

export { Slider }
