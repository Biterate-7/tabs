"use client"

import { useEffect, useRef, useState } from "react"
import { Download, Upload } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { getContrastWarning, isValidColor, normalizeHex } from "@/lib/appearance/contrast"
import { deriveSubtleFields } from "@/lib/appearance/themes"
import { downloadTextFile } from "@/lib/workspace/export"
import { parseThemeImport, serializeCustomTheme } from "@/lib/appearance/export-import"
import { MiniPreview } from "./mini-preview"
import type { ThemeColors } from "@/lib/appearance/types"

function toPickerValue(hex: string): string {
  if (!isValidColor(hex)) return "#000000"
  return `#${normalizeHex(hex)}`
}

function ColorRow({
  label,
  value,
  onChange,
  warningAgainst,
}: {
  label: string
  value: string
  onChange: (hex: string) => void
  warningAgainst?: string
}) {
  const [text, setText] = useState(value)
  useEffect(() => {
    // Syncs the text field when the color changes from outside this row
    // (picker input, an import, a "reset" action) — not on every keystroke,
    // since commitText already updates `text` itself.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setText(value)
  }, [value])
  const warning = warningAgainst ? getContrastWarning(value, warningAgainst) : null

  function commitText(next: string) {
    setText(next)
    const candidate = next.startsWith("#") ? next : `#${next}`
    if (isValidColor(candidate)) onChange(candidate)
  }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-subtle p-2">
      <input
        type="color"
        aria-label={`${label} color`}
        value={toPickerValue(value)}
        onChange={(e) => onChange(e.target.value)}
        className="size-7 shrink-0 cursor-pointer rounded border border-border bg-transparent p-0"
      />
      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground" title={warning ?? undefined}>
        {label}
      </span>
      {warning && (
        <span className="text-[0.65rem] text-warning" title={warning}>
          low contrast
        </span>
      )}
      <input
        value={text}
        onChange={(e) => commitText(e.target.value)}
        spellCheck={false}
        className="w-24 rounded-md border border-border bg-transparent px-1.5 py-1 text-meta text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
      />
    </div>
  )
}

const GROUPS: { title: string; fields: { key: keyof ThemeColors; label: string; contrastAgainst?: keyof ThemeColors }[] }[] = [
  {
    title: "Background",
    fields: [
      { key: "background", label: "Background" },
      { key: "backgroundSecondary", label: "Background Secondary" },
      { key: "backgroundTertiary", label: "Background Tertiary" },
    ],
  },
  {
    title: "Surface",
    fields: [
      { key: "surface", label: "Surface" },
      { key: "surfaceHover", label: "Surface Hover" },
      { key: "surfaceActive", label: "Surface Active" },
      { key: "surfaceSelected", label: "Surface Selected" },
    ],
  },
  {
    title: "Text",
    fields: [
      { key: "text", label: "Text", contrastAgainst: "background" },
      { key: "textSecondary", label: "Secondary Text", contrastAgainst: "background" },
      { key: "textMuted", label: "Muted Text", contrastAgainst: "background" },
    ],
  },
  {
    title: "Accent",
    fields: [
      { key: "accent", label: "Accent" },
      { key: "accentHover", label: "Accent Hover" },
      { key: "accentActive", label: "Accent Active" },
    ],
  },
  {
    title: "Border",
    fields: [
      { key: "border", label: "Border" },
      { key: "borderSubtle", label: "Subtle Border" },
      { key: "borderStrong", label: "Strong Border" },
    ],
  },
  {
    title: "Status",
    fields: [
      { key: "success", label: "Success" },
      { key: "warning", label: "Warning" },
      { key: "error", label: "Error" },
      { key: "info", label: "Info" },
    ],
  },
  {
    title: "Graph",
    fields: [
      { key: "graphNode", label: "Graph Node" },
      { key: "graphNodeSelected", label: "Graph Node Selected" },
      { key: "graphEdge", label: "Graph Edge" },
    ],
  },
  {
    title: "Editor / Notes",
    fields: [
      { key: "editorBackground", label: "Editor Background" },
      { key: "editorText", label: "Editor Text", contrastAgainst: "editorBackground" },
      { key: "editorPlaceholder", label: "Editor Placeholder" },
    ],
  },
  {
    title: "Selection & Focus",
    fields: [
      { key: "selection", label: "Selection" },
      { key: "focus", label: "Focus" },
    ],
  },
]

export function CustomThemeEditor({ colors, onChange }: { colors: ThemeColors; onChange: (colors: ThemeColors) => void }) {
  const fileInputRef = useRef<HTMLInputElement>(null)

  function updateField(key: keyof ThemeColors, value: string) {
    onChange(deriveSubtleFields({ ...colors, [key]: value }))
  }

  function handleExport() {
    const json = serializeCustomTheme("My TabDump theme", colors)
    downloadTextFile("tabdump-theme.json", json)
  }

  function handleImportClick() {
    fileInputRef.current?.click()
  }

  async function handleImportFile(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0]
    e.target.value = ""
    if (!file) return
    const text = await file.text()
    const result = parseThemeImport(text)
    if (!result.ok) {
      toast.error("Couldn't import theme", { description: result.reason })
      return
    }
    onChange(deriveSubtleFields(result.colors))
    toast.success(`Imported "${result.name}"`)
  }

  return (
    <div className="grid gap-6 lg:grid-cols-[1fr_20rem]">
      <div className="flex flex-col gap-5">
        <div className="flex items-center justify-between">
          <p className="text-body-sm text-muted-foreground">Every change below applies live across TabDump — nothing here needs to be saved.</p>
          <div className="flex shrink-0 gap-1.5">
            <Button type="button" variant="outline" size="sm" onClick={handleImportClick}>
              <Upload /> Import
            </Button>
            <Button type="button" variant="outline" size="sm" onClick={handleExport}>
              <Download /> Export
            </Button>
            <input ref={fileInputRef} type="file" accept="application/json" className="hidden" onChange={handleImportFile} />
          </div>
        </div>

        {GROUPS.map((group) => (
          <div key={group.title}>
            <p className="mb-1.5 px-0.5 text-label text-tertiary">{group.title.toUpperCase()}</p>
            <div className="flex flex-col gap-1.5">
              {group.fields.map((field) => (
                <ColorRow
                  key={field.key}
                  label={field.label}
                  value={colors[field.key]}
                  onChange={(hex) => updateField(field.key, hex)}
                  warningAgainst={field.contrastAgainst ? colors[field.contrastAgainst] : undefined}
                />
              ))}
            </div>
          </div>
        ))}
      </div>

      <div className="lg:sticky lg:top-0 lg:self-start">
        <p className="mb-1.5 px-0.5 text-label text-tertiary">LIVE PREVIEW</p>
        <MiniPreview />
      </div>
    </div>
  )
}
