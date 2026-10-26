import { describe, expect, it } from "vitest"
import { contrast, DEFAULT_GRAPH_COLORS, GRAPH_PRESETS } from "@/lib/knowledge-graph/appearance"
import type { GraphColors } from "@/lib/knowledge-graph/appearance"
import { mix, parseColor, resolvePalette } from "./renderer"
import type { RGB } from "./renderer"

const GRAPH_TOKENS = {
  "--graph-filament": "#7d8cff",
  "--graph-rose": "#a9b8ff",
  "--graph-blush": "#dfe6ff",
  "--graph-ember": "#2a2f7a",
  "--graph-starlight": "#eef2ff",
  "--graph-hub": "#d6e0ff",
}
const DARK: Record<string, string> = {
  ...GRAPH_TOKENS,
  "--polarity": "dark",
  "--background": "#0b0c0f",
  "--foreground": "#e8eaef",
  "--muted-foreground": "#9599a3",
  "--text-tertiary": "#737781",
  "--kind-conversation": "#8ab4ff",
  "--kind-source": "#6fd3c1",
}
const LIGHT: Record<string, string> = {
  ...GRAPH_TOKENS,
  "--polarity": "light",
  "--background": "#f6f7f9",
  "--foreground": "#16181d",
  "--muted-foreground": "#5d626c",
  "--text-tertiary": "#7b808a",
  "--kind-conversation": "#2f5bd3",
}

const reader = (tokens: Record<string, string>) => (name: string) => tokens[name] ?? ""

/** The palette exactly as Hubble derived it before appearance existed: the default must not drift from it. */
function legacy(tokens: Record<string, string>) {
  const v = (name: string, fallback: string) => tokens[name] || fallback
  const dark = v("--polarity", "dark") !== "light"
  const background = v("--background", "#0b0c0f")
  const ground = parseColor(background) ?? [11, 12, 15]
  const starlight = parseColor(v("--graph-starlight", "#f3ebe4")) ?? [243, 235, 228]
  const ink: RGB = [28, 22, 26]
  const tone = (raw: RGB, darken: number): RGB => (dark ? raw : mix(raw, ink, darken))
  const kind = (name: string, fallback: RGB): RGB => {
    const raw = parseColor(v(name, "")) ?? fallback
    return dark ? mix(raw, starlight, 0.66) : mix(raw, ink, 0.2)
  }
  const filament = tone(parseColor(v("--graph-filament", "#d24868"))!, 0.18)
  const blush = tone(parseColor(v("--graph-blush", "#f7c6cf"))!, 0.55)
  const ember = tone(parseColor(v("--graph-ember", "#8e2440"))!, 0.1)
  const rgbOf = (c: RGB) => `rgb(${c[0]}, ${c[1]}, ${c[2]})`
  return {
    background: dark ? rgbOf(mix(ground, [0, 0, 0], 0.35)) : background,
    foreground: v("--foreground", "#e8eaef"),
    muted: v("--muted-foreground", "#9599a3"),
    tertiary: v("--text-tertiary", "#737781"),
    kinds: { conversation: kind("--kind-conversation", [138, 180, 255]), source: kind("--kind-source", [111, 211, 193]), file: kind("--kind-file", [226, 183, 122]) },
    filament,
    rose: tone(parseColor(v("--graph-rose", "#ec8298"))!, 0.3),
    blush,
    ember,
    hub: tone(parseColor(v("--graph-hub", "#e9c27c"))!, 0.45),
    starlight: dark ? starlight : ink,
    // What the renderer drew inline before roles had names of their own.
    bridge: dark ? starlight : ember,
    spoke: dark ? blush : filament,
    accent: filament,
    glow: filament,
    node: dark ? starlight : ink,
    dark,
  }
}

describe("resolvePalette", () => {
  it.each([
    ["dark", DARK],
    ["light", LIGHT],
  ])("with Hubble's own colours, draws exactly the %s galaxy it always has", (_, tokens) => {
    const palette = resolvePalette(reader(tokens), DEFAULT_GRAPH_COLORS)
    const expected = legacy(tokens)
    expect(palette).toMatchObject({ ...expected, kinds: expect.objectContaining(expected.kinds) })
  })

  it("recolours each role from the person's colours", () => {
    const colors: GraphColors = { accent: "#8B5CF6", connections: "#00E5FF", nodes: "#FFFFFF", glow: "#FF6B9D", background: "#07050D" }
    const palette = resolvePalette(reader(DARK), colors)
    expect(palette.rose).toEqual([139, 92, 246])
    expect(palette.filament).toEqual([0, 229, 255])
    expect(palette.node).toEqual([255, 255, 255])
    expect(palette.glow).toEqual([255, 107, 157])
    expect(palette.background).toBe("rgb(7, 5, 13)")
  })

  // Hubble's own (no colour set) is the theme's palette untouched — the case above — so it is not re-derived here.
  it("keeps labels, lines and nodes legible whatever colours are set", () => {
    const cases: GraphColors[] = [
      { accent: "#000000", connections: "#050505", nodes: "#101010", glow: "#000000", background: "#000000" },
      { accent: "#2A2A2A", connections: "#1B1030", nodes: "#222222", glow: null, background: "#FFFFFF" },
      { ...DEFAULT_GRAPH_COLORS, connections: "#FFFFFF" },
      { ...DEFAULT_GRAPH_COLORS, background: "#07050D" },
      ...GRAPH_PRESETS.slice(1).map((preset) => preset.colors),
    ]
    for (const tokens of [DARK, LIGHT]) {
      for (const colors of cases) {
        const palette = resolvePalette(reader(tokens), colors)
        const ground = parseColor(palette.background)!
        const where = `${tokens["--polarity"]} ${JSON.stringify(colors)}`
        for (const text of [palette.foreground, palette.muted]) expect(contrast(parseColor(text)!, ground), where).toBeGreaterThanOrEqual(4.5)
        expect(contrast(parseColor(palette.tertiary)!, ground), where).toBeGreaterThanOrEqual(3)
        const lines = { filament: palette.filament, bridge: palette.bridge, spoke: palette.spoke, rose: palette.rose, blush: palette.blush, node: palette.node, hub: palette.hub, ...palette.kinds }
        for (const [role, line] of Object.entries(lines)) expect(contrast(line, ground), `${role} · ${where}`).toBeGreaterThanOrEqual(3)
      }
    }
  })

  it("turns the galaxy dark under a custom background, even on a light theme", () => {
    const palette = resolvePalette(reader(LIGHT), { ...DEFAULT_GRAPH_COLORS, background: "#0B0703" })
    expect(palette.dark).toBe(true)
    expect(palette.background).toBe("rgb(11, 7, 3)")
  })
})
