"use client"

import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading } from "./section-ui"

const RADIUS_PREVIEW: Record<string, string> = {
  sharp: "0px",
  small: "5px",
  medium: "10px",
  rounded: "16px",
  "very-rounded": "24px",
}

export function ShapeSection() {
  const { settings, setShape } = useAppearanceContext()
  if (!settings) return null
  const s = settings.shape

  return (
    <div>
      <SectionHeading title="Shape" description="Corner rounding, border, and shadow strength — applied consistently to every card, button, input, and panel." />

      <div className="flex flex-col gap-2.5">
        <FieldRow label="Corner radius" stacked>
          <div className="flex flex-wrap gap-2">
            {(["sharp", "small", "medium", "rounded", "very-rounded"] as const).map((option) => (
              <button
                key={option}
                type="button"
                onClick={() => setShape({ radius: option })}
                aria-pressed={s.radius === option}
                className="flex flex-col items-center gap-1.5 rounded-lg border border-subtle p-2 text-meta text-muted-foreground outline-none transition-colors data-[selected=true]:border-primary data-[selected=true]:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50"
                data-selected={s.radius === option}
              >
                <span
                  className="size-8 border-2 border-current"
                  style={{ borderRadius: RADIUS_PREVIEW[option] }}
                  aria-hidden
                />
                {option.replace("-", " ")}
              </button>
            ))}
          </div>
        </FieldRow>

        <FieldRow label="Border intensity">
          <SegmentedControl
            value={s.borderIntensity}
            onValueChange={(v) => setShape({ borderIntensity: v })}
            options={[
              { value: "none", label: "None" },
              { value: "subtle", label: "Subtle" },
              { value: "normal", label: "Normal" },
              { value: "strong", label: "Strong" },
            ]}
          />
        </FieldRow>

        <FieldRow label="Shadow">
          <SegmentedControl
            value={s.shadowIntensity}
            onValueChange={(v) => setShape({ shadowIntensity: v })}
            options={[
              { value: "none", label: "None" },
              { value: "subtle", label: "Subtle" },
              { value: "normal", label: "Normal" },
              { value: "strong", label: "Strong" },
            ]}
          />
        </FieldRow>
      </div>
    </div>
  )
}
