"use client"

import { ArrowRight } from "lucide-react"
import { Button } from "@/components/ui/button"

/**
 * The terminal state of the landing CTA once TabInput's "Organizing…" beat
 * finishes — establishes the visual hierarchy for the dump moment (title /
 * count / primary action) that a later phase can replace with an animated
 * spatial arrival. Deliberately just this: no animation choreography here.
 */
export function DumpConfirmation({
  count,
  onView,
}: {
  count: number
  onView: () => void
}) {
  return (
    <div className="w-full text-center duration-(--duration-slow) ease-(--ease-standard) animate-in fade-in-0 slide-in-from-bottom-1 sm:text-left">
      <p className="text-h1 text-foreground">Dump tabs</p>
      <p className="mt-1 text-body text-muted-foreground">
        {count} tab{count === 1 ? "" : "s"} imported
      </p>
      <Button size="lg" className="mt-6 w-full sm:w-auto" onClick={onView} autoFocus>
        View workspace <ArrowRight />
      </Button>
    </div>
  )
}
