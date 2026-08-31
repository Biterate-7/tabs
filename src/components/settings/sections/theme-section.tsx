"use client"

import { useMemo, useState } from "react"
import { Shuffle } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAppearanceContext } from "@/components/appearance-provider"
import { resolveThemeColors } from "@/lib/appearance/resolve"
import { THEME_CATEGORY_LABELS, THEME_REGISTRY, deriveSubtleFields } from "@/lib/appearance/themes"
import type { ThemeCategory } from "@/lib/appearance/types"
import { FieldRow, SectionHeading } from "./section-ui"
import { ThemeCard } from "./theme-card"
import { CustomThemeEditor } from "./custom-theme-editor"

const CATEGORY_ORDER: ThemeCategory[] = ["dark", "light", "colorful", "aesthetic", "developer"]

export function ThemeSection() {
  const appearance = useAppearanceContext()
  const { settings } = appearance
  const [mode, setMode] = useState<"preset" | "custom">(settings?.customTheme ? "custom" : "preset")
  const [favoritesOnly, setFavoritesOnly] = useState(false)

  const visibleThemes = useMemo(() => {
    if (!settings) return []
    return favoritesOnly ? THEME_REGISTRY.filter((t) => settings.favoriteThemeIds.includes(t.id)) : THEME_REGISTRY
  }, [settings, favoritesOnly])

  if (!settings) return null

  const customColors = settings.customTheme ?? resolveThemeColors(settings)

  function selectPreset(id: string) {
    appearance.setThemeId(id)
  }

  function startCustomFromCurrent() {
    if (settings && !settings.customTheme) {
      appearance.setCustomTheme(deriveSubtleFields(resolveThemeColors(settings)))
    }
    setMode("custom")
  }

  return (
    <div>
      <SectionHeading
        title="Theme"
        description="Pick a preset, favorite the ones you reach for, or build a fully custom palette."
      />

      <div className="mb-4 flex flex-wrap items-center justify-between gap-3">
        <SegmentedControl
          value={mode}
          onValueChange={(v) => (v === "custom" ? startCustomFromCurrent() : setMode(v))}
          options={[
            { value: "preset", label: "Preset" },
            { value: "custom", label: "Custom" },
          ]}
        />
        {mode === "preset" && (
          <div className="flex items-center gap-2">
            <Button type="button" variant="outline" size="sm" onClick={appearance.randomizeTheme}>
              <Shuffle /> Shuffle
            </Button>
            <SegmentedControl
              value={favoritesOnly ? "favorites" : "all"}
              onValueChange={(v) => setFavoritesOnly(v === "favorites")}
              size="sm"
              options={[
                { value: "all", label: "All" },
                { value: "favorites", label: "Favorites" },
              ]}
            />
          </div>
        )}
      </div>

      {mode === "preset" ? (
        <div className="flex flex-col gap-6">
          <FieldRow label="Random theme" description="Pick a new theme automatically each time TabDump loads.">
            <Switch
              checked={settings.randomThemeEnabled}
              onCheckedChange={appearance.setRandomThemeEnabled}
              aria-label="Random theme"
            />
          </FieldRow>

          {favoritesOnly && visibleThemes.length === 0 ? (
            <p className="rounded-lg border border-dashed border-subtle p-6 text-center text-body-sm text-muted-foreground">
              No favorites yet — star a theme below to add it here.
            </p>
          ) : (
            CATEGORY_ORDER.map((category) => {
              const themes = visibleThemes.filter((t) => t.category === category)
              if (themes.length === 0) return null
              return (
                <div key={category}>
                  <p className="mb-2 px-0.5 text-label text-tertiary">{THEME_CATEGORY_LABELS[category].toUpperCase()}</p>
                  <div className="grid grid-cols-2 gap-3 sm:grid-cols-3">
                    {themes.map((theme) => (
                      <ThemeCard
                        key={theme.id}
                        theme={theme}
                        selected={!settings.customTheme && settings.themeId === theme.id}
                        favorited={settings.favoriteThemeIds.includes(theme.id)}
                        onSelect={() => selectPreset(theme.id)}
                        onToggleFavorite={() => appearance.toggleFavoriteTheme(theme.id)}
                      />
                    ))}
                  </div>
                </div>
              )
            })
          )}
        </div>
      ) : (
        <CustomThemeEditor
          colors={customColors}
          onChange={(colors) => appearance.setCustomTheme(colors)}
        />
      )}
    </div>
  )
}
