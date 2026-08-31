import { bestForeground, isDarkColor, isValidColor, mix, rgbTriplet } from "./contrast";
import { fontFamilyValue } from "./fonts";
import { getTheme } from "./themes";
import type { AppearanceSettings, BackgroundSettings, ThemeColors } from "./types";

/** Re-derives the accent-dependent slots of a theme's colors around an independent accent override, leaving everything else (backgrounds, text, graph identity, editor tokens) untouched — see Phase 20 of the appearance spec. */
function applyAccentOverride(colors: ThemeColors, overrideHex: string): ThemeColors {
  const toEdge = isDarkColor(colors.background) ? "#ffffff" : "#000000";
  return {
    ...colors,
    accent: overrideHex,
    accentHover: mix(overrideHex, toEdge, 0.12),
    accentActive: mix(overrideHex, "#000000", 0.16),
    accentSubtle: mix(overrideHex, colors.background, 0.84),
    focus: overrideHex,
    graphNodeSelected: overrideHex,
    surfaceSelected: mix(colors.surface, overrideHex, 0.18),
    selection: mix(overrideHex, colors.background, 0.72),
  };
}

export function resolveThemeColors(settings: AppearanceSettings): ThemeColors {
  const base = settings.customTheme ?? getTheme(settings.themeId)?.colors ?? getTheme("midnight")!.colors;
  if (settings.accentOverride && isValidColor(settings.accentOverride)) {
    return applyAccentOverride(base, settings.accentOverride);
  }
  return base;
}

function borderStep(hex: string, background: string, intensity: AppearanceSettings["shape"]["borderIntensity"], strongEdge: string): string {
  switch (intensity) {
    case "none":
      return background;
    case "subtle":
      return mix(hex, background, 0.45);
    case "strong":
      return mix(hex, strongEdge, 0.35);
    default:
      return hex;
  }
}

const SHADOW_LEVELS: Record<AppearanceSettings["shape"]["shadowIntensity"], { sm: string; md: string; lg: string }> = {
  none: { sm: "none", md: "none", lg: "none" },
  subtle: {
    sm: "0 1px 2px 0 rgb(0 0 0 / 0.04)",
    md: "0 2px 8px -2px rgb(0 0 0 / 0.06)",
    lg: "0 8px 20px -6px rgb(0 0 0 / 0.08)",
  },
  normal: {
    sm: "0 1px 3px 0 rgb(0 0 0 / 0.1), 0 1px 2px -1px rgb(0 0 0 / 0.1)",
    md: "0 4px 6px -1px rgb(0 0 0 / 0.1), 0 2px 4px -2px rgb(0 0 0 / 0.1)",
    lg: "0 10px 15px -3px rgb(0 0 0 / 0.1), 0 4px 6px -4px rgb(0 0 0 / 0.1)",
  },
  strong: {
    sm: "0 2px 4px 0 rgb(0 0 0 / 0.18)",
    md: "0 8px 16px -2px rgb(0 0 0 / 0.24), 0 4px 8px -4px rgb(0 0 0 / 0.2)",
    lg: "0 20px 32px -6px rgb(0 0 0 / 0.3), 0 8px 16px -8px rgb(0 0 0 / 0.26)",
  },
};

const RADIUS_LEVELS: Record<AppearanceSettings["shape"]["radius"], string> = {
  sharp: "0rem",
  small: "0.3125rem",
  medium: "0.625rem",
  rounded: "1rem",
  "very-rounded": "1.5rem",
};

const CONTENT_WIDTH_LEVELS: Record<AppearanceSettings["layout"]["contentWidth"], string> = {
  compact: "48rem",
  default: "72rem",
  wide: "90rem",
  full: "none",
};

const DENSITY_SCALE: Record<AppearanceSettings["layout"]["density"], string> = {
  compact: "0.8",
  comfortable: "1",
  spacious: "1.25",
};

const SIDEBAR_WIDTH: Record<AppearanceSettings["layout"]["sidebarDensity"], string> = {
  compact: "12.5rem",
  default: "15rem",
  large: "17.5rem",
};

const CARD_DENSITY_SCALE: Record<AppearanceSettings["layout"]["cardDensity"], string> = {
  compact: "0.75",
  default: "1",
  spacious: "1.3",
};

