"use client"

import { useState, type KeyboardEvent, type ReactNode } from "react"
import { PortalContainerContext } from "@/components/ui/portal-container"
import { cn } from "@/lib/utils"
import { useHubbleDemo } from "./demo-provider"

/**
 * A Hubble window on the page: the product at its own sizes and in its own
 * palette (`.m-app`, see demo-theme.tsx), in a 10px corner with the long
 * window shadow.
 *
 * Live, not a picture — every control in it works, and it is a named region
 * so assistive technology can find it and skip it. Two details make a live
 * app behave on a page:
 *
 *  - The window is its own stacking layer (`isolate`), so the app's sticky
 *    bars and drawers never paint over the page's header as it scrolls past.
 *  - Overlays the window opens — dialogs, menus, tooltips, the command
 *    palette — portal into a sibling that carries the same app palette, so
 *    they sit above the page as the app's do above the app, instead of being
 *    clipped by the window or picking up the visitor's own app theme from
 *    :root.
 *
 * ⌘K / Ctrl+K opens the demo's command palette, but only while focus is
 * inside the window: on the rest of the page the browser keeps its shortcut.
 */
export function DemoFrame({
  label,
  className,
  palette = false,
  children,
}: {
  label: string
  className?: string
  /** Whether ⌘K opens a palette in this window (the full app demo has one). */
  palette?: boolean
  children: ReactNode
}) {
  const { dispatch } = useHubbleDemo()
  const [portal, setPortal] = useState<HTMLDivElement | null>(null)

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (!palette) return
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
      event.preventDefault()
      dispatch({ type: "palette", open: true })
    }
  }

  return (
    <>
      <section aria-label={label} data-hubble-demo="" className={cn("m-app m-demo-window", className)} onKeyDown={onKeyDown}>
        <PortalContainerContext.Provider value={portal}>{children}</PortalContainerContext.Provider>
      </section>
      <div ref={setPortal} className="m-app m-demo-portal" data-hubble-demo-portal="" />
    </>
  )
}
