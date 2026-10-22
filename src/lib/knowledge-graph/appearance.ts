/**
 * How the person has chosen the Graph to look: its colours and the strength
 * of its effects.
 *
 * One typed object, so the painter (components/knowledge-graph/renderer.ts)
 * reads every choice from one place and no component carries a colour of
 * its own. A colour left `null` is Hubble's own light — the `--graph-*`
 * tokens, exactly as drawn without customisation; a colour set here replaces
 * one role of that light wherever the role appears.
 *
 * A device preference, like the app's theme: stored globally, never under an
 * account's namespace (see lib/storage/namespace.ts).
 */

export const GRAPH_COLOR_ROLES = ["accent", "connections", "nodes", "glow", "background"] as const;
export type GraphColorRole = (typeof GRAPH_COLOR_ROLES)[number];
export type GraphColors = Record<GraphColorRole, string | null>;

export type NodeSize = "small" | "default" | "large";

export type GraphAppearance = {
  /** `#RRGGBB`, upper case, or null for Hubble's own. */
  colors: GraphColors;
  /** 0 (subtle) … 1 (vivid); 0.5 is Hubble's own. */
  glow: number;
  /** 0 (none) … 1 (dense); 0.5 is Hubble's own. */
  stars: number;
  /** 0 (faint) … 1 (strong); 0.5 is Hubble's own. */
  connections: number;
  nodeSize: NodeSize;
  labels: boolean;
  /** Ambient motion: drifting light, breathing, sway, the opening. */
  animation: boolean;
  /** The starfield and the nebula haze behind the galaxy. */
  effects: boolean;
};

export const DEFAULT_GRAPH_COLORS: GraphColors = { accent: null, connections: null, nodes: null, glow: null, background: null };

export const DEFAULT_GRAPH_APPEARANCE: GraphAppearance = {
  colors: DEFAULT_GRAPH_COLORS,
  glow: 0.5,
  stars: 0.5,
  connections: 0.5,
  nodeSize: "default",
  labels: true,
  animation: true,
  effects: true,
};

export type GraphPreset = { id: string; name: string; colors: GraphColors };

/** Palettes that set the colours together. Hubble's own is every colour left to the tokens. */
export const GRAPH_PRESETS: readonly GraphPreset[] = [
  { id: "hubble", name: "Hubble", colors: DEFAULT_GRAPH_COLORS },
  { id: "nebula", name: "Nebula", colors: { accent: "#C4A1FF", connections: "#8B5CF6", nodes: "#EDE7FF", glow: "#7C3AED", background: "#07050D" } },
  { id: "cosmic", name: "Cosmic", colors: { accent: "#8FD3FF", connections: "#3B82F6", nodes: "#E6F1FF", glow: "#2563EB", background: "#03060C" } },
  { id: "aurora", name: "Aurora", colors: { accent: "#7CF5C8", connections: "#1FB892", nodes: "#E4FFF6", glow: "#0D9488", background: "#030A09" } },
  { id: "solar", name: "Solar", colors: { accent: "#FFC56B", connections: "#F59E0B", nodes: "#FFF3E0", glow: "#C2410C", background: "#0B0703" } },
];

/** The preset whose colours these are exactly, if any. */
export function activePreset(colors: GraphColors): GraphPreset | undefined {
  return GRAPH_PRESETS.find((preset) => GRAPH_COLOR_ROLES.every((role) => preset.colors[role] === colors[role]));
}

/**
 * A colour as typed: `#8B5CF6`, `8b5cf6`, `#0ef` → `#00EEFF`. Anything else
 * (a name, a partial value, an alpha channel) is not a colour here: null.
 */
export function parseHex(input: string): string | null {
  const text = input.trim().replace(/^#/, "");
  if (/^[0-9a-f]{3}$/i.test(text)) return `#${text.replace(/./g, (c) => c + c).toUpperCase()}`;
  if (/^[0-9a-f]{6}$/i.test(text)) return `#${text.toUpperCase()}`;
  return null;
}

export type Rgb = readonly [number, number, number];

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace(/^#/, "");
  return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
}

export function rgbToHex([r, g, b]: Rgb): string {
  const part = (v: number) => Math.round(Math.min(255, Math.max(0, v))).toString(16).padStart(2, "0");
  return `#${part(r)}${part(g)}${part(b)}`.toUpperCase();
}

/** WCAG relative luminance, 0 (black) … 1 (white). */
export function luminance([r, g, b]: Rgb): number {
  const channel = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : Math.pow((c + 0.055) / 1.055, 2.4);
  };
  return 0.2126 * channel(r) + 0.7152 * channel(g) + 0.0722 * channel(b);
}

