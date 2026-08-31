"use client"

import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading } from "./section-ui"

export function MotionSection() {
  const { settings, setMotion, prefersReducedMotion } = useAppearanceContext()
  if (!settings) return null
  const m = settings.motion

  return (
    <div>
      <SectionHeading title="Motion" description="How much animation TabDump uses for transitions, imports, and view changes." />

      {prefersReducedMotion && (
        <p className="mb-3 rounded-lg border border-subtle bg-warning-subtle px-3 py-2 text-body-sm text-warning">
          Your system has reduced motion enabled — TabDump keeps animation minimal regardless of the setting below.
        </p>
      )}

      <div className="flex flex-col gap-2.5">
        <FieldRow label="Animations" stacked>
          <SegmentedControl
            value={m.level}
            onValueChange={(v) => setMotion({ level: v })}
            options={[
              { value: "off", label: "Off" },
              { value: "reduced", label: "Reduced" },
              { value: "normal", label: "Normal" },
              { value: "expressive", label: "Expressive" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Transition speed">
          <SegmentedControl
            value={m.transitionSpeed}
            onValueChange={(v) => setMotion({ transitionSpeed: v })}
            options={[
              { value: "fast", label: "Fast" },
              { value: "normal", label: "Normal" },
              { value: "slow", label: "Slow" },
            ]}
          />
        </FieldRow>
      </div>
    </div>
  )
}
