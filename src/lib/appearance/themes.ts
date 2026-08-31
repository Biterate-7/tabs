import { mix } from "./contrast";
import type { ThemeCategory, ThemeColors, ThemeDefinition } from "./types";

/**
 * Compact input to `buildThemeColors` — every original TabDump preset below
 * is authored from ~6-9 core colors; every other semantic slot (hover/
 * active/subtle steps, borders, editor tokens, graph tokens, …) is derived
 * from them so a coherent 30-field ThemeColors doesn't have to be hand-typed
 * per theme. Any derived field can still be overridden per-theme via
 * `overrides` when a palette wants something the formula wouldn't produce.
 */
type ThemeSpec = {
  isDark: boolean;
  bg: string;
  surface: string;
  text: string;
  accent: string;
  success?: string;
  warning?: string;
  error?: string;
  info?: string;
  overrides?: Partial<ThemeColors>;
};

export function buildThemeColors(spec: ThemeSpec): ThemeColors {
  const { isDark, bg, surface, text, accent } = spec;
  const toEdge = isDark ? "#ffffff" : "#000000";
  const success = spec.success ?? (isDark ? "#3ecf6e" : "#1a9850");
  const warning = spec.warning ?? (isDark ? "#e8b339" : "#b6790f");
  const error = spec.error ?? (isDark ? "#f0576a" : "#c8253f");
  const info = spec.info ?? (isDark ? "#4fa6f7" : "#1d6fd1");

  const base: ThemeColors = {
    background: bg,
    backgroundSecondary: mix(bg, toEdge, isDark ? 0.05 : 0.035),
    backgroundTertiary: mix(bg, toEdge, isDark ? 0.09 : 0.065),

    surface,
    surfaceHover: mix(surface, toEdge, isDark ? 0.07 : 0.045),
    surfaceActive: mix(surface, toEdge, isDark ? 0.11 : 0.075),
    surfaceSelected: mix(surface, accent, 0.18),

    text,
    textSecondary: mix(text, bg, 0.28),
    textMuted: mix(text, bg, 0.46),
    textDisabled: mix(text, bg, 0.66),

    accent,
    accentHover: mix(accent, toEdge, 0.12),
    accentActive: mix(accent, "#000000", 0.16),
    accentSubtle: mix(accent, bg, 0.84),

    border: mix(surface, toEdge, isDark ? 0.16 : 0.18),
    borderSubtle: mix(surface, toEdge, isDark ? 0.08 : 0.09),
    borderStrong: mix(surface, toEdge, isDark ? 0.28 : 0.32),

    success,
    successSubtle: mix(success, bg, 0.85),
    warning,
    warningSubtle: mix(warning, bg, 0.85),
    error,
    errorSubtle: mix(error, bg, 0.85),
    info,
    infoSubtle: mix(info, bg, 0.85),

    selection: mix(accent, bg, 0.72),
    focus: accent,

    graphNode: mix(text, bg, 0.35),
    graphNodeSelected: accent,
    graphEdge: accent,

    editorBackground: bg,
    editorText: text,
    editorPlaceholder: mix(text, bg, 0.5),
  };

  return spec.overrides ? { ...base, ...spec.overrides } : base;
}

function theme(
  id: string,
  name: string,
  category: ThemeCategory,
  description: string,
  spec: ThemeSpec
): ThemeDefinition {
  return { id, name, description, category, isDark: spec.isDark, colors: buildThemeColors(spec) };
}