const MOTION_SCALE: Record<AppearanceSettings["motion"]["level"], string> = {
  off: "0",
  reduced: "0.4",
  normal: "1",
  expressive: "1.6",
};

const TRANSITION_SPEED_SCALE: Record<AppearanceSettings["motion"]["transitionSpeed"], string> = {
  fast: "0.7",
  normal: "1",
  slow: "1.6",
};

function backgroundLayerVars(bg: BackgroundSettings, colors: ThemeColors): Record<string, string> {
  const vars: Record<string, string> = {};

  let image = "none";
  if (bg.type === "gradient" && bg.gradientFrom && bg.gradientTo) {
    image = `linear-gradient(${bg.gradientAngle}deg, ${bg.gradientFrom}, ${bg.gradientTo})`;
  } else if (bg.type === "image" && bg.imageUrl) {
    image = `url("${bg.imageUrl.replace(/"/g, '\\"')}")`;
  }
  vars["--tabdump-bg-image"] = image;
  vars["--tabdump-bg-color"] = bg.type === "solid" && bg.color ? bg.color : colors.background;
  vars["--tabdump-bg-size"] = bg.size === "tile" ? "auto" : bg.size;
  vars["--tabdump-bg-repeat"] = bg.size === "tile" ? "repeat" : "no-repeat";
  vars["--tabdump-bg-position"] = bg.position;
  vars["--tabdump-bg-opacity"] = String(Math.max(0, Math.min(100, bg.opacity)) / 100);
  vars["--tabdump-bg-filter"] =
    `blur(${bg.blur}px) brightness(${bg.brightness}%) contrast(${bg.contrast}%) saturate(${bg.saturation}%)`;

  const overlayColor = bg.overlayColor && isValidColor(bg.overlayColor) ? bg.overlayColor : colors.background;
  vars["--tabdump-overlay-color"] = `rgba(${rgbTriplet(overlayColor)}, ${Math.max(0, Math.min(100, bg.overlayOpacity)) / 100})`;
  vars["--tabdump-overlay-active"] = bg.type === "image" ? "1" : "0";

  return vars;
}

/**
 * The single place appearance settings become CSS custom properties. Every
 * var here is written once (imperatively, from one effect — see
 * use-appearance.ts) directly onto `document.documentElement`; components
 * never receive theme data as props, they just consume the Tailwind classes
 * that already read these vars (bg-background, text-foreground, …) plus the
 * handful of new `--tabdump-*` vars introduced for background/layout/motion.
 */
