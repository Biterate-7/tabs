"use client"

import { createContext, useContext } from "react"

/**
 * Where portalled overlays (dialogs, menus, popovers, tooltips) mount.
 *
 * `null` — the default everywhere in the app — means base-ui's own default,
 * `document.body`. A surface that re-scopes the design tokens on a subtree
 * (the landing page redefines them on `.tabdump-marketing`) provides an
 * element inside that subtree, so an overlay opened from it resolves the same
 * palette as the thing that opened it instead of the app theme on `:root`.
 */
export const PortalContainerContext = createContext<HTMLElement | null>(null)

export function usePortalContainer(): HTMLElement | undefined {
  return useContext(PortalContainerContext) ?? undefined
}
