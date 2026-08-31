"use client"

import { createContext, useContext, type ReactNode } from "react"
import { useAppearance, type UseAppearanceReturn } from "@/hooks/use-appearance"

const AppearanceContext = createContext<UseAppearanceReturn | null>(null)

/**
 * Mounted once near the root (see src/app/layout.tsx). Renders the fixed
 * background layer (Settings → Appearance → Background) behind `children`
 * and makes the live appearance settings + setters available to anything
 * that needs them — today just the Appearance settings surface itself; the
 * rest of the app never touches this context, it just reads the CSS vars
 * this provider's underlying hook (useAppearance) writes onto <html>.
 */
export function AppearanceProvider({ children }: { children: ReactNode }) {
  const appearance = useAppearance()

  return (
    <AppearanceContext.Provider value={appearance}>
      <div className="appearance-background-layer" aria-hidden />
      <div className="appearance-background-overlay" aria-hidden />
      <div className="relative z-[1] min-h-full">{children}</div>
    </AppearanceContext.Provider>
  )
}

export function useAppearanceContext(): UseAppearanceReturn {
  const ctx = useContext(AppearanceContext)
  if (!ctx) throw new Error("useAppearanceContext must be used within AppearanceProvider")
  return ctx
}

/**
 * Same context, without the throw — for components that read appearance
 * state (theme/motion/sound) as a progressive enhancement rather than a hard
 * requirement, and should render sensible defaults when mounted outside
 * AppearanceProvider (e.g. in unit tests that don't need real theming).
 */
export function useOptionalAppearanceContext(): UseAppearanceReturn | null {
  return useContext(AppearanceContext)
}
