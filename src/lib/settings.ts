import { isStorageAvailable } from "@/lib/workspace/persistence";
import {
  DEFAULT_APPEARANCE_SETTINGS,
  DEFAULT_BACKGROUND,
  DEFAULT_LAYOUT,
  DEFAULT_MOTION,
  DEFAULT_SHAPE,
  DEFAULT_TYPOGRAPHY,
} from "@/lib/appearance/defaults";
import { DEFAULT_THEME_ID } from "@/lib/appearance/themes";
import { isValidColor } from "@/lib/appearance/contrast";
import type {
  AppearanceSection,
  AppearanceSettings,
  BackgroundSettings,
  LayoutSettings,
  MotionSettings,
  ShapeSettings,
  ThemeColors,
  TypographySettings,
} from "@/lib/appearance/types";

const STORAGE_KEY = "tabdump:settings:v1";

/**
 * Interface sounds (the folder zipper-open sound, and any future UI sound
 * effects) — a sibling of `playIntro` rather than part of `AppearanceSettings`
 * since it isn't a theme/visual concern. `volume` is a 0-100 percentage of
 * the sound engine's already-conservative master gain, so 100 still never
 * reads as loud.
 */
export type SoundSettings = {
  enabled: boolean;
  volume: number;
};

export const DEFAULT_SOUND: SoundSettings = { enabled: true, volume: 35 };

export type Settings = {
  /**
   * Show the cinematic chaos-to-structure intro on every landing page load.
   * Defaults to on. Deliberately independent of any "has the user seen this
   * before" tracking — the intro replaying on every load is the point, and
   * this setting is the only thing allowed to turn that off.
   */
  playIntro: boolean;
  sound: SoundSettings;
} & AppearanceSettings;

const DEFAULT_SETTINGS: Settings = { playIntro: true, sound: DEFAULT_SOUND, ...DEFAULT_APPEARANCE_SETTINGS };

function num(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
}

function str(value: unknown, fallback: string): string {
  return typeof value === "string" ? value : fallback;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], fallback: T): T {
  return typeof value === "string" && (options as readonly string[]).includes(value) ? (value as T) : fallback;
}

function isThemeColors(value: unknown): value is ThemeColors {
  if (!value || typeof value !== "object") return false;
  const required: (keyof ThemeColors)[] = [
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
  const record = value as Record<string, unknown>;
  return required.every((key) => typeof record[key] === "string" && isValidColor(record[key] as string));
}

function readTypography(raw: unknown): TypographySettings {
  if (!raw || typeof raw !== "object") return DEFAULT_TYPOGRAPHY;
  const r = raw as Record<string, unknown>;
  return {
    uiFont: str(r.uiFont, DEFAULT_TYPOGRAPHY.uiFont),
    contentFont: str(r.contentFont, DEFAULT_TYPOGRAPHY.contentFont),
    monoFont: str(r.monoFont, DEFAULT_TYPOGRAPHY.monoFont),
    fontSize: num(r.fontSize, DEFAULT_TYPOGRAPHY.fontSize, 12, 22),
    fontWeight: num(r.fontWeight, DEFAULT_TYPOGRAPHY.fontWeight, 300, 700),
    lineHeight: num(r.lineHeight, DEFAULT_TYPOGRAPHY.lineHeight, 1.1, 2),
    letterSpacing: num(r.letterSpacing, DEFAULT_TYPOGRAPHY.letterSpacing, -1, 4),
  };
}

function readBackground(raw: unknown): BackgroundSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_BACKGROUND;
  const r = raw as Record<string, unknown>;
  return {
    type: oneOf(r.type, ["solid", "gradient", "image"] as const, DEFAULT_BACKGROUND.type),
    color: str(r.color, DEFAULT_BACKGROUND.color),
    gradientFrom: str(r.gradientFrom, DEFAULT_BACKGROUND.gradientFrom),
    gradientTo: str(r.gradientTo, DEFAULT_BACKGROUND.gradientTo),
    gradientAngle: num(r.gradientAngle, DEFAULT_BACKGROUND.gradientAngle, 0, 360),
    imageUrl: str(r.imageUrl, DEFAULT_BACKGROUND.imageUrl),
    size: oneOf(r.size, ["cover", "contain", "tile"] as const, DEFAULT_BACKGROUND.size),
    position: oneOf(r.position, ["center", "top", "bottom", "left", "right"] as const, DEFAULT_BACKGROUND.position),
    opacity: num(r.opacity, DEFAULT_BACKGROUND.opacity, 0, 100),
    blur: num(r.blur, DEFAULT_BACKGROUND.blur, 0, 40),
    brightness: num(r.brightness, DEFAULT_BACKGROUND.brightness, 40, 160),
    contrast: num(r.contrast, DEFAULT_BACKGROUND.contrast, 40, 160),
    saturation: num(r.saturation, DEFAULT_BACKGROUND.saturation, 0, 200),
    overlayColor: str(r.overlayColor, DEFAULT_BACKGROUND.overlayColor),
    overlayOpacity: num(r.overlayOpacity, DEFAULT_BACKGROUND.overlayOpacity, 0, 100),
  };
}

