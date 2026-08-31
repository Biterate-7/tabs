"use client"

import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading, SliderRow } from "./section-ui"

export function GeneralSection() {
  const { settings, setPlayIntro, setSound } = useAppearanceContext()
  if (!settings) return null

  return (
    <div>
      <SectionHeading title="General" />
      <div className="flex flex-col gap-2.5">
        <FieldRow label="Play intro animation" description="Show the TabDump cinematic intro when opening the app.">
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
      </div>
    </div>
  )
}
