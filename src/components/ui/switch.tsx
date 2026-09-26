"use client"

import { Switch as SwitchPrimitive } from "@base-ui/react/switch"

import { cn } from "@/lib/utils"

/** A 28×16 toggle: a 20% track that fills with ink when on. */
function Switch({ className, ...props }: SwitchPrimitive.Root.Props) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "peer inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-transparent bg-input transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none",
        "focus-visible:ring-2 focus-visible:ring-ring/60",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-checked:bg-primary",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        className="pointer-events-none block size-3 translate-x-0.5 rounded-full bg-background shadow-sm transition-transform duration-(--duration-fast) ease-(--ease-standard) data-checked:translate-x-[13px]"
      />
    </SwitchPrimitive.Root>
  )
}

export { Switch }
