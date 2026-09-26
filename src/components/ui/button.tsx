import { Button as ButtonPrimitive } from "@base-ui/react/button"
import { cva, type VariantProps } from "class-variance-authority"

import { cn } from "@/lib/utils"

/*
 * HubbleButton.
 *
 * Two shapes, because the reference system has two, and it is strict about
 * which is which:
 *
 *   rect  (default) — product controls. A 4px corner, 24–32px tall, 12–13px
 *                     label. "Continue", "Build", "Add trigger", every
 *                     action inside a window.
 *   pill            — brand controls on marketing surfaces and the few
 *                     width-fitted choice chips inside the composer. Tall
 *                     (43px) at `hero`, 27px at `nav`.
 *
 * The primary fill is the foreground itself — ink on paper — and hovers to
 * a softer ink; colour is never a button's job. Secondary is a tonal step
 * with a 2.5% hairline; outline is a transparent pill/rect with a 20%
 * hairline. Motion is colour-only at 140ms: a control that is hit hundreds
 * of times a day does not move.
 */
const buttonVariants = cva(
  [
    "group/button inline-flex shrink-0 items-center justify-center border border-transparent bg-clip-padding whitespace-nowrap select-none",
    "font-medium outline-none",
    "transition-[background-color,border-color,color,opacity] duration-(--duration-fast) ease-(--ease-color)",
    "focus-visible:ring-2 focus-visible:ring-ring/60 focus-visible:ring-offset-1 focus-visible:ring-offset-background",
    "disabled:pointer-events-none disabled:opacity-50",
    "aria-invalid:border-destructive",
    "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-3.5",
  ].join(" "),
  {
    variants: {
      variant: {
        default: "bg-primary text-primary-foreground hover:bg-accent-hover aria-expanded:bg-accent-hover",
        secondary:
          "border-subtle bg-surface-active text-foreground hover:bg-[color-mix(in_oklab,var(--surface-active),var(--foreground)_5%)] aria-expanded:bg-[color-mix(in_oklab,var(--surface-active),var(--foreground)_5%)]",
        outline:
          "border-strong bg-transparent text-foreground hover:bg-surface-hover aria-expanded:bg-surface-hover",
        ghost:
          "text-muted-foreground hover:bg-surface-hover hover:text-foreground aria-expanded:bg-surface-hover aria-expanded:text-foreground",
        destructive:
          "bg-destructive/12 text-destructive hover:bg-destructive/20 focus-visible:ring-destructive/40",
        link: "h-auto! px-0! text-link underline-offset-4 hover:underline",
      },
      size: {
        xs: "h-5 gap-1 rounded-xs px-1.5 text-[length:calc(var(--hb-text-11)*var(--tabdump-font-scale))] [&_svg:not([class*='size-'])]:size-3",
        sm: "h-6 gap-1 rounded-xs px-2 text-[length:calc(var(--hb-text-12)*var(--tabdump-font-scale))] [&_svg:not([class*='size-'])]:size-3.5",
        default: "h-7 gap-1.5 rounded-xs px-2.5 text-[length:calc(var(--hb-text-12)*var(--tabdump-font-scale))]",
        lg: "h-8 gap-1.5 rounded-xs px-3 text-[length:calc(var(--hb-text-13)*var(--tabdump-font-scale))] [&_svg:not([class*='size-'])]:size-4",
        icon: "size-7 rounded-xs [&_svg:not([class*='size-'])]:size-4",
        "icon-xs": "size-5 rounded-xs [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-6 rounded-xs [&_svg:not([class*='size-'])]:size-3.5",
        "icon-lg": "size-8 rounded-xs [&_svg:not([class*='size-'])]:size-4",
        // Brand sizes — marketing surfaces only. Measured: 27px / 14px label
        // in the header, 43px / 16px label for the hero call to action.
        nav: "h-[27px] gap-1 rounded-full px-[0.75em] font-normal text-[14px] tracking-[0.01em]",
        hero: "h-[43px] gap-1.5 rounded-full px-[1.35em] font-normal text-[16px] [&_svg:not([class*='size-'])]:size-4",
      },
      shape: {
        rect: "",
        pill: "rounded-full",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
      shape: "rect",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  shape = "rect",
  ...props
}: ButtonPrimitive.Props & VariantProps<typeof buttonVariants>) {
  return (
    <ButtonPrimitive
      data-slot="button"
      className={cn(buttonVariants({ variant, size, shape, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
