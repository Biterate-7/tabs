"use client"

import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { useAppearanceContext } from "@/components/appearance-provider"
import { DEFAULT_TYPOGRAPHY } from "@/lib/appearance/defaults"
import { fontsByKind } from "@/lib/appearance/fonts"
import { SectionHeading, SliderRow } from "./section-ui"

const UI_FONT_OPTIONS = fontsByKind("sans").concat(fontsByKind("serif")).map((f) => ({ value: f.id, label: f.label }))
const MONO_FONT_OPTIONS = fontsByKind("mono").map((f) => ({ value: f.id, label: f.label }))
const CONTENT_FONT_OPTIONS = fontsByKind("sans").concat(fontsByKind("serif")).map((f) => ({ value: f.id, label: f.label }))

export function TypographySection() {
  const { settings, setTypography } = useAppearanceContext()
  if (!settings) return null
  const t = settings.typography

  return (
    <div>
      <SectionHeading title="Typography" description="Control the fonts and text rhythm used across TabDump." />

      <div className="flex flex-col gap-2.5">
        <div className="grid gap-2.5 sm:grid-cols-3">
          <div>
            <p className="mb-1.5 px-0.5 text-label text-tertiary">UI FONT</p>
            <Select value={t.uiFont} onValueChange={(v) => setTypography({ uiFont: v })} options={UI_FONT_OPTIONS} />
          </div>
          <div>
            <p className="mb-1.5 px-0.5 text-label text-tertiary">CONTENT / NOTES FONT</p>
            <Select value={t.contentFont} onValueChange={(v) => setTypography({ contentFont: v })} options={CONTENT_FONT_OPTIONS} />
          </div>
          <div>
            <p className="mb-1.5 px-0.5 text-label text-tertiary">MONOSPACE FONT</p>
            <Select value={t.monoFont} onValueChange={(v) => setTypography({ monoFont: v })} options={MONO_FONT_OPTIONS} />
          </div>
        </div>

        <SliderRow label="Font size" valueLabel={`${t.fontSize} px`}>
          <Slider min={12} max={22} step={1} value={t.fontSize} onValueChange={(v) => setTypography({ fontSize: v })} />
        </SliderRow>
        <SliderRow label="Font weight" valueLabel={String(t.fontWeight)}>
          <Slider min={300} max={700} step={100} value={t.fontWeight} onValueChange={(v) => setTypography({ fontWeight: v })} />
        </SliderRow>
        <SliderRow label="Line height" valueLabel={t.lineHeight.toFixed(2)}>
          <Slider min={1.1} max={2} step={0.05} value={t.lineHeight} onValueChange={(v) => setTypography({ lineHeight: v })} />
        </SliderRow>
        <SliderRow label="Letter spacing" valueLabel={`${t.letterSpacing.toFixed(1)} px`}>
          <Slider min={-1} max={4} step={0.1} value={t.letterSpacing} onValueChange={(v) => setTypography({ letterSpacing: v })} />
        </SliderRow>

        <div className="mt-1 flex justify-end">
          <Button type="button" variant="outline" size="sm" onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}>
            <RotateCcw /> Reset typography
          </Button>
        </div>

        <div>
          <p className="mb-1.5 px-0.5 text-label text-tertiary">PREVIEW</p>
          <div className="rounded-lg border border-subtle bg-card p-4">
            <p className="text-h1 text-foreground">TabDump</p>
            <p className="mt-1 text-body text-foreground">Organize your tabs.</p>
            <p className="mt-1 text-meta text-tertiary">https://example.com</p>
            <p className="mt-3 text-h2 text-foreground"># Project Notes</p>
          </div>
        </div>
      </div>
    </div>
  )
}
