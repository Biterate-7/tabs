"use client"

import Link from "next/link"
import { Switch } from "@/components/ui/switch"
import { Slider } from "@/components/ui/slider"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading, SliderRow } from "./section-ui"

const LEGAL_LINKS = [
  { href: "/privacy", label: "Privacy Policy" },
  { href: "/terms", label: "Terms & Conditions" },
  { href: "/cookies", label: "Cookie Policy" },
] as const

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

      <div className="mt-8">
        <SectionHeading title="Legal" description="How TabDump handles your data, and the terms that apply to using it." />
        <nav aria-label="Legal pages" className="flex flex-col gap-1 rounded-lg border border-subtle p-1">
          {LEGAL_LINKS.map((link) => (
            <Link
              key={link.href}
              href={link.href}
              className="rounded-md px-2.5 py-2 text-body-sm text-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {link.label}
            </Link>
          ))}
        </nav>
      </div>
    </div>
  )
}
