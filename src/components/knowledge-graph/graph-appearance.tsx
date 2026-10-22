"use client"

import { useState } from "react"
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from "react"
import { SlidersHorizontal } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Slider } from "@/components/ui/slider"
import { Switch } from "@/components/ui/switch"
import { setGraphAppearance, useGraphAppearance } from "@/hooks/use-graph-appearance"
import { activePreset, darkBackground, DEFAULT_GRAPH_APPEARANCE, GRAPH_PRESETS, isDefaultGraphAppearance, parseHex, rgbToHex } from "@/lib/knowledge-graph/appearance"
import type { GraphAppearance, GraphColorRole, GraphColors, NodeSize } from "@/lib/knowledge-graph/appearance"
import { cn } from "@/lib/utils"
import { parseColor, readPalette } from "./renderer"

const COLOR_ROWS: readonly { role: GraphColorRole; label: string }[] = [
  { role: "accent", label: "Accent" },
  { role: "connections", label: "Connections" },
  { role: "nodes", label: "Nodes" },
  { role: "glow", label: "Glow" },
  { role: "background", label: "Background" },
]

const NODE_SIZES = [
  { value: "small", label: "Small" },
  { value: "default", label: "Default" },
  { value: "large", label: "Large" },
] as const satisfies readonly { value: NodeSize; label: string }[]

/**
 * Hubble's own colour for each role, as the current theme gives it: what a
 * colour left to Hubble shows in its swatch. Raw tokens (not the ink tones a
 * light theme draws them in), since a custom colour is toned the same way.
 */
function ownColors(): Record<GraphColorRole, string> {
  const style = getComputedStyle(document.documentElement)
  const hex = (name: string, fallback: string) => {
    const parsed = parseColor(style.getPropertyValue(name).trim())
    return parsed ? rgbToHex(parsed) : fallback
  }
  const ground = parseColor(readPalette().background)
  return {
    accent: hex("--graph-rose", "#EC8298"),
    connections: hex("--graph-filament", "#D24868"),
    nodes: hex("--graph-starlight", "#F3EBE4"),
    glow: hex("--graph-filament", "#D24868"),
    background: ground ? rgbToHex(ground) : "#070809",
  }
}

const update = (patch: Partial<GraphAppearance>) => setGraphAppearance((current) => ({ ...current, ...patch }))
const recolor = (patch: Partial<GraphColors>) => setGraphAppearance((current) => ({ ...current, colors: { ...current.colors, ...patch } }))

/**
 * The Graph's appearance: a small panel off the toolbar. Palettes set the
 * colours together; each colour takes a picker or any HEX; the effects are
 * a few sliders and switches. Every change draws at once and is kept.
 */
export function GraphAppearanceControl({ reducedMotion }: { reducedMotion: boolean }) {
  const appearance = useGraphAppearance()
  const [own, setOwn] = useState<Record<GraphColorRole, string> | null>(null)
  const preset = activePreset(appearance.colors)
  const swatches = own ?? { accent: "#EC8298", connections: "#D24868", nodes: "#F3EBE4", glow: "#D24868", background: "#070809" }
  const background = appearance.colors.background ? darkBackground(appearance.colors.background) : undefined

  return (
    <Popover
      onOpenChange={(open) => {
        // Read once per opening: the theme can have changed since.
        if (open) setOwn(ownColors())
      }}
    >
      <PopoverTrigger
        render={
          <IconButton aria-label="Graph appearance" tooltip="Appearance" className={cn(!isDefaultGraphAppearance(appearance) && "text-foreground")}>
            <SlidersHorizontal />
          </IconButton>
        }
      />
      <PopoverContent align="end" className="max-h-[min(640px,calc(100dvh-96px))] w-72 overflow-y-auto p-0" aria-label="Graph appearance">
        <div className="flex h-10 items-center justify-between border-b border-border px-3">
          <h2 className="text-label text-foreground">Appearance</h2>
          <Button type="button" variant="ghost" size="xs" disabled={isDefaultGraphAppearance(appearance)} onClick={() => setGraphAppearance(DEFAULT_GRAPH_APPEARANCE)}>
            Reset
          </Button>
        </div>

        <Section label="Palette">
          <div role="group" aria-label="Palettes" className="grid grid-cols-5 gap-1">
            {GRAPH_PRESETS.map((entry) => {
              const colors = (role: GraphColorRole) => entry.colors[role] ?? swatches[role]
              const active = preset?.id === entry.id
              return (
                <button
                  key={entry.id}
                  type="button"
                  aria-pressed={active}
                  onClick={() => recolor(entry.colors)}
                  className={cn(
                    "flex flex-col items-center gap-1 rounded-md py-1.5 outline-none transition-colors duration-(--duration-fast) ease-(--ease-color) hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60",
                    active && "bg-surface-selected"
                  )}
                >
                  <span
                    aria-hidden
                    className={cn("relative grid size-6 place-items-center rounded-full border", active ? "border-foreground/70" : "border-border-strong")}
                    style={{ backgroundColor: colors("background") }}
                  >
                    <span className="absolute inset-[5px] rounded-full border" style={{ borderColor: colors("connections") }} />
                    <span className="size-1.5 rounded-full" style={{ backgroundColor: colors("accent"), boxShadow: `0 0 6px 1px ${colors("glow")}` }} />
                  </span>
                  <span className={cn("text-meta", active ? "text-foreground" : "text-tertiary")}>{entry.name}</span>
                </button>
              )
            })}
          </div>
        </Section>

        <Section label="Colours">
          {COLOR_ROWS.map(({ role, label }) => (
            <ColorRow key={role} label={label} value={appearance.colors[role]} fallback={swatches[role]} onChange={(hex) => recolor({ [role]: hex })} />
          ))}
          {background?.adjusted && <p className="text-meta text-tertiary">Background darkened to keep the graph legible</p>}
        </Section>

        <Section label="Effects">
          <Row label="Glow">
            <Slider className="w-32" min={0} max={1} step={0.01} value={appearance.glow} onValueChange={(value) => update({ glow: value })} thumbLabel="Glow intensity" />
          </Row>
          <Row label="Stars">
            <Slider className="w-32" min={0} max={1} step={0.01} value={appearance.stars} disabled={!appearance.effects} onValueChange={(value) => update({ stars: value })} thumbLabel="Star density" />
          </Row>
          <Row label="Connections">
            <Slider className="w-32" min={0} max={1} step={0.01} value={appearance.connections} onValueChange={(value) => update({ connections: value })} thumbLabel="Connection visibility" />
          </Row>
          <Row label="Node size">
            <SegmentedControl size="sm" label="Node size" value={appearance.nodeSize} options={NODE_SIZES} onValueChange={(value) => update({ nodeSize: value })} />
          </Row>
          <Row label="Labels">
            <Switch checked={appearance.labels} onCheckedChange={(on) => update({ labels: on === true })} aria-label="Labels" />
          </Row>
          <Row label="Animation" {...(reducedMotion ? { hint: "Reduced motion" } : {})}>
            <Switch checked={appearance.animation && !reducedMotion} disabled={reducedMotion} onCheckedChange={(on) => update({ animation: on === true })} aria-label="Animation" />
          </Row>
          <Row label="Stars and nebula">
            <Switch checked={appearance.effects} onCheckedChange={(on) => update({ effects: on === true })} aria-label="Stars and nebula" />
          </Row>
        </Section>
      </PopoverContent>
    </Popover>
  )
}