function readLayout(raw: unknown): LayoutSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_LAYOUT;
  const r = raw as Record<string, unknown>;
  return {
    contentWidth: oneOf(r.contentWidth, ["compact", "default", "wide", "full"] as const, DEFAULT_LAYOUT.contentWidth),
    density: oneOf(r.density, ["compact", "comfortable", "spacious"] as const, DEFAULT_LAYOUT.density),
    sidebarDensity: oneOf(r.sidebarDensity, ["compact", "default", "large"] as const, DEFAULT_LAYOUT.sidebarDensity),
    cardDensity: oneOf(r.cardDensity, ["compact", "default", "spacious"] as const, DEFAULT_LAYOUT.cardDensity),
  };
}

function readShape(raw: unknown): ShapeSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SHAPE;
  const r = raw as Record<string, unknown>;
  return {
    radius: oneOf(r.radius, ["sharp", "small", "medium", "rounded", "very-rounded"] as const, DEFAULT_SHAPE.radius),
    borderIntensity: oneOf(r.borderIntensity, ["none", "subtle", "normal", "strong"] as const, DEFAULT_SHAPE.borderIntensity),
    shadowIntensity: oneOf(r.shadowIntensity, ["none", "subtle", "normal", "strong"] as const, DEFAULT_SHAPE.shadowIntensity),
  };
}

function readSound(raw: unknown): SoundSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_SOUND;
  const r = raw as Record<string, unknown>;
  return {
    enabled: typeof r.enabled === "boolean" ? r.enabled : DEFAULT_SOUND.enabled,
    volume: num(r.volume, DEFAULT_SOUND.volume, 0, 100),
  };
}

function readMotion(raw: unknown): MotionSettings {
  if (!raw || typeof raw !== "object") return DEFAULT_MOTION;
  const r = raw as Record<string, unknown>;
  return {
    level: oneOf(r.level, ["off", "reduced", "normal", "expressive"] as const, DEFAULT_MOTION.level),
    transitionSpeed: oneOf(r.transitionSpeed, ["fast", "normal", "slow"] as const, DEFAULT_MOTION.transitionSpeed),
  };
}

