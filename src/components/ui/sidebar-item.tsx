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
            HubbleSidebarItem. Measured off the reference's navigation rail:
            a 30px row, 8px inset, a 4px corner, 13px label, 16px glyph at
            the secondary tier. The current row is marked by tone — the 6%
            selected fill with full ink — exactly as the reference marks it;
            there is no side bar and no colour. aria-current carries the
            same fact for assistive technology, so the state is never
            conveyed by colour alone.
          */
          "group relative flex w-full items-center gap-2 rounded-xs border border-transparent",
          "text-left outline-none select-none",
          // Colour and background only — rows are hit constantly, so nothing moves.
          "transition-[background-color,color] duration-(--duration-fast) ease-(--ease-color)",
          "focus-visible:ring-2 focus-visible:ring-ring/60",
          "disabled:pointer-events-none disabled:opacity-45",
          "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
          touch ? "h-11 px-2.5" : "h-[30px] px-2",
          collapsed && "justify-center px-0",
          current
            ? "bg-surface-selected text-foreground [&_svg]:text-foreground"
            : "text-muted-foreground hover:bg-surface-hover hover:text-foreground [&_svg]:text-muted-foreground hover:[&_svg]:text-foreground",
          className
        )}
        {...props}
      >
        {icon}
        {!collapsed && <span className="min-w-0 flex-1 truncate text-body">{label}</span>}
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
 * A group heading in the rail: "This week", "Agents", "Workspaces" — 11px
 * in sentence case at the tertiary tier, as the reference's rail labels
 * are. Renders nothing when the rail is collapsed rather than shrinking to
 * an unreadable stub.
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
    <p className={cn("px-2 pb-1 pt-0.5 text-meta text-tertiary", className)}>{children}</p>
  )
}
