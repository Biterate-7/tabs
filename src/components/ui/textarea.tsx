import * as React from "react"

import { cn } from "@/lib/utils"

/** HubbleInput's multi-line sibling — same edge, same focus, 8px corner. */
function Textarea({ className, ...props }: React.ComponentProps<"textarea">) {
  return (
    <textarea
      data-slot="textarea"
      className={cn(
        "flex field-sizing-content min-h-16 w-full rounded-md border border-border bg-background px-2.5 py-2 text-body text-foreground",
        "transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-color) outline-none",
        "placeholder:text-tertiary",
        "hover:border-strong focus-visible:border-ring focus-visible:outline-none",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "aria-invalid:border-destructive",
        className
      )}
      {...props}
    />
  )
}

export { Textarea }
