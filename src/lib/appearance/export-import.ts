import { isValidColor } from "./contrast";
import type { ThemeColors } from "./types";

const EXPORT_VERSION = 1;

export type ThemeExport = {
  version: number;
  name: string;
  colors: ThemeColors;
};

export function serializeCustomTheme(name: string, colors: ThemeColors): string {
  const payload: ThemeExport = { version: EXPORT_VERSION, name, colors };
  return JSON.stringify(payload, null, 2);
}

export type ThemeImportResult = { ok: true; name: string; colors: ThemeColors } | { ok: false; reason: string };

const COLOR_FIELDS: (keyof ThemeColors)[] = [
  "background",
  "backgroundSecondary",
  "backgroundTertiary",
  "surface",
  "surfaceHover",
  "surfaceActive",
  "surfaceSelected",
  "text",
  "textSecondary",
  "textMuted",
  "textDisabled",
  "accent",
  "accentHover",
  "accentActive",
  "accentSubtle",
  "border",
  "borderSubtle",
  "borderStrong",
  "success",
  "successSubtle",
  "warning",
  "warningSubtle",
  "error",
  "errorSubtle",
  "info",
  "infoSubtle",
  "selection",
  "focus",
  "graphNode",
  "graphNodeSelected",
  "graphEdge",
  "editorBackground",
  "editorText",
  "editorPlaceholder",
];

/**
 * Parses & validates a theme export. Never throws — malformed or
 * malicious-looking input (wrong shape, non-color strings, missing fields)
 * is reported as a typed failure so the custom editor can show a message
 * instead of the app breaking on a bad paste/file.
 */
export function parseThemeImport(text: string): ThemeImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { ok: false, reason: "That file isn't valid JSON." };
  }
  if (!parsed || typeof parsed !== "object") {
    return { ok: false, reason: "That file doesn't look like a theme export." };
  }
  const record = parsed as Record<string, unknown>;
  const colorsRaw = record.colors;
  if (!colorsRaw || typeof colorsRaw !== "object") {
    return { ok: false, reason: "That file doesn't look like a theme export." };
  }
  const colorsRecord = colorsRaw as Record<string, unknown>;
  const colors: Partial<ThemeColors> = {};
  for (const field of COLOR_FIELDS) {
    const value = colorsRecord[field];
    if (typeof value !== "string" || !isValidColor(value)) {
      return { ok: false, reason: `Missing or invalid color: ${field}.` };
    }
    colors[field] = value;
  }
  const name = typeof record.name === "string" && record.name.trim() ? record.name.trim() : "Imported theme";
  return { ok: true, name, colors: colors as ThemeColors };
}
