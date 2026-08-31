"use client"

import { SegmentedControl } from "@/components/ui/segmented-control"
import { useAppearanceContext } from "@/components/appearance-provider"
import { FieldRow, SectionHeading } from "./section-ui"

export function LayoutSection() {
  const { settings, setLayout } = useAppearanceContext()
  if (!settings) return null
  const l = settings.layout

  return (
    <div>
      <SectionHeading title="Layout" description="Adjust spacing and how much of the window TabDump's content uses — purely visual, nothing here changes functionality." />

      <div className="flex flex-col gap-2.5">
        <FieldRow label="Content width" description="How wide the main content area can grow.">
          <SegmentedControl
            value={l.contentWidth}
            onValueChange={(v) => setLayout({ contentWidth: v })}
            options={[
              { value: "compact", label: "Compact" },
              { value: "default", label: "Default" },
              { value: "wide", label: "Wide" },
              { value: "full", label: "Full" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Spacing" description="Overall padding and gaps.">
          <SegmentedControl
            value={l.density}
            onValueChange={(v) => setLayout({ density: v })}
            options={[
              { value: "compact", label: "Compact" },
              { value: "comfortable", label: "Comfortable" },
              { value: "spacious", label: "Spacious" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Sidebar density" description="Width of the workspace sidebar.">
          <SegmentedControl
            value={l.sidebarDensity}
            onValueChange={(v) => setLayout({ sidebarDensity: v })}
            options={[
              { value: "compact", label: "Compact" },
              { value: "default", label: "Default" },
              { value: "large", label: "Large" },
            ]}
          />
        </FieldRow>
        <FieldRow label="Card density" description="Padding inside tab and category cards.">
          <SegmentedControl
            value={l.cardDensity}
            onValueChange={(v) => setLayout({ cardDensity: v })}
            options={[
              { value: "compact", label: "Compact" },
              { value: "default", label: "Default" },
              { value: "spacious", label: "Spacious" },
            ]}
          />
        </FieldRow>
      </div>
    </div>
  )
}