function Section({ label, children }: { label: string; children: ReactNode }) {
  return (
    <section aria-label={label} className="flex flex-col gap-1 border-b border-border px-3 py-2.5 last:border-b-0">
      <h3 className="mb-0.5 text-meta text-tertiary">{label}</h3>
      {children}
    </section>
  )
}

function Row({ label, hint, children }: { label: string; hint?: string; children: ReactNode }) {
  return (
    <div className="flex h-7 items-center justify-between gap-3">
      <span className="text-body-sm text-muted-foreground">
        {label}
        {hint && <span className="ml-1.5 text-meta text-tertiary">{hint}</span>}
      </span>
      {children}
    </div>
  )
}

/**
 * One colour: a swatch that opens the system picker, and its HEX. A full
 * HEX applies as it is typed; a short one (#0EF) when the field is left.
 * Anything that is not a colour is marked and, on leaving, put back.
 */
function ColorRow({ label, value, fallback, onChange }: { label: string; value: string | null; fallback: string; onChange: (hex: string) => void }) {
  const [draft, setDraft] = useState<string | null>(null)
  const shown = value ?? fallback
  const text = draft ?? shown
  const invalid = draft !== null && (/[^#0-9a-f]/i.test(draft) || draft.replace(/^#/, "").length > 6 || draft.indexOf("#") > 0)

  const commit = () => {
    if (draft !== null) {
      const hex = parseHex(draft)
      if (hex && hex !== value) onChange(hex)
    }
    setDraft(null)
  }
  const onKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter") {
      event.preventDefault()
      commit()
    }
  }

  return (
    <div className="flex h-7 items-center gap-2">
      <span className="flex-1 text-body-sm text-muted-foreground">{label}</span>
      <span className="relative size-5 shrink-0 overflow-hidden rounded-xs border border-border-strong" style={{ backgroundColor: shown }}>
        <input
          type="color"
          value={shown.toLowerCase()}
          onChange={(event) => {
            setDraft(null)
            onChange(event.target.value.toUpperCase())
          }}
          aria-label={`${label} colour`}
          className="absolute inset-0 size-full cursor-pointer opacity-0"
        />
      </span>
      <input
        value={text}
        onChange={(event) => {
          const next = event.target.value
          setDraft(next)
          if (next.replace(/^#/, "").length === 6) {
            const hex = parseHex(next)
            if (hex && hex !== value) onChange(hex)
          }
        }}
        onBlur={commit}
        onKeyDown={onKeyDown}
        aria-label={`${label} HEX`}
        aria-invalid={invalid || undefined}
        spellCheck={false}
        autoComplete="off"
        maxLength={7}
        className={cn(
          "h-6 w-[76px] rounded-xs border border-border bg-transparent px-1.5 font-mono text-meta text-foreground uppercase outline-none",
          "transition-colors duration-(--duration-fast) ease-(--ease-color) focus-visible:border-border-strong focus-visible:ring-2 focus-visible:ring-ring/50",
          invalid && "border-destructive focus-visible:border-destructive",
          value === null && draft === null && "text-tertiary"
        )}
      />
    </div>
  )
}
