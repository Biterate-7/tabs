"use client"

import { Input } from "@/components/ui/input"
import { Select } from "@/components/ui/select"
import { Slider } from "@/components/ui/slider"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAppearanceContext } from "@/components/appearance-provider"
import { isValidColor, normalizeHex } from "@/lib/appearance/contrast"
import { FieldRow, SectionHeading, SliderRow } from "./section-ui"

const SIZE_OPTIONS = [
  { value: "cover", label: "Cover" },
  { value: "contain", label: "Contain" },
  { value: "tile", label: "Tile" },
] as const

const POSITION_OPTIONS = [
  { value: "center", label: "Center" },
  { value: "top", label: "Top" },
  { value: "bottom", label: "Bottom" },
  { value: "left", label: "Left" },
  { value: "right", label: "Right" },
] as const

function colorPickerValue(hex: string, fallback: string): string {
  const v = hex && isValidColor(hex) ? hex : fallback
  return `#${normalizeHex(v)}`
}

export function BackgroundSection() {
  const { settings, resolvedColors, setBackground } = useAppearanceContext()
  if (!settings || !resolvedColors) return null
  const bg = settings.background

  return (
    <div>
      <SectionHeading title="Background" description="Give TabDump a solid color, a gradient, or an image behind the UI." />

      <div className="flex flex-col gap-2.5">
        <FieldRow label="Type" stacked>
          <SegmentedControl
            value={bg.type}
            onValueChange={(v) => setBackground({ type: v })}
            options={[
              { value: "solid", label: "Solid" },
              { value: "gradient", label: "Gradient" },
              { value: "image", label: "Image" },
            ]}
          />
        </FieldRow>

        {bg.type === "solid" && (
          <FieldRow label="Background color" description="Leave unset to use the theme's own background.">
            <div className="flex items-center gap-2">
              <input
                type="color"
                aria-label="Background color"
                value={colorPickerValue(bg.color, resolvedColors.background)}
                onChange={(e) => setBackground({ color: e.target.value })}
                className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
              />
              <Input
                value={bg.color}
                placeholder={resolvedColors.background}
                onChange={(e) => setBackground({ color: e.target.value })}
                className="w-28"
              />
            </div>
          </FieldRow>
        )}

        {bg.type === "gradient" && (
          <>
            <FieldRow label="From">
              <input
                type="color"
                aria-label="Gradient start color"
                value={colorPickerValue(bg.gradientFrom, resolvedColors.background)}
                onChange={(e) => setBackground({ gradientFrom: e.target.value })}
                className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
              />
            </FieldRow>
            <FieldRow label="To">
              <input
                type="color"
                aria-label="Gradient end color"
                value={colorPickerValue(bg.gradientTo, resolvedColors.accent)}
                onChange={(e) => setBackground({ gradientTo: e.target.value })}
                className="size-7 cursor-pointer rounded border border-border bg-transparent p-0"
              />
            </FieldRow>
            <SliderRow label="Angle" valueLabel={`${bg.gradientAngle}°`}>
              <Slider min={0} max={360} step={5} value={bg.gradientAngle} onValueChange={(v) => setBackground({ gradientAngle: v })} />
            </SliderRow>
          </>
        )}

        {bg.type === "image" && (
          <>
            <FieldRow label="Image URL" stacked>
              <Input
                value={bg.imageUrl}
                onChange={(e) => setBackground({ imageUrl: e.target.value })}
                placeholder="https://…"
              />
            </FieldRow>
            <div className="grid gap-2.5 sm:grid-cols-2">
              <div>
                <p className="mb-1.5 px-0.5 text-label text-tertiary">SIZE</p>
                <Select value={bg.size} onValueChange={(v) => setBackground({ size: v as typeof bg.size })} options={[...SIZE_OPTIONS]} />
              </div>
              <div>
                <p className="mb-1.5 px-0.5 text-label text-tertiary">POSITION</p>
                <Select
                  value={bg.position}
                  onValueChange={(v) => setBackground({ position: v as typeof bg.position })}
                  options={[...POSITION_OPTIONS]}
                />
              </div>
            </div>
            <SliderRow label="Blur" valueLabel={`${bg.blur} px`}>
              <Slider min={0} max={40} step={1} value={bg.blur} onValueChange={(v) => setBackground({ blur: v })} />
            </SliderRow>
            <SliderRow label="Brightness" valueLabel={`${bg.brightness}%`}>
              <Slider min={40} max={160} step={5} value={bg.brightness} onValueChange={(v) => setBackground({ brightness: v })} />
            </SliderRow>
            <SliderRow label="Contrast" valueLabel={`${bg.contrast}%`}>
              <Slider min={40} max={160} step={5} value={bg.contrast} onValueChange={(v) => setBackground({ contrast: v })} />
            </SliderRow>
            <SliderRow label="Saturation" valueLabel={`${bg.saturation}%`}>
              <Slider min={0} max={200} step={5} value={bg.saturation} onValueChange={(v) => setBackground({ saturation: v })} />
            </SliderRow>
            <SliderRow label="Readability overlay" valueLabel={`${bg.overlayOpacity}%`}>
              <p className="mb-2 text-meta text-tertiary">Darkens/lightens the image behind text so content stays legible.</p>
              <Slider min={0} max={100} step={5} value={bg.overlayOpacity} onValueChange={(v) => setBackground({ overlayOpacity: v })} />
            </SliderRow>
          </>
        )}

        {bg.type !== "solid" && (
          <SliderRow label="Opacity" valueLabel={`${bg.opacity}%`}>
            <Slider min={0} max={100} step={5} value={bg.opacity} onValueChange={(v) => setBackground({ opacity: v })} />
          </SliderRow>
        )}
      </div>
    </div>
  )
}