export const THEME_REGISTRY: ThemeDefinition[] = [
  // ---- Dark ---------------------------------------------------------
  theme("midnight", "Midnight", "dark", "TabDump's original dark palette.", {
    isDark: true,
    bg: "#0a0a0b",
    surface: "#131316",
    text: "#f4f4f5",
    accent: "#4361ff",
  }),
  theme("graphite", "Graphite", "dark", "Neutral gray-on-gray, almost no color.", {
    isDark: true,
    bg: "#121214",
    surface: "#1b1b1e",
    text: "#e6e6e9",
    accent: "#9a9aa5",
  }),
  theme("nocturne", "Nocturne", "dark", "Deep violet night with a soft magenta accent.", {
    isDark: true,
    bg: "#12111c",
    surface: "#1d1b2e",
    text: "#eee9fb",
    accent: "#bd93f9",
  }),
  theme("amber-crt", "Amber CRT", "dark", "A phosphor-amber console glow.", {
    isDark: true,
    bg: "#0c0a05",
    surface: "#181207",
    text: "#f5deb0",
    accent: "#ffb545",
  }),
  theme("obsidian", "Obsidian", "dark", "Near-black with a glassy blue edge.", {
    isDark: true,
    bg: "#08090b",
    surface: "#101318",
    text: "#eef2f6",
    accent: "#5fb8ff",
  }),
  theme("deep-blue", "Deep Blue", "dark", "Navy depths with a bright sky accent.", {
    isDark: true,
    bg: "#070f1f",
    surface: "#0f1c33",
    text: "#e7f0ff",
    accent: "#3b9bff",
  }),
  theme("deep-purple", "Deep Purple", "dark", "Royal purple with warm text.", {
    isDark: true,
    bg: "#150c22",
    surface: "#221436",
    text: "#f1e9ff",
    accent: "#a566ff",
  }),
  theme("charcoal", "Charcoal", "dark", "Warm dark gray, understated and calm.", {
    isDark: true,
    bg: "#141312",
    surface: "#1e1c1a",
    text: "#efece7",
    accent: "#d7a35c",
  }),
  theme("cyberpunk", "Cyber", "dark", "High-saturation cyan and magenta on black.", {
    isDark: true,
    bg: "#0a0612",
    surface: "#160f24",
    text: "#e9f9ff",
    accent: "#00e5c7",
    error: "#ff3d81",
  }),
  theme("blackout", "Blackout", "dark", "As dark as a screen gets, minimal accent.", {
    isDark: true,
    bg: "#000000",
    surface: "#0c0c0c",
    text: "#e8e8e8",
    accent: "#6b7280",
  }),

  // ---- Light ----------------------------------------------------------
  theme("paper", "Paper", "light", "Bright white with crisp ink-black text.", {
    isDark: false,
    bg: "#ffffff",
    surface: "#f6f6f7",
    text: "#18181b",
    accent: "#3654ff",
  }),
  theme("snow", "Snow", "light", "Cool white with a blue-gray edge.", {
    isDark: false,
    bg: "#fafbfd",
    surface: "#f0f2f6",
    text: "#1c2230",
    accent: "#2e7dff",
  }),
  theme("cream", "Cream", "light", "Warm off-white, easy on the eyes.", {
    isDark: false,
    bg: "#fbf7ee",
    surface: "#f2ecdc",
    text: "#2b2417",
    accent: "#c07a2c",
  }),
  theme("ivory", "Ivory", "light", "Soft ivory with a muted teal accent.", {
    isDark: false,
    bg: "#fdfaf3",
    surface: "#f3eee0",
    text: "#28251d",
    accent: "#1f9488",
  }),
  theme("minimal-light", "Minimal", "light", "Flat gray-scale, almost no chroma.", {
    isDark: false,
    bg: "#ffffff",
    surface: "#f2f2f2",
    text: "#1f1f1f",
    accent: "#404040",
  }),
  theme("soft-gray", "Soft Gray", "light", "Gentle neutral gray surfaces.", {
    isDark: false,
    bg: "#f6f6f8",
    surface: "#ececf0",
    text: "#232329",
    accent: "#5b63d3",
  }),
  theme("warm-white", "Warm White", "light", "A hint of peach warmth over white.", {
    isDark: false,
    bg: "#fdf9f6",
    surface: "#f5ece5",
    text: "#2a2320",
    accent: "#e0703f",
  }),

  // ---- Colorful ---------------------------------------------------------
  theme("lavender", "Lavender", "colorful", "Soft purple field, dark UI.", {
    isDark: true,
    bg: "#171326",
    surface: "#241d3c",
    text: "#f1ecff",
    accent: "#b19cff",
  }),
  theme("rose", "Rose", "colorful", "Warm rose-pink over deep plum.", {
    isDark: true,
    bg: "#1e0f16",
    surface: "#2f1826",
    text: "#ffe9f1",
    accent: "#ff6f9c",
  }),
  theme("ocean", "Ocean", "colorful", "Deep teal-blue, bright cyan accent.", {
    isDark: true,
    bg: "#061c22",
    surface: "#0d2e37",
    text: "#e2f7fb",
    accent: "#22c3d6",
  }),
  theme("forest", "Forest", "colorful", "Mossy green depths.", {
    isDark: true,
    bg: "#0c1710",
    surface: "#15271b",
    text: "#e7f5ea",
    accent: "#4fce7e",
  }),
  theme("sunset", "Sunset", "colorful", "Warm orange-pink dusk tones.", {
    isDark: true,
    bg: "#1c0f0d",
    surface: "#2c1815",
    text: "#ffefe6",
    accent: "#ff8a4c",
    error: "#ff5470",
  }),
  theme("tangerine", "Tangerine", "colorful", "Bright citrus orange, light UI.", {
    isDark: false,
    bg: "#fff6ee",
    surface: "#ffe7d1",
    text: "#3a2213",
    accent: "#ef6c1f",
  }),
  theme("cherry", "Cherry", "colorful", "Deep red on a light blush ground.", {
    isDark: false,
    bg: "#fff3f4",
    surface: "#ffe1e4",
    text: "#3a1418",
    accent: "#d6294a",
  }),
  theme("blueberry", "Blueberry", "colorful", "Rich indigo-blue, light UI.", {
    isDark: false,
    bg: "#f2f4ff",
    surface: "#dfe3ff",
    text: "#181c3a",
    accent: "#3d4fd6",
  }),
  theme("lilac", "Lilac", "colorful", "Pale purple pastel, light UI.", {
    isDark: false,
    bg: "#f8f4fd",
    surface: "#ebe1f7",
    text: "#2c2338",
    accent: "#9153d6",
  }),
  theme("mint", "Mint", "colorful", "Fresh green on a pale ground.", {
    isDark: false,
    bg: "#f2fbf6",
    surface: "#dcf3e6",
    text: "#0f2c1c",
    accent: "#1fa864",
  }),

  // ---- Aesthetic --------------------------------------------------------
  theme("rosewood", "Rosewood", "aesthetic", "Muted rose and pine, low contrast.", {
    isDark: true,
    bg: "#1c161d",
    surface: "#282130",
    text: "#e6dfe8",
    accent: "#e6a4b4",
    info: "#9ccfd8",
  }),
  theme("fjord", "Fjord", "aesthetic", "Arctic blue-gray, frosted and quiet.", {
    isDark: true,
    bg: "#1c2129",
    surface: "#262c37",
    text: "#e3e8ef",
    accent: "#7fb4e0",
  }),
  theme("solstice", "Solstice", "aesthetic", "Balanced warm neutrals, low-glare.", {
    isDark: true,
    bg: "#032e33",
    surface: "#0a3d43",
    text: "#e8e2c8",
    accent: "#2fa7c4",
    warning: "#d99c2e",
  }),
  theme("pastel-dream", "Pastel Dream", "aesthetic", "Soft pastels on cream, light UI.", {
    isDark: false,
    bg: "#fdf6fb",
    surface: "#f6e6f2",
    text: "#33283a",
    accent: "#e08fd0",
  }),
  theme("vaporwave", "Vaporwave", "aesthetic", "Neon pink and cyan on deep violet.", {
    isDark: true,
    bg: "#150e2e",
    surface: "#231645",
    text: "#f4ecff",
    accent: "#ff6fd8",
    info: "#5ff0ff",
  }),
  theme("retrowave", "Retrowave", "aesthetic", "80s sunset gradient energy, dark UI.", {
    isDark: true,
    bg: "#1a0a2e",
    surface: "#2a123f",
    text: "#ffe9fb",
    accent: "#ff4fa3",
    warning: "#ffbb3d",
  }),
  theme("soft-focus", "Soft", "aesthetic", "Gentle low-contrast neutrals.", {
    isDark: false,
    bg: "#f7f5f2",
    surface: "#ece8e2",
    text: "#3a3733",
    accent: "#8a8577",
  }),
  theme("sakura", "Sakura", "aesthetic", "Cherry-blossom pink over soft white.", {
    isDark: false,
    bg: "#fff5f7",
    surface: "#ffe3ea",
    text: "#3c1f28",
    accent: "#ec6f95",
  }),
  theme("autumn", "Autumn", "aesthetic", "Rust, amber and deep brown.", {
    isDark: true,
    bg: "#1b1209",
    surface: "#2b1c0f",
    text: "#f6e9d8",
    accent: "#d97a3d",
    warning: "#e0a63c",
  }),
  theme("winter", "Winter", "aesthetic", "Icy blue-white, crisp and clean.", {
    isDark: false,
    bg: "#f4f8fc",
    surface: "#e1ecf6",
    text: "#182533",
    accent: "#3f7fc1",
  }),

  // ---- Developer ----------------------------------------------------
  theme("editor-dark", "Editor Dark", "developer", "A familiar dark code-editor look.", {
    isDark: true,
    bg: "#1e1e1e",
    surface: "#252526",
    text: "#d4d4d4",
    accent: "#569cd6",
    success: "#4ec9b0",
    warning: "#dcdcaa",
    error: "#f14c4c",
  }),
  theme("hub-dark", "Hub Dark", "developer", "Dark, code-forge inspired.", {
    isDark: true,
    bg: "#0d1117",
    surface: "#161b22",
    text: "#e6edf3",
    accent: "#4f8cff",
    success: "#3fb950",
    error: "#f85149",
  }),
  theme("hub-light", "Hub Light", "developer", "Light, code-forge inspired.", {
    isDark: false,
    bg: "#ffffff",
    surface: "#f6f8fa",
    text: "#1f2328",
    accent: "#0969da",
    success: "#1a7f37",
    error: "#cf222e",
  }),
  theme("green-console", "Green Console", "developer", "Monochrome green phosphor terminal.", {
    isDark: true,
    bg: "#020a04",
    surface: "#08170c",
    text: "#5dfa8d",
    accent: "#3dff7a",
    success: "#3dff7a",
    overrides: { graphEdge: "#2fce62" },
  }),
  theme("monochrome", "Monochrome", "developer", "Pure grayscale, zero hue.", {
    isDark: true,
    bg: "#141414",
    surface: "#1f1f1f",
    text: "#e8e8e8",
    accent: "#cfcfcf",
    success: "#bdbdbd",
    warning: "#9a9a9a",
    error: "#f2f2f2",
    info: "#9a9a9a",
  }),
  theme("high-contrast", "High Contrast", "developer", "Maximum legibility, pure black and white.", {
    isDark: true,
    bg: "#000000",
    surface: "#000000",
    text: "#ffffff",
    accent: "#ffff00",
    success: "#00ff66",
    warning: "#ffcc00",
    error: "#ff3b3b",
    info: "#4dd2ff",
    overrides: { border: "#ffffff", borderStrong: "#ffffff", borderSubtle: "#8a8a8a" },
  }),
];