function readSettings(): Settings {
  if (!isStorageAvailable()) return DEFAULT_SETTINGS;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULT_SETTINGS;
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return DEFAULT_SETTINGS;
    return {
      playIntro: typeof parsed.playIntro === "boolean" ? parsed.playIntro : DEFAULT_SETTINGS.playIntro,
      sound: readSound(parsed.sound),
      themeId: str(parsed.themeId, DEFAULT_THEME_ID),
      customTheme: isThemeColors(parsed.customTheme) ? parsed.customTheme : null,
      favoriteThemeIds: Array.isArray(parsed.favoriteThemeIds)
        ? parsed.favoriteThemeIds.filter((id: unknown): id is string => typeof id === "string")
        : [],
      randomThemeEnabled: typeof parsed.randomThemeEnabled === "boolean" ? parsed.randomThemeEnabled : false,
      typography: readTypography(parsed.typography),
      background: readBackground(parsed.background),
      layout: readLayout(parsed.layout),
      shape: readShape(parsed.shape),
      motion: readMotion(parsed.motion),
      accentOverride:
        typeof parsed.accentOverride === "string" && isValidColor(parsed.accentOverride) ? parsed.accentOverride : null,
    };
  } catch {
    return DEFAULT_SETTINGS;
  }
}

function writeSettings(patch: Partial<Settings>): Settings {
  const next = { ...readSettings(), ...patch };
  if (!isStorageAvailable()) return next;
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Non-critical UI preference — worst case it doesn't persist this time.
  }
  return next;
}

export function getSettings(): Settings {
  return readSettings();
}

export function setPlayIntro(enabled: boolean): void {
  writeSettings({ playIntro: enabled });
}

export function setSound(patch: Partial<SoundSettings>): Settings {
  const current = readSettings();
  return writeSettings({ sound: { ...current.sound, ...patch } });
}

export function setThemeId(themeId: string): Settings {
  // Presets and the custom theme are mutually exclusive — resolveThemeColors
  // (src/lib/appearance/resolve.ts) prefers customTheme whenever it's set,
  // so switching to a preset always clears it too. Otherwise the newly
  // picked preset would be silently masked by whatever custom palette was
  // last saved.
  return writeSettings({ themeId, customTheme: null });
}

export function setCustomTheme(colors: ThemeColors | null): Settings {
  return writeSettings({ customTheme: colors });
}

export function toggleFavoriteTheme(themeId: string): Settings {
  const current = readSettings();
  const has = current.favoriteThemeIds.includes(themeId);
  const favoriteThemeIds = has
    ? current.favoriteThemeIds.filter((id) => id !== themeId)
    : [...current.favoriteThemeIds, themeId];
  return writeSettings({ favoriteThemeIds });
}

export function setRandomThemeEnabled(enabled: boolean): Settings {
  return writeSettings({ randomThemeEnabled: enabled });
}

export function setTypography(patch: Partial<TypographySettings>): Settings {
  const current = readSettings();
  return writeSettings({ typography: { ...current.typography, ...patch } });
}

export function setBackground(patch: Partial<BackgroundSettings>): Settings {
  const current = readSettings();
  return writeSettings({ background: { ...current.background, ...patch } });
}

export function setLayout(patch: Partial<LayoutSettings>): Settings {
  const current = readSettings();
  return writeSettings({ layout: { ...current.layout, ...patch } });
}

export function setShape(patch: Partial<ShapeSettings>): Settings {
  const current = readSettings();
  return writeSettings({ shape: { ...current.shape, ...patch } });
}

export function setMotion(patch: Partial<MotionSettings>): Settings {
  const current = readSettings();
  return writeSettings({ motion: { ...current.motion, ...patch } });
}

export function setAccentOverride(hex: string | null): Settings {
  return writeSettings({ accentOverride: hex });
}

const SECTION_DEFAULTS: Record<AppearanceSection, Partial<Settings>> = {
  theme: { themeId: DEFAULT_THEME_ID, customTheme: null },
  typography: { typography: DEFAULT_TYPOGRAPHY },
  background: { background: DEFAULT_BACKGROUND },
  layout: { layout: DEFAULT_LAYOUT },
  shape: { shape: DEFAULT_SHAPE },
  motion: { motion: DEFAULT_MOTION },
  accent: { accentOverride: null },
};

export function resetAppearanceSection(section: AppearanceSection): Settings {
  return writeSettings(SECTION_DEFAULTS[section]);
}

export function resetAllAppearance(): Settings {
  return writeSettings(DEFAULT_APPEARANCE_SETTINGS);
}
