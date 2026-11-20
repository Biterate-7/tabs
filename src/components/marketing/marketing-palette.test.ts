import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"

/*
 * The site is midnight black and monochrome: near-black grounds, white ink,
 * grey tiers. The only colour on the page is the AI apps' own logos, which
 * are images. These tests keep it that way — a blue link, an accent token
 * left to the app's default, or a Tailwind palette class in a demo would
 * each bring the old blue back.
 */

const ROOT = process.cwd()
const CSS = readFileSync(join(ROOT, "src/app/marketing.css"), "utf8")

/** How far a colour is from grey: the spread of its channels, 0–255. */
function chroma(r: number, g: number, b: number): number {
  return Math.max(r, g, b) - Math.min(r, g, b)
}

function colours(source: string): { literal: string; chroma: number }[] {
  const found: { literal: string; chroma: number }[] = []
  for (const match of source.matchAll(/#([0-9a-f]{6}|[0-9a-f]{3})\b/gi)) {
    const hex = match[1]!.length === 3 ? [...match[1]!].map((c) => c + c).join("") : match[1]!
    const [r, g, b] = [0, 2, 4].map((i) => parseInt(hex.slice(i, i + 2), 16)) as [number, number, number]
    found.push({ literal: match[0], chroma: chroma(r, g, b) })
  }
  for (const match of source.matchAll(/rgba?\(\s*(\d+)[\s,]+(\d+)[\s,]+(\d+)/g)) {
    found.push({ literal: match[0], chroma: chroma(Number(match[1]), Number(match[2]), Number(match[3])) })
  }
  return found
}

/** The page's own source files, outside tests. */
function marketingSources(): { file: string; text: string }[] {
  const dirs = ["src/components/marketing", "src/components/marketing/showcase"]
  return dirs.flatMap((dir) =>
    readdirSync(join(ROOT, dir))
      .filter((name) => /\.(tsx?|css)$/.test(name) && !/\.test\./.test(name))
      .map((name) => ({ file: `${dir}/${name}`, text: readFileSync(join(ROOT, dir, name), "utf8") }))
  )
}

describe("the marketing palette", () => {
  it("uses only neutral colours — no blue, no purple, no accent hue", () => {
    const chromatic = colours(CSS).filter((colour) => colour.chroma > 20)
    expect(chromatic).toEqual([])
  })

  it("is dark only: no light scheme and no scheme switch to bring one back", () => {
    expect(CSS).toMatch(/\.tabdump-marketing\s*\{[^}]*color-scheme:\s*dark/)
    expect(CSS).not.toMatch(/prefers-color-scheme/)
    expect(CSS).not.toMatch(/data-scheme/)
  })

  it("restates every token the app would colour, so a component default cannot leak in", () => {
    const scope = CSS.slice(CSS.indexOf(".tabdump-marketing {"), CSS.indexOf("\n}\n", CSS.indexOf(".tabdump-marketing {")))
    for (const token of [
      "--link",
      "--info",
      "--selection",
      "--primary",
      "--ring",
      "--focus",
      "--success",
      "--warning",
      "--destructive",
      "--kind-conversation",
      "--kind-source",
      "--kind-file",
      "--kind-note",
      "--kind-session",
      "--graph-node",
      "--graph-node-selected",
      "--graph-edge",
    ]) {
      expect(scope, token).toMatch(new RegExp(`${token}:`))
    }
  })

  it("keeps Tailwind colour palettes and hard-coded hues out of the page's components", () => {
    const palette = /\b(?:bg|text|border|ring|from|to|via|fill|stroke|shadow|outline|decoration)-(?:blue|indigo|sky|violet|purple|cyan|teal|fuchsia|pink|emerald|green|lime|amber|orange|yellow|red|rose)-\d{2,3}\b/
    for (const { file, text } of marketingSources()) {
      expect(text.match(palette)?.[0], file).toBeUndefined()
      const chromatic = colours(text).filter((colour) => colour.chroma > 20)
      expect(chromatic, file).toEqual([])
    }
  })
})
