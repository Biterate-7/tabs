"use client"

import * as React from "react"

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { cn } from "@/lib/utils"

/**
 * A row in the app's navigation rail.
 *
 * This exists because the rail used to be built out of `IconButton`, and a
 * button is the wrong primitive for a destination. Three things followed
 * from that mismatch, all of them visible in the shipped product:
 *
 *  1. Nothing said where you were. `IconButton` has no notion of a current
 *     page, so opening Agent World lit nothing in the rail — the only
 *     `aria-current` anywhere in the shell was on the workspace list.
 *     Apple's Agency principle asks that an interface "keep them informed
 *     about what's happening"; a navigation list that never marks the
 *     current location fails that outright, for sighted and screen-reader
 *     users alike.
 *  2. Every row was 32px because that is `IconButton`'s size. Fine for a
 *     pointer (macOS wants 28pt), too small for the mobile drawer, where
 *     the same rows are the primary touch target and iOS wants 44pt.
 *  3. Destinations and actions looked identical, so the rail read as a
 *     toolbar that happened to navigate.
 *
 * `current` drives both the visual state and `aria-current="page"`, so the
 * two can never drift apart. The active treatment is a filled surface plus a
 * leading accent bar — never colour alone, which would make the current
 * location invisible to anyone who cannot distinguish it (`accessibility.md`
 * › "Nothing is conveyed by color alone").
 */
export interface SidebarItemProps extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  /** The row's accessible name. Shown as the visible label unless `collapsed`. */
  label: string
  icon: React.ReactNode
  /** Marks this as the destination currently on screen. */
  current?: boolean
  /** Icon-rail mode: label hidden, name moves to a tooltip. */
  collapsed?: boolean
  /** A count or short status shown at the trailing edge. Hidden when collapsed. */
  trailing?: React.ReactNode
  /**
   * Larger touch target. Set inside the mobile drawer, where these rows are
   * tapped rather than clicked and 32px is below the platform default.
   */
  touch?: boolean
  /** Shown instead of the label in the tooltip — e.g. why the row is disabled. */
  tooltip?: string
}

export const SidebarItem = React.forwardRef<HTMLButtonElement, SidebarItemProps>(
  ({ label, icon, current, collapsed, trailing, touch, tooltip, className, disabled, ...props }, ref) => {
    const row = (
      <button
        ref={ref}
        type="button"
        data-slot="sidebar-item"
        aria-label={label}
        // "page" rather than "true": these are destinations within one
        // document, which is exactly what the page token is for.
        aria-current={current ? "page" : undefined}
        disabled={disabled}
        className={cn(
          /*
            A rounded rect, not a pill — deliberately, and against the first
            instinct when matching the landing page.

            That page's controls are pills, and the shared primitives here
            (Button, IconButton, Badge, SegmentedControl) follow it. But
            every pill on /welcome is width-fitted to its own label: its nav
            links are `rounded-full h-8 px-3` around a word. It has no
            full-width row anywhere, so there is nothing to copy for one —
            and a 36px-tall row spanning the whole rail, fully rounded,
            reads as a lozenge rather than as the same object. macOS agrees:
            sidebar selection is a rounded rect.

            So the rule the census actually supports is "width-fitted
            controls are pills, full-width rows and containers are rounded
            rects", which is what both sources do.
          */
          "group relative flex w-full items-center gap-2.5 rounded-lg border border-transparent",
          "text-left outline-none select-none",
          // Colour and background only — no transform. These rows are hit
          // constantly, and `motion.md` asks to "generally avoid adding
          // motion to UI interactions that occur frequently".
          "transition-[background-color,color,border-color] duration-(--duration-fast) ease-(--ease-standard)",
          "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
          "disabled:pointer-events-none disabled:opacity-45",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          touch ? "h-11 px-2.5" : "h-9 px-2",
          collapsed && "justify-center px-0",
          current
            ? "bg-surface-selected text-foreground"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground",
          className
        )}
        {...props}
      >
        {/* The second, non-colour carrier of "you are here". Inset so it
            reads as a marker on the rail rather than a border on the row. */}
        {current && (
          <span
            aria-hidden
            className={cn(
              "absolute inset-y-1.5 left-0 w-0.5 rounded-full bg-primary",
              collapsed && "inset-y-2"
            )}
          />
        )}
        {icon}
        {!collapsed && <span className="min-w-0 flex-1 truncate text-body-sm">{label}</span>}
        {!collapsed && trailing != null && (
          // Measured, not picked: the tertiary tier sits on the base ground
          // at a comfortable ratio but only reaches 4.36:1 on the tinted
          // `surface-selected` an active row uses — under WCAG AA's 4.5:1
          // for 12px text (`accessibility.md` › contrast). The active row
          // steps the count up a tier rather than dimming the surface,
          // because the surface is what marks the row as current.
          <span
            className={cn(
              "shrink-0 text-meta tabular-nums",
              current ? "text-muted-foreground" : "text-tertiary"
            )}
          >
            {trailing}
          </span>
        )}
      </button>
    )

    // A tooltip is what carries the name in the collapsed rail, so it is
    // required there; elsewhere it only appears when there is something to
    // add beyond the visible label.
    if (!collapsed && !tooltip) return row

    return (
      <Tooltip>
        <TooltipTrigger render={row} />
        <TooltipContent>{tooltip ?? label}</TooltipContent>
      </Tooltip>
    )
  }
)
SidebarItem.displayName = "SidebarItem"

/**
 * A group heading in the rail.
 *
 * Uppercase mono micro-label, which is the landing page's `.m-label` — the
 * one place that page allows mono, and the one place it belongs here too.
 * Renders nothing when the rail is collapsed rather than shrinking to an
 * unreadable stub.
 */
export function SidebarSectionLabel({
  children,
  collapsed,
  className,
}: {
  children: React.ReactNode
  collapsed?: boolean
  className?: string
}) {
  if (collapsed) return null
  return (
    <p className={cn("px-2 pb-1.5 pt-0.5 text-eyebrow text-tertiary", className)}>{children}</p>
  )
}
