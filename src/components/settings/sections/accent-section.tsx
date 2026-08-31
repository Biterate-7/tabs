"use client"

import { Input } from "@/components/ui/input"
import { Button } from "@/components/ui/button"
import { useAppearanceContext } from "@/components/appearance-provider"
import { isValidColor, normalizeHex } from "@/lib/appearance/contrast"
import { FieldRow, SectionHeading } from "./section-ui"

export function AccentSection() {
  const { settings, resolvedColors, setAccentOverride } = useAppearanceContext()
  if (!settings || !resolvedColors) return null

  const active = settings.accentOverride
  const swatchValue = active && isValidColor(active) ? `#${normalizeHex(active)}` : `#${normalizeHex(resolvedColors.accent)}`

  return (
    <div>
      <SectionHeading
        title="Accent"
        description="An accent color independent from the theme — drives buttons, links, selected navigation, focus rings, toggles, and graph selection."
      />

      <div className="flex flex-col gap-2.5">
        <FieldRow label="Use theme's accent" description="Turn off to pick your own color below.">
          <Button type="button" variant={active ? "outline" : "default"} size="sm" onClick={() => setAccentOverride(null)} disabled={!active}>
            {active ? "Use theme default" : "Using theme default"}
          </Button>
        </FieldRow>

        <FieldRow label="Custom accent color">
          <div className="flex items-center gap-2">
            <input
              type="color"
              aria-label="Accent color"
              value={swatchValue}
              onChange={(e) => setAccentOverride(e.target.value)}
              className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
            />
            <Input
              value={active ?? ""}
              placeholder={resolvedColors.accent}
              onChange={(e) => {
                const v = e.target.value
                if (isValidColor(v)) setAccentOverride(v.startsWith("#") ? v : `#${v}`)
              }}
              className="w-28"
            />
          </div>
        </FieldRow>
      </div>
    </div>
  )
}
