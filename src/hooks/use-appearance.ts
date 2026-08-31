"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  getSettings,
  resetAllAppearance,
  resetAppearanceSection,
  setAccentOverride,
  setBackground,
  setCustomTheme,
  setLayout,
  setMotion,
  setPlayIntro,
  setRandomThemeEnabled,
  setShape,
  setSound,
  setThemeId,
  setTypography,
  toggleFavoriteTheme,
  type Settings,
  type SoundSettings,
} from "@/lib/settings"
import { appearanceToCssVars, resolveThemeColors } from "@/lib/appearance/resolve"
import { THEME_REGISTRY } from "@/lib/appearance/themes"
import type {
  AppearanceSection,
  BackgroundSettings,
  LayoutSettings,
  MotionSettings,
  ShapeSettings,
  ThemeColors,
  TypographySettings,
} from "@/lib/appearance/types"

/**
 * Owns the single source of truth for appearance settings client-side and
 * applies them to the document as CSS custom properties — imperatively, in
 * an effect, once per settings change. No component ever receives theme
 * colors as props: they consume the same Tailwind classes they always have
 * (bg-background, text-foreground, …) which now read from vars this hook
 * writes onto `document.documentElement`. That's what keeps every switch
 * (theme, font, radius, …) an instant single-effect update instead of a
 * tree-wide re-render — see resolve.ts's `appearanceToCssVars`.
 *
 * Mirrors AppShell's own "hydrate from localStorage on mount, keep local
 * React state as the live copy, persist through the same setter every time
 * it changes" pattern (see app-shell.tsx / settings.ts).
 */
export function useAppearance() {
  const [settings, setSettings] = useState<Settings | null>(null)
  const [prefersReducedMotion, setPrefersReducedMotion] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(getSettings())
    const media = window.matchMedia("(prefers-reduced-motion: reduce)")
    setPrefersReducedMotion(media.matches)
    const onChange = () => setPrefersReducedMotion(media.matches)
    media.addEventListener("change", onChange)
    return () => media.removeEventListener("change", onChange)
  }, [])

  const resolvedColors = useMemo<ThemeColors | null>(
    () => (settings ? resolveThemeColors(settings) : null),
    [settings]
  )

  useEffect(() => {
    if (!settings || !resolvedColors) return
    const vars = appearanceToCssVars(settings, resolvedColors)
    const root = document.documentElement.style
    for (const [key, value] of Object.entries(vars)) root.setProperty(key, value)
    document.documentElement.dataset.motion = settings.motion.level
    document.documentElement.dataset.theme = settings.themeId
  }, [settings, resolvedColors])

  // Random theme: reshuffles once per fresh load when enabled, never mid-
  // session — see Phase 8 of the appearance spec ("don't randomly change
  // themes unexpectedly while the user is actively working").
  useEffect(() => {
    if (!settings?.randomThemeEnabled) return
    const pool = THEME_REGISTRY.filter((t) => t.id !== settings.themeId)
    if (pool.length === 0) return
    const pick = pool[Math.floor(Math.random() * pool.length)]
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(setThemeId(pick.id))
    // Intentionally only on mount (settings becoming non-null the first
    // time) — see the [] below via the `settings === null` gate pattern.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settings !== null])

  const wrap = useCallback(<A extends unknown[]>(fn: (...args: A) => Settings) => {
    return (...args: A) => setSettings(fn(...args))
  }, [])

  return {
    settings,
    resolvedColors,
    hydrated: settings !== null,
    prefersReducedMotion,
    setPlayIntro: useCallback((enabled: boolean) => {
      setPlayIntro(enabled)
      setSettings((prev) => (prev ? { ...prev, playIntro: enabled } : prev))
    }, []),
    setSound: wrap((patch: Partial<SoundSettings>) => setSound(patch)),
    setThemeId: wrap(setThemeId),
    setCustomTheme: wrap((colors: ThemeColors | null) => setCustomTheme(colors)),
    toggleFavoriteTheme: wrap(toggleFavoriteTheme),
    setRandomThemeEnabled: wrap(setRandomThemeEnabled),
    setTypography: wrap((patch: Partial<TypographySettings>) => setTypography(patch)),
    setBackground: wrap((patch: Partial<BackgroundSettings>) => setBackground(patch)),
    setLayout: wrap((patch: Partial<LayoutSettings>) => setLayout(patch)),
    setShape: wrap((patch: Partial<ShapeSettings>) => setShape(patch)),
    setMotion: wrap((patch: Partial<MotionSettings>) => setMotion(patch)),
    setAccentOverride: wrap(setAccentOverride),
    resetAppearanceSection: wrap((section: AppearanceSection) => resetAppearanceSection(section)),
    resetAllAppearance: wrap(() => resetAllAppearance()),
    randomizeTheme: useCallback(() => {
      setSettings((prev) => {
        if (!prev) return prev
        const pool = THEME_REGISTRY.filter((t) => t.id !== prev.themeId)
        const pick = pool[Math.floor(Math.random() * pool.length)] ?? THEME_REGISTRY[0]
        return setThemeId(pick.id)
      })
    }, []),
  }
}

export type UseAppearanceReturn = ReturnType<typeof useAppearance>
