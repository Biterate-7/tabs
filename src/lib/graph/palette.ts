import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { EdgeReason } from "./types";

export type GraphPalette = {
  nodeDefault: string;
  nodeStroke: string;
  nodeSelectedRing: string;
  nodeCenterRing: string;
  textPrimary: string;
  textDim: string;
  edge: Record<EdgeReason, string>;
  edgeHighlighted: string;
  edgeDim: string;
  /** Distinct from `edge.manual` so a directional dependency reads as its own relationship type at a glance, without adding a loud new hue. */
  edgeDependency: string;
  edgeDependencyHighlighted: string;
  /** Collection boundary region — quiet by default, brighter when the collection is selected. Opacity is controlled via globalAlpha at draw time, same convention as every other palette color here. */
  collectionBoundary: string;
  collectionBoundarySelected: string;
  collectionLabel: string;
  category: Record<CategoryId, string>;
  /** Canvas `ctx.font` can't resolve CSS variables, so the app's actual resolved font stack is captured once via `getComputedStyle`. */
  fontFamily: string;
};

const FALLBACK: Record<string, string> = {
  "--muted-foreground": "#a1a1aa",
  "--text-tertiary": "#87878f",
  "--foreground": "#f4f4f5",
  "--primary": "#4361ff",
  "--accent-text": "#8a9dff",
  "--border": "rgba(255,255,255,0.08)",
  "--graph-node": "#a1a1aa",
  "--graph-node-selected": "#4361ff",
  "--graph-edge": "#8a9dff",
  "--graph-edge-rgb": "138, 157, 255",
};

/**
 * Reads graph colors from TabDump's CSS custom properties once (not per
 * frame — `getComputedStyle` is comparatively expensive) so the canvas
 * renderer stays in sync with the app's design tokens without hardcoding a
 * parallel color palette.
 */
export function resolveGraphPalette(root: HTMLElement = document.documentElement): GraphPalette {
  const style = getComputedStyle(root);
  const v = (name: string) => style.getPropertyValue(name).trim() || FALLBACK[name] || "#888888";

  const category = {} as Record<CategoryId, string>;
  for (const id of CATEGORY_ORDER) category[id] = v(CATEGORIES[id].accentColor);

  // The graph's edge palette is built from one theme-driven `--graph-edge`
  // color (an rgb triplet, so it can carry the alpha each relationship type
  // needs) rather than per-reason hardcoded colors — every theme gets a
  // coherent, on-brand graph without having to hand-author 8 edge colors.
  const edgeRgb = v("--graph-edge-rgb") || "138, 157, 255";

  return {
    nodeDefault: v("--graph-node"),
    nodeStroke: v("--border"),
    nodeSelectedRing: v("--graph-node-selected"),
    nodeCenterRing: v("--accent-text"),
    textPrimary: v("--foreground"),
    textDim: v("--text-tertiary"),
    edge: {
      domain: `rgba(${edgeRgb}, 0.35)`,
      workspace: `rgba(${v("--text-tertiary-rgb") || "161, 161, 170"}, 0.35)`,
      category: `rgba(${v("--warning-rgb") || "245, 166, 35"}, 0.3)`,
      group: `rgba(${v("--success-rgb") || "34, 197, 94"}, 0.3)`,
      manual: `rgba(${edgeRgb}, 0.55)`,
    },
    edgeHighlighted: v("--accent-text"),
    edgeDim: "rgba(255, 255, 255, 0.04)",
    edgeDependency: `rgba(${v("--info-rgb") || "45, 212, 191"}, 0.55)`,
    edgeDependencyHighlighted: `rgba(${v("--info-rgb") || "45, 212, 191"}, 0.9)`,
    collectionBoundary: v("--border"),
    collectionBoundarySelected: v("--graph-node-selected"),
    collectionLabel: v("--text-tertiary"),
    category,
    fontFamily: getComputedStyle(document.body).fontFamily || "ui-sans-serif, system-ui, sans-serif",
  };
}

/** Picks one representative color when an edge matches several relationship types, prioritizing the most intentional/specific signal. */
const REASON_PRIORITY: EdgeReason[] = ["manual", "group", "workspace", "domain", "category"];

export function primaryEdgeReason(reasons: EdgeReason[]): EdgeReason {
  for (const reason of REASON_PRIORITY) {
    if (reasons.includes(reason)) return reason;
  }
  return reasons[0] ?? "domain";
}
