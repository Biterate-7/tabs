"use client"

import { Checkbox } from "@/components/ui/checkbox"
import { Pill } from "@/components/workspace/category-filter-bar"
import type { ConnectionFilters, GraphDisplaySettings, NodeSizeMode } from "@/lib/graph/types"

const CONNECTION_ROWS: { key: keyof ConnectionFilters; label: string }[] = [
  { key: "domain", label: "Same domain" },
  { key: "workspace", label: "Same workspace" },
  { key: "category", label: "Same category" },
  { key: "group", label: "Same group" },
  { key: "section", label: "Same section" },
  { key: "manual", label: "Manual" },
  { key: "dependencies", label: "Dependencies" },
]

const NODE_SIZE_OPTIONS: { key: NodeSizeMode; label: string }[] = [
  { key: "uniform", label: "Same size" },
  { key: "connections", label: "Connections" },
  { key: "relevance", label: "Relevance" },
]

function SliderRow({
  label,
  value,
  min,
  max,
  step,
  onChange,
}: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (value: number) => void
}) {
  return (
    <label className="block">
      <span className="text-body-sm text-muted-foreground">{label}</span>
      <input
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(Number(e.target.value))}
        style={{ accentColor: "var(--primary)" }}
        className="mt-1 w-full"
      />
    </label>
  )
}

export function GraphSettingsPanel({
  filters,
  onFiltersChange,
  display,
  onDisplayChange,
  showClusterBoundaries,
  onShowClusterBoundariesChange,
  workspaces,
  workspaceFilter,
  onWorkspaceFilterChange,
}: {
  filters: ConnectionFilters
  onFiltersChange: (filters: ConnectionFilters) => void
  display: GraphDisplaySettings
  onDisplayChange: (display: GraphDisplaySettings) => void
  showClusterBoundaries: boolean
  onShowClusterBoundariesChange: (value: boolean) => void
  workspaces: { id: string; name: string }[]
  workspaceFilter: string | "all"
  onWorkspaceFilterChange: (value: string | "all") => void
}) {
  return (
    <div className="space-y-5">
      <div>
        <p className="text-label text-tertiary">CONNECTIONS</p>
        <div className="mt-2 space-y-2">
          {CONNECTION_ROWS.map((row) => (
            <label key={row.key} className="flex items-center gap-2 text-body-sm text-foreground">
              <Checkbox
                checked={filters[row.key]}
                onCheckedChange={(checked) =>
                  onFiltersChange({ ...filters, [row.key]: checked === true })
                }
              />
              {row.label}
            </label>
          ))}
        </div>
      </div>

      <div>
        <p className="text-label text-tertiary">DISPLAY</p>
        <div className="mt-2 space-y-3">
          <label className="flex items-center gap-2 text-body-sm text-foreground">
            <Checkbox
              checked={showClusterBoundaries}
              onCheckedChange={(checked) => onShowClusterBoundariesChange(checked === true)}
            />
            Show category regions
          </label>
          <div>
            <p className="mb-1.5 text-body-sm text-muted-foreground">Node size</p>
            <div className="flex flex-wrap gap-1.5">
              {NODE_SIZE_OPTIONS.map((opt) => (
                <Pill
                  key={opt.key}
                  active={display.nodeSize === opt.key}
                  onClick={() => onDisplayChange({ ...display, nodeSize: opt.key })}
                >
                  {opt.label}
                </Pill>
              ))}
            </div>
          </div>
          <SliderRow
            label="Edge strength"
            value={display.edgeStrength}
            min={0.2}
            max={2}
            step={0.1}
            onChange={(v) => onDisplayChange({ ...display, edgeStrength: v })}
          />
          <SliderRow
            label="Text size"
            value={display.textSize}
            min={0.75}
            max={1.5}
            step={0.05}
            onChange={(v) => onDisplayChange({ ...display, textSize: v })}
          />
        </div>
      </div>

      {workspaces.length > 1 && (
        <div>
          <p className="text-label text-tertiary">WORKSPACE</p>
          <div className="mt-2 flex flex-wrap gap-1.5">
            <Pill active={workspaceFilter === "all"} onClick={() => onWorkspaceFilterChange("all")}>
              All
            </Pill>
            {workspaces.map((w) => (
              <Pill
                key={w.id}
                active={workspaceFilter === w.id}
                onClick={() => onWorkspaceFilterChange(w.id)}
              >
                {w.name}
              </Pill>
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
