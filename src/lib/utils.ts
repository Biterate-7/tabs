import { clsx, type ClassValue } from "clsx"
import { extendTailwindMerge } from "tailwind-merge"

/**
 * TabDump's own typography classes (see the `@layer components` block in
 * globals.css). They are `text-*` but they are *type styles* — size, family,
 * leading, tracking — not colours.
 *
 * tailwind-merge has to be told that. Its `text-*` handling treats any
 * unrecognised value as a text colour, so `cn("text-meta", "text-tertiary")`
 * looked to it like two colours on one element and it dropped the first:
 *
 *     twMerge("text-meta text-tertiary")    // -> "text-tertiary"
 *     twMerge("text-body-sm text-foreground") // -> "text-foreground"
 *
 * Every pairing of a type class with a colour class that went through `cn()`
 * therefore lost its size, family and tracking and silently fell back to
 * inherited 16px sans — which is a large part of why product screens read
 * as flatter and coarser than the landing page, whose classes are written
 * as plain strings and never pass through the merger.
 *
 * Registering them under `font-size` gives them the right conflict
 * behaviour in both directions: they still replace each other (two type
 * styles on one element is a real conflict) and they no longer collide with
 * colour.
 */
const TYPE_CLASSES = [
  "display",
  "h1",
  "h2",
  "body",
  "body-sm",
  "label",
  "meta",
  "eyebrow",
  "content",
] as const

const twMerge = extendTailwindMerge({
  extend: {
    classGroups: {
      "font-size": [{ text: [...TYPE_CLASSES] }],
    },
  },
})

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}
