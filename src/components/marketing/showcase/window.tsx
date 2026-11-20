"use client"

import type { CSSProperties, ReactNode } from "react"
import { Lock, RotateCw } from "lucide-react"
import { cn } from "@/lib/utils"

/**
 * A Hubble window on the page: traffic lights, a centred title, and the
 * product inside. A `<figure>` named for what it shows, so a screen reader
 * hears one sentence instead of every label in a mock interface; the
 * controls inside that do something (they drive the demo) stay reachable.
 */
export function DemoWindow({
  label,
  title,
  className,
  style,
  children,
  bar,
  inert = false,
}: {
  label: string
  title: ReactNode
  className?: string
  style?: CSSProperties
  children: ReactNode
  /** Replaces the centred title (a browser window's address bar). */
  bar?: ReactNode
  /** Not the window in front: take it out of the tab order. */
  inert?: boolean
}) {
  return (
    <figure aria-label={label} data-hubble-illustration="" className={cn("m-app m-window", className)} style={style} inert={inert}>
      <figcaption className="m-window-bar">
        <span aria-hidden className="m-window-dots">
          <span />
          <span />
          <span />
        </span>
        {bar ?? <span className="min-w-0 flex-1 truncate pr-[42px] text-center">{title}</span>}
      </figcaption>
      <div className="relative flex min-h-0 flex-1 flex-col">{children}</div>
    </figure>
  )
}

/** A browser window's address bar, for windows that are a web page (an AI app, a source). */
export function AddressBar({ host, path = "" }: { host: string; path?: string }) {
  return (
    <span className="mx-auto flex h-[22px] w-full max-w-[340px] min-w-0 items-center gap-2 rounded-[5px] border border-subtle bg-[var(--m-ground-2)] px-2.5 text-[11.5px] text-tertiary">
      <Lock aria-hidden className="size-3 shrink-0" />
      <span className="min-w-0 flex-1 truncate text-center">
        <span className="text-muted-foreground">{host}</span>
        {path}
      </span>
      <RotateCw aria-hidden className="size-3 shrink-0" />
    </span>
  )
}

/** A keyboard shortcut, as the app's own search field shows it. */
export function Kbd({ children }: { children: ReactNode }) {
  return <kbd className="rounded-[3px] border border-subtle bg-[var(--m-ground-3)] px-1 font-sans text-[10.5px] leading-[15px] text-tertiary">{children}</kbd>
}