/** WCAG contrast ratio, 1 … 21. */
export function contrast(a: Rgb, b: Rgb): number {
  const la = luminance(a);
  const lb = luminance(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/**
 * The lightest a custom background may be. The galaxy is light on a dark
 * ground — its glows add, its labels are light — so a background past this
 * is taken down to it, keeping its hue. About #2E2E2E in grey.
 */
const MAX_BACKGROUND_LUMINANCE = 0.028;

/** A custom background as drawn: the colour itself when dark enough, else the same hue darkened until it is. */
export function darkBackground(hex: string): { rgb: [number, number, number]; adjusted: boolean } {
  const rgb = hexToRgb(hex);
  if (luminance(rgb) <= MAX_BACKGROUND_LUMINANCE) return { rgb, adjusted: false };
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 18; i++) {
    const mid = (lo + hi) / 2;
    if (luminance([rgb[0] * mid, rgb[1] * mid, rgb[2] * mid]) > MAX_BACKGROUND_LUMINANCE) hi = mid;
    else lo = mid;
  }
  return { rgb: [Math.floor(rgb[0] * lo), Math.floor(rgb[1] * lo), Math.floor(rgb[2] * lo)], adjusted: true };
}

/** The effects as the painter applies them: multipliers on what Hubble draws by default (1 = unchanged). */
export type GraphEffects = {
  glow: number;
  stars: number;
  connections: number;
  nodeScale: number;
  labels: boolean;
  /** The starfield and the nebula haze. */
  space: boolean;
};

const NODE_SCALE: Record<NodeSize, number> = { small: 0.75, default: 1, large: 1.35 };

/** A 0…1 slider with Hubble's own at its middle, as a multiplier from `min` through 1 to `max`. */
function around(value: number, min: number, max: number): number {
  return value <= 0.5 ? min + (1 - min) * (value / 0.5) : 1 + (max - 1) * ((value - 0.5) / 0.5);
}

export function graphEffects(appearance: GraphAppearance): GraphEffects {
  return {
    glow: around(appearance.glow, 0.12, 2.2),
    stars: around(appearance.stars, 0, 2),
    connections: around(appearance.connections, 0.15, 2),
    nodeScale: NODE_SCALE[appearance.nodeSize],
    labels: appearance.labels,
    space: appearance.effects,
  };
}

export const DEFAULT_GRAPH_EFFECTS: GraphEffects = graphEffects(DEFAULT_GRAPH_APPEARANCE);

// ---------------------------------------------------------------- storage

export const GRAPH_APPEARANCE_KEY = "tabdump:graph-appearance:v1";

function unit(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(1, Math.max(0, value)) : fallback;
}

function flag(value: unknown, fallback: boolean): boolean {
  return typeof value === "boolean" ? value : fallback;
}

/** Whatever was stored, as a valid appearance: unknown fields dropped, bad values back to Hubble's own. */
export function sanitizeGraphAppearance(raw: unknown): GraphAppearance {
  if (!raw || typeof raw !== "object") return DEFAULT_GRAPH_APPEARANCE;
  const r = raw as Record<string, unknown>;
  const stored = r.colors && typeof r.colors === "object" ? (r.colors as Record<string, unknown>) : {};
  const colors = { ...DEFAULT_GRAPH_COLORS };
  for (const role of GRAPH_COLOR_ROLES) {
    const value = stored[role];
    colors[role] = typeof value === "string" ? parseHex(value) : null;
  }
  const d = DEFAULT_GRAPH_APPEARANCE;
  return {
    colors,
    glow: unit(r.glow, d.glow),
    stars: unit(r.stars, d.stars),
    connections: unit(r.connections, d.connections),
    nodeSize: r.nodeSize === "small" || r.nodeSize === "large" || r.nodeSize === "default" ? r.nodeSize : d.nodeSize,
    labels: flag(r.labels, d.labels),
    animation: flag(r.animation, d.animation),
    effects: flag(r.effects, d.effects),
  };
}

export function isDefaultGraphAppearance(appearance: GraphAppearance): boolean {
  const d = DEFAULT_GRAPH_APPEARANCE;
  return (
    GRAPH_COLOR_ROLES.every((role) => appearance.colors[role] === null) &&
    appearance.glow === d.glow &&
    appearance.stars === d.stars &&
    appearance.connections === d.connections &&
    appearance.nodeSize === d.nodeSize &&
    appearance.labels === d.labels &&
    appearance.animation === d.animation &&
    appearance.effects === d.effects
  );
}

export function loadGraphAppearance(): GraphAppearance {
  try {
    const raw = window.localStorage.getItem(GRAPH_APPEARANCE_KEY);
    return raw ? sanitizeGraphAppearance(JSON.parse(raw)) : DEFAULT_GRAPH_APPEARANCE;
  } catch {
    return DEFAULT_GRAPH_APPEARANCE;
  }
}

/** Hubble's own appearance is stored as nothing at all. */
export function saveGraphAppearance(appearance: GraphAppearance): void {
  try {
    if (isDefaultGraphAppearance(appearance)) window.localStorage.removeItem(GRAPH_APPEARANCE_KEY);
    else window.localStorage.setItem(GRAPH_APPEARANCE_KEY, JSON.stringify({ version: 1, ...appearance }));
  } catch {
    // A preference: at worst it is not remembered this time.
  }
}
