/**
 * Minimal WCAG contrast helpers. Used to (a) pick a readable foreground for
 * a fill color when a theme doesn't specify one explicitly, and (b) warn —
 * never block — when a custom theme's text/background pairing falls under
 * AA. Accepts #RGB / #RRGGBB / #RRGGBBAA; alpha is ignored for contrast math
 * (callers compare against opaque surfaces).
 */

export function normalizeHex(hex: string): string {
  let h = hex.trim().replace(/^#/, "");
  if (h.length === 3 || h.length === 4) {
    h = h
      .split("")
      .map((c) => c + c)
      .join("");
  }
  return h.slice(0, 6);
}

export function isValidColor(hex: string): boolean {
  const h = hex.trim().replace(/^#/, "");
  return /^([0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/.test(h);
}

function hexToRgb(hex: string): [number, number, number] | null {
  if (!isValidColor(hex)) return null;
  const h = normalizeHex(hex);
  const num = Number.parseInt(h, 16);
  if (Number.isNaN(num)) return null;
  return [(num >> 16) & 255, (num >> 8) & 255, num & 255];
}

function relativeLuminance([r, g, b]: [number, number, number]): number {
  const [rs, gs, bs] = [r, g, b].map((c) => {
    const v = c / 255;
    return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
  });
  return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
}

/** WCAG contrast ratio between two colors, from 1 (identical) to 21 (black/white). Returns null for unparseable input. */
export function contrastRatio(a: string, b: string): number | null {
  const rgbA = hexToRgb(a);
  const rgbB = hexToRgb(b);
  if (!rgbA || !rgbB) return null;
  const lumA = relativeLuminance(rgbA);
  const lumB = relativeLuminance(rgbB);
  const lighter = Math.max(lumA, lumB);
  const darker = Math.min(lumA, lumB);
  return (lighter + 0.05) / (darker + 0.05);
}

export type ContrastLevel = "fail" | "aa-large" | "aa" | "aaa";

export function contrastLevel(ratio: number | null): ContrastLevel {
  if (ratio === null) return "fail";
  if (ratio >= 7) return "aaa";
  if (ratio >= 4.5) return "aa";
  if (ratio >= 3) return "aa-large";
  return "fail";
}

/** Returns a warning string for the custom-theme editor when a pair reads poorly, or null when it's fine. Never used to block saving. */
export function getContrastWarning(foreground: string, background: string): string | null {
  const ratio = contrastRatio(foreground, background);
  if (ratio === null) return null;
  if (ratio < 3) return `Low contrast (${ratio.toFixed(1)}:1) — this text may be hard to read.`;
  if (ratio < 4.5) return `Below AA for body text (${ratio.toFixed(1)}:1) — okay for large text only.`;
  return null;
}

/** Picks white or near-black, whichever contrasts better against `hex`. Used to auto-derive foreground colors (e.g. text on an accent-filled button) so the custom editor doesn't need a field for every pairing. */
export function bestForeground(hex: string, dark = "#181818", light = "#ffffff"): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return light;
  const ratioLight = contrastRatio(hex, light) ?? 0;
  const ratioDark = contrastRatio(hex, dark) ?? 0;
  return ratioLight >= ratioDark ? light : dark;
}

/** Mixes `hex` toward `toward` by `amount` (0-1) — a tiny lighten/darken helper for deriving hover/active/subtle steps without a color-math library. */
export function mix(hex: string, toward: string, amount: number): string {
  const a = hexToRgb(hex);
  const b = hexToRgb(toward);
  if (!a || !b) return hex;
  const t = Math.max(0, Math.min(1, amount));
  const mixed = a.map((c, i) => Math.round(c + (b[i] - c) * t)) as [number, number, number];
  return `#${mixed.map((c) => c.toString(16).padStart(2, "0")).join("")}`;
}

/** hex -> "r, g, b" for building rgba() strings (e.g. graph edge alpha variants) from a theme color. */
export function rgbTriplet(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return "128, 128, 128";
  return rgb.join(", ");
}

/** Whether `hex` reads as a dark surface — used to decide which direction (toward white or black) derived hover/active steps should lighten. */
export function isDarkColor(hex: string): boolean {
  const rgb = hexToRgb(hex);
  if (!rgb) return true;
  return relativeLuminance(rgb) < 0.5;
}