export function appearanceToCssVars(settings: AppearanceSettings, colors: ThemeColors): Record<string, string> {
  const isDark = isDarkColor(colors.background);
  const edge = isDark ? "#ffffff" : "#000000";
  const successFg = bestForeground(colors.success);
  const warningFg = bestForeground(colors.warning);
  const errorFg = bestForeground(colors.error);
  const infoFg = bestForeground(colors.info);
  const accentFg = bestForeground(colors.accent);
  const selectionFg = bestForeground(colors.selection);

  const border = borderStep(colors.border, colors.background, settings.shape.borderIntensity, edge);
  const borderSubtle = borderStep(colors.borderSubtle, colors.background, settings.shape.borderIntensity, edge);
  const borderStrong = borderStep(colors.borderStrong, colors.background, settings.shape.borderIntensity, edge);
  const shadows = SHADOW_LEVELS[settings.shape.shadowIntensity];

  return {
    // ---- legacy shadcn-style vars (every existing Tailwind class keeps working) ----
    "--background": colors.background,
    "--foreground": colors.text,
    "--card": colors.surface,
    "--card-foreground": colors.text,
    "--popover": colors.surface,
    "--popover-foreground": colors.text,
    "--primary": colors.accent,
    "--primary-foreground": accentFg,
    "--secondary": colors.surfaceActive,
    "--secondary-foreground": colors.text,
    "--muted": colors.backgroundSecondary,
    "--muted-foreground": colors.textSecondary,
    "--accent": colors.surfaceHover,
    "--accent-foreground": colors.text,
    "--destructive": colors.error,
    "--destructive-foreground": errorFg,
    "--border": border,
    "--input": borderStrong,
    "--ring": colors.focus,
    "--text-tertiary": colors.textMuted,
    "--accent-text": mix(colors.accent, isDark ? "#ffffff" : "#000000", isDark ? 0.18 : 0),
    "--success": colors.success,
    "--success-foreground": successFg,
    "--warning": colors.warning,
    "--warning-foreground": warningFg,
    "--danger": colors.error,
    "--danger-foreground": errorFg,
    "--sidebar": colors.backgroundSecondary,
    "--sidebar-foreground": colors.text,
    "--sidebar-primary": colors.accent,
    "--sidebar-primary-foreground": accentFg,
    "--sidebar-accent": colors.surfaceHover,
    "--sidebar-accent-foreground": colors.text,
    "--sidebar-border": borderSubtle,
    "--sidebar-ring": colors.focus,

    // ---- new semantic vars ----
    "--background-secondary": colors.backgroundSecondary,
    "--background-tertiary": colors.backgroundTertiary,
    "--surface": colors.surface,
    "--surface-hover": colors.surfaceHover,
    "--surface-active": colors.surfaceActive,
    "--surface-selected": colors.surfaceSelected,
    "--text-secondary": colors.textSecondary,
    "--text-disabled": colors.textDisabled,
    "--accent-hover": colors.accentHover,
    "--accent-active": colors.accentActive,
    "--accent-subtle": colors.accentSubtle,
    "--border-subtle": borderSubtle,
    "--border-strong": borderStrong,
    "--success-subtle": colors.successSubtle,
    "--warning-subtle": colors.warningSubtle,
    "--error": colors.error,
    "--error-subtle": colors.errorSubtle,
    "--info": colors.info,
    "--info-foreground": infoFg,
    "--info-subtle": colors.infoSubtle,
    "--selection": colors.selection,
    "--selection-foreground": selectionFg,
    "--focus": colors.focus,

    // ---- graph tokens ----
    "--graph-node": colors.graphNode,
    "--graph-node-selected": colors.graphNodeSelected,
    "--graph-edge": colors.graphEdge,
    "--graph-edge-rgb": rgbTriplet(colors.graphEdge),
    "--text-tertiary-rgb": rgbTriplet(colors.textMuted),
    "--warning-rgb": rgbTriplet(colors.warning),
    "--success-rgb": rgbTriplet(colors.success),
    "--info-rgb": rgbTriplet(colors.info),

    // ---- editor/notes tokens ----
    "--editor-background": colors.editorBackground,
    "--editor-text": colors.editorText,
    "--editor-placeholder": colors.editorPlaceholder,

    // ---- typography ----
    "--tabdump-font-ui": fontFamilyValue(settings.typography.uiFont),
    "--tabdump-font-content": fontFamilyValue(settings.typography.contentFont),
    "--tabdump-font-mono": fontFamilyValue(settings.typography.monoFont),
    "--tabdump-font-scale": String(settings.typography.fontSize / 15),
    "--tabdump-font-weight": String(settings.typography.fontWeight),
    "--tabdump-line-height": String(settings.typography.lineHeight),
    "--tabdump-letter-spacing": `${settings.typography.letterSpacing}px`,

    // ---- background layer ----
    ...backgroundLayerVars(settings.background, colors),

    // ---- layout ----
    "--tabdump-content-max-width": CONTENT_WIDTH_LEVELS[settings.layout.contentWidth],
    "--tabdump-density-scale": DENSITY_SCALE[settings.layout.density],
    "--tabdump-sidebar-width": SIDEBAR_WIDTH[settings.layout.sidebarDensity],
    "--tabdump-card-density-scale": CARD_DENSITY_SCALE[settings.layout.cardDensity],

    // ---- shape ----
    "--radius": RADIUS_LEVELS[settings.shape.radius],
    "--shadow-sm": shadows.sm,
    "--shadow-md": shadows.md,
    "--shadow-lg": shadows.lg,

    // ---- motion ----
    "--motion-scale": MOTION_SCALE[settings.motion.level],
    "--tabdump-transition-scale": TRANSITION_SPEED_SCALE[settings.motion.transitionSpeed],
  };
}
