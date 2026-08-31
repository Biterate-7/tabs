"use client"

import { Switch } from "@/components/ui/switch"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading } from "./section-ui"

export function GeneralSection() {
  const { settings, setPlayIntro } = useAppearanceContext()
  if (!settings) return null

  return (
    <div>
      <SectionHeading title="General" />
      <FieldRow label="Play intro animation" description="Show the TabDump cinematic intro when opening the app.">
        <Switch checked={settings.playIntro} onCheckedChange={setPlayIntro} aria-label="Play intro animation" />
      </FieldRow>
    </div>
  )
}
