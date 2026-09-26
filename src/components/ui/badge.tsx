import { mergeProps } from "@base-ui/react/merge-props"
import { useRender } from "@base-ui/react/use-render"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/**
 * HubbleBadge — an 18px tag with a 4px corner and 11px text: the "APP" tag
 * beside a name, a count, a state. Tonal, never saturated: the fill is the
 * foreground (or a status colour) at a low alpha, the text is the same hue
 * at full strength.
 */
const badgeVariants = cva(
  "group/badge inline-flex h-[18px] w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-xs border border-transparent px-1.5 text-meta font-medium whitespace-nowrap transition-colors duration-(--duration-fast) focus-visible:ring-2 focus-visible:ring-ring/60 [&>svg]:pointer-events-none [&>svg]:size-3!",
  {
    variants: {
      variant: {
        default: "bg-surface-active text-foreground",
        secondary: "bg-surface-hover text-muted-foreground",
        accent: "bg-link/12 text-link",
        success: "bg-success/12 text-success",
        warning: "bg-warning/14 text-warning",
        destructive: "bg-destructive/12 text-destructive",
        outline: "border-border bg-transparent text-muted-foreground",
        ghost: "text-muted-foreground hover:bg-surface-hover",
        link: "text-link underline-offset-4 hover:underline",
      },
    },
    defaultVariants: {
      variant: "outline",
    },
  }
)

function Badge({
  className,
  variant = "default",
  render,
  ...props
}: useRender.ComponentProps<"span"> & VariantProps<typeof badgeVariants>) {
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(
      {
        className: cn(badgeVariants({ variant }), className),
      },
      props
    ),
    render,
    state: {
      slot: "badge",
      variant,
    },
  })
}

export { Badge, badgeVariants }
