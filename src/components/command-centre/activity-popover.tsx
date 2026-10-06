"use client"

import { History } from "lucide-react"
import { IconButton } from "@/components/ui/icon-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { cn } from "@/lib/utils"

/**
 * The activity timeline, one click away, for windows where the context panel
 * that carries it is not on screen — below `xl`, or with the panel closed.
 *
 * The same timeline, not a second one: the caller renders it once and passes
 * it in. A dot on the button says an approval is waiting, in the link colour
 * the rest of the product uses for "needs you", and the button's name says so
 * in words.
 */
export function ActivityPopover({
  waiting,
  className,
  children,
}: {
  /** Whether an entry is waiting on the person. */
  waiting: boolean
  className?: string
  children: React.ReactNode
}) {
  return (
    <Popover>
      <PopoverTrigger
        render={
          <IconButton
            aria-label={waiting ? "Activity — needs your approval" : "Activity"}
            className={cn("relative", className)}
          >
            <History />
            {waiting && <span aria-hidden className="absolute top-1 right-1 size-1.5 rounded-full bg-link" />}
          </IconButton>
        }
      />
      <PopoverContent align="end" className="max-h-[min(70vh,560px)] w-80 overflow-y-auto">
        {children}
      </PopoverContent>
    </Popover>
  )
}
