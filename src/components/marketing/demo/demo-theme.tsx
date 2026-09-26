import { DEFAULT_APPEARANCE_SETTINGS } from "@/lib/appearance/defaults"
import { appearanceToCssVars, resolveThemeColors } from "@/lib/appearance/resolve"

/*
 * The demo window's palette: Hubble's own, not the landing page's.
 *
 * The page around the demo has its own brand palette (marketing.css). The
 * window is the product, so inside it the design tokens are exactly what the
 * app writes onto :root for its two system themes — Hubble Light and Hubble
 * Dark — produced here by the app's own resolver rather than copied by hand.
 * A change to the product's palette therefore changes the demo with it.
 *
 * Emitted as a static stylesheet, so the server render already carries both
 * schemes and the visitor's colour scheme picks one with no flash and no
 * hydration mismatch. Background-image and overlay customisation is left
 * out: the demo shows the default product, not a customised one.
 */

function declarations(themeId: string): string {
  const settings = { ...DEFAULT_APPEARANCE_SETTINGS, themeId }
  const vars = appearanceToCssVars(settings, resolveThemeColors(settings))
  return Object.entries(vars)
    .filter(([name]) => !name.startsWith("--tabdump-bg-") && !name.startsWith("--tabdump-overlay-"))
    .map(([name, value]) => `${name}:${value}`)
    .join(";")
}

const LIGHT = declarations("hubble-light")
const DARK = declarations("midnight")

export const DEMO_THEME_CSS = [
  `.tabdump-marketing .m-app{color-scheme:light;${LIGHT}}`,
  `@media (prefers-color-scheme: dark){.tabdump-marketing:not([data-scheme="light"]) .m-app{color-scheme:dark;${DARK}}}`,
  `.tabdump-marketing[data-scheme="dark"] .m-app{color-scheme:dark;${DARK}}`,
].join("\n")

export function DemoThemeStyle() {
  return <style data-hubble-demo-theme="" dangerouslySetInnerHTML={{ __html: DEMO_THEME_CSS }} />
}
