import type { FontOption } from "./types";

/**
 * Every font selectable in Settings → Appearance → Typography. `cssVar` must
 * match the `variable` option passed to the corresponding next/font/google
 * call in src/app/layout.tsx — that's what actually self-hosts the font;
 * this registry just describes which var backs which picker entry.
 *
 * "System UI" has no cssVar of its own — it resolves straight to the OS
 * font stack, so it's excluded from next/font entirely.
 */
export const SYSTEM_UI_FONT_ID = "system-ui";
const SYSTEM_UI_STACK =
  "ui-sans-serif, system-ui, -apple-system, 'Segoe UI', Roboto, sans-serif";

export const FONT_OPTIONS: FontOption[] = [
  { id: SYSTEM_UI_FONT_ID, label: "System UI", cssVar: "", kind: "sans" },
  { id: "geist", label: "Geist", cssVar: "--font-geist-sans", kind: "sans" },
  { id: "inter", label: "Inter", cssVar: "--font-inter", kind: "sans" },
  { id: "ibm-plex-sans", label: "IBM Plex Sans", cssVar: "--font-ibm-plex-sans", kind: "sans" },
  { id: "roboto", label: "Roboto", cssVar: "--font-roboto", kind: "sans" },
  { id: "fira-sans", label: "Fira Sans", cssVar: "--font-fira-sans", kind: "sans" },
  { id: "manrope", label: "Manrope", cssVar: "--font-manrope", kind: "sans" },
  { id: "dm-sans", label: "DM Sans", cssVar: "--font-dm-sans", kind: "sans" },
  { id: "nunito", label: "Nunito", cssVar: "--font-nunito", kind: "sans" },
  { id: "plus-jakarta-sans", label: "Plus Jakarta Sans", cssVar: "--font-plus-jakarta-sans", kind: "sans" },
  { id: "montserrat", label: "Montserrat", cssVar: "--font-montserrat", kind: "sans" },
  { id: "poppins", label: "Poppins", cssVar: "--font-poppins", kind: "sans" },
  { id: "lora", label: "Lora", cssVar: "--font-lora", kind: "serif" },
  { id: "merriweather", label: "Merriweather", cssVar: "--font-merriweather", kind: "serif" },
  { id: "geist-mono", label: "Geist Mono", cssVar: "--font-geist-mono", kind: "mono" },
  { id: "ibm-plex-mono", label: "IBM Plex Mono", cssVar: "--font-ibm-plex-mono", kind: "mono" },
  { id: "jetbrains-mono", label: "JetBrains Mono", cssVar: "--font-jetbrains-mono", kind: "mono" },
  { id: "roboto-mono", label: "Roboto Mono", cssVar: "--font-roboto-mono", kind: "mono" },
  { id: "space-mono", label: "Space Mono", cssVar: "--font-space-mono", kind: "mono" },
  { id: "source-code-pro", label: "Source Code Pro", cssVar: "--font-source-code-pro", kind: "mono" },
  { id: "fira-code", label: "Fira Code", cssVar: "--font-fira-code", kind: "mono" },
  { id: "cascadia-code", label: "Cascadia Code", cssVar: "--font-cascadia-code", kind: "mono" },
];

const FONT_BY_ID = new Map(FONT_OPTIONS.map((f) => [f.id, f]));

export function getFontOption(id: string): FontOption {
  return FONT_BY_ID.get(id) ?? FONT_BY_ID.get(SYSTEM_UI_FONT_ID)!;
}

/** The actual CSS `font-family` value for a font id — a `var(...)` reference for loaded fonts, or the raw system stack. */
export function fontFamilyValue(id: string): string {
  if (id === SYSTEM_UI_FONT_ID) return SYSTEM_UI_STACK;
  const option = getFontOption(id);
  return option.cssVar ? `var(${option.cssVar})` : SYSTEM_UI_STACK;
}

export function fontsByKind(kind: FontOption["kind"]): FontOption[] {
  return FONT_OPTIONS.filter((f) => f.kind === kind);
}
