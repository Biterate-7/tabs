"use client"

import { RotateCcw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Select } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { useAppearanceContext } from "@/components/appearance-provider"
import { DEFAULT_TYPOGRAPHY } from "@/lib/appearance/defaults"
import { fontsByKind } from "@/lib/appearance/fonts"
import { SectionHeading, SliderRow, FieldRow, GroupLabel, SectionStack } from "./section-ui"

const UI_FONT_OPTIONS = fontsByKind("sans").concat(fontsByKind("serif")).map((f) => ({ value: f.id, label: f.label }))
const MONO_FONT_OPTIONS = fontsByKind("mono").map((f) => ({ value: f.id, label: f.label }))
const CONTENT_FONT_OPTIONS = fontsByKind("sans").concat(fontsByKind("serif")).map((f) => ({ value: f.id, label: f.label }))

export function TypographySection() {
  const { settings, setTypography } = useAppearanceContext()
  if (!settings) return null
  const t = settings.typography

  return (
    <div>
      <SectionHeading title="Typography" description="Control the fonts and text rhythm used across Hubble." />

      <GroupLabel>Faces</GroupLabel>
      <SectionStack className="mb-6">
        <FieldRow label="Interface" description="Menus, lists, messages — the product face.">
          <Select className="w-48" value={t.uiFont} onValueChange={(v) => setTypography({ uiFont: v })} options={UI_FONT_OPTIONS} />
        </FieldRow>
        <FieldRow label="Content and notes" description="Long-form writing in notes.">
          <Select className="w-48" value={t.contentFont} onValueChange={(v) => setTypography({ contentFont: v })} options={CONTENT_FONT_OPTIONS} />
        </FieldRow>
        <FieldRow label="Monospace" description="Code, paths and commands.">
          <Select className="w-48" value={t.monoFont} onValueChange={(v) => setTypography({ monoFont: v })} options={MONO_FONT_OPTIONS} />
        </FieldRow>
      </SectionStack>

      <GroupLabel>Rhythm</GroupLabel>
      <SectionStack className="mb-3">
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
      </SectionStack>
      <div className="mb-6 flex justify-end">
        <Button type="button" variant="ghost" size="sm" onClick={() => setTypography(DEFAULT_TYPOGRAPHY)}>
          <RotateCcw /> Reset typography
        </Button>
      </div>

      <GroupLabel>Preview</GroupLabel>
      <div className="rounded-md border border-border bg-card p-4">
        <p className="text-h1 text-foreground">Hubble</p>
        <p className="mt-1 text-body text-foreground">Organize your tabs.</p>
        <p className="mt-1 text-meta text-tertiary">https://example.com</p>
        <p className="mt-3 text-code text-muted-foreground">~/code/hubble/src/app</p>
      </div>
    </div>
  )
}
