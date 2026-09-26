"use client"

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading, SliderRow, SectionStack } from "./section-ui"

export function GeneralSection() {
  const { settings, setPlayIntro, setSound, setThemeId } = useAppearanceContext()
  if (!settings) return null

  return (
    <div>
      <SectionHeading title="General" />
      <SectionStack>
        <FieldRow
          label="Theme"
          description={
            settings.themeId === "midnight" || settings.themeId === "hubble-light"
              ? "The Hubble palette, in ink or paper."
              : "A library theme is active. Pick one here to return to the Hubble palette."
          }
        >
          <SegmentedControl
            value={settings.customTheme ? "" : settings.themeId === "hubble-light" ? "light" : settings.themeId === "midnight" ? "dark" : ""}
            onValueChange={(v) => setThemeId(v === "light" ? "hubble-light" : "midnight")}
            options={[
              { value: "dark", label: "Dark" },
              { value: "light", label: "Light" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Play intro animation" description="Show the Hubble cinematic intro when opening the app.">
          <Switch checked={settings.playIntro} onCheckedChange={setPlayIntro} aria-label="Play intro animation" />
        </FieldRow>
        <FieldRow label="Interface sounds" description="Short, subtle sound effects for interactions like opening a folder.">
          <Switch
            checked={settings.sound.enabled}
            onCheckedChange={(enabled) => setSound({ enabled })}
            aria-label="Interface sounds"
          />
        </FieldRow>
        {settings.sound.enabled && (
          <SliderRow label="Sound volume" valueLabel={`${settings.sound.volume}%`}>
            <Slider
              min={0}
              max={100}
              step={5}
              value={settings.sound.volume}
              onValueChange={(volume) => setSound({ volume })}
            />
          </SliderRow>
        )}
      </SectionStack>

    </div>
  )
}