/**
 * The custom-theme editor only exposes the 28 colors listed in the
 * appearance spec's "custom theme editor" phase — the handful of derived
 * "-subtle" steps (textDisabled, accentSubtle, successSubtle, …) are
 * recomputed from their base color instead of being editable fields, using
 * the same mix() formulas every preset is built from. Call this after any
 * edit to one of the 28 base fields so the derived set stays in sync.
 */
export function deriveSubtleFields(colors: ThemeColors): ThemeColors {
  return {
    ...colors,
    textDisabled: mix(colors.text, colors.background, 0.66),
    accentSubtle: mix(colors.accent, colors.background, 0.84),
    successSubtle: mix(colors.success, colors.background, 0.85),
    warningSubtle: mix(colors.warning, colors.background, 0.85),
    errorSubtle: mix(colors.error, colors.background, 0.85),
    infoSubtle: mix(colors.info, colors.background, 0.85),
  };
}

const THEME_BY_ID = new Map(THEME_REGISTRY.map((t) => [t.id, t]));

export function getTheme(id: string): ThemeDefinition | undefined {
  return THEME_BY_ID.get(id);
}

export const DEFAULT_THEME_ID = "midnight";

export const THEME_CATEGORY_LABELS: Record<ThemeCategory, string> = {
  dark: "Dark",
  light: "Light",
  colorful: "Colorful",
  aesthetic: "Aesthetic",
  developer: "Developer",
};
