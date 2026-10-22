import { afterEach, describe, expect, it } from "vitest";
import {
  activePreset,
  contrast,
  darkBackground,
  DEFAULT_GRAPH_APPEARANCE,
  DEFAULT_GRAPH_COLORS,
  GRAPH_APPEARANCE_KEY,
  GRAPH_PRESETS,
  graphEffects,
  loadGraphAppearance,
  luminance,
  parseHex,
  sanitizeGraphAppearance,
  saveGraphAppearance,
} from "./appearance";

afterEach(() => window.localStorage.clear());

describe("parseHex", () => {
  it("accepts six- and three-digit HEX, with or without #, in any case", () => {
    expect(parseHex("#8B5CF6")).toBe("#8B5CF6");
    expect(parseHex("00e5ff")).toBe("#00E5FF");
    expect(parseHex(" #ff6b9d ")).toBe("#FF6B9D");
    expect(parseHex("#fff")).toBe("#FFFFFF");
    expect(parseHex("0ef")).toBe("#00EEFF");
  });

  it("refuses anything that is not a colour", () => {
    for (const input of ["", "#", "#12", "#12345", "#1234567", "#GGGGGG", "red", "rgb(1,2,3)", "#8B5CF680", "##8B5CF6"]) expect(parseHex(input)).toBeNull();
  });
});

describe("sanitizeGraphAppearance", () => {
  it("gives Hubble's own for nothing or garbage", () => {
    expect(sanitizeGraphAppearance(undefined)).toEqual(DEFAULT_GRAPH_APPEARANCE);
    expect(sanitizeGraphAppearance("nope")).toEqual(DEFAULT_GRAPH_APPEARANCE);
    expect(sanitizeGraphAppearance({ colors: 4, glow: "x", nodeSize: "huge", labels: "yes" })).toEqual(DEFAULT_GRAPH_APPEARANCE);
  });

  it("keeps valid choices, normalises colours and drops invalid ones", () => {
    const value = sanitizeGraphAppearance({ colors: { accent: "8b5cf6", connections: "#zzz", glow: 12, background: "#07050d" }, glow: 2, stars: -1, connections: 0.8, nodeSize: "large", labels: false, animation: false, effects: false });
    expect(value.colors).toEqual({ accent: "#8B5CF6", connections: null, nodes: null, glow: null, background: "#07050D" });
    expect(value).toMatchObject({ glow: 1, stars: 0, connections: 0.8, nodeSize: "large", labels: false, animation: false, effects: false });
  });
});

describe("persistence", () => {
  it("survives a reload, and stores Hubble's own as nothing", () => {
    const custom = { ...DEFAULT_GRAPH_APPEARANCE, colors: { ...DEFAULT_GRAPH_COLORS, accent: "#00E5FF" }, glow: 0.8, labels: false };
    saveGraphAppearance(custom);
    expect(loadGraphAppearance()).toEqual(custom);
    saveGraphAppearance(DEFAULT_GRAPH_APPEARANCE);
    expect(window.localStorage.getItem(GRAPH_APPEARANCE_KEY)).toBeNull();
    expect(loadGraphAppearance()).toEqual(DEFAULT_GRAPH_APPEARANCE);
  });

  it("reads a corrupt entry as Hubble's own", () => {
    window.localStorage.setItem(GRAPH_APPEARANCE_KEY, "{not json");
    expect(loadGraphAppearance()).toEqual(DEFAULT_GRAPH_APPEARANCE);
  });
});

describe("presets", () => {
  it("are recognised by their colours, Hubble's being every colour left alone", () => {
    expect(activePreset(DEFAULT_GRAPH_COLORS)?.id).toBe("hubble");
    for (const preset of GRAPH_PRESETS) expect(activePreset(preset.colors)?.id).toBe(preset.id);
    expect(activePreset({ ...GRAPH_PRESETS[1]!.colors, accent: "#FFFFFF" })).toBeUndefined();
  });

  it("set every colour, each a valid HEX, on a dark ground", () => {
    for (const preset of GRAPH_PRESETS.slice(1)) {
      for (const value of Object.values(preset.colors)) expect(parseHex(value!)).toBe(value);
      expect(darkBackground(preset.colors.background!).adjusted).toBe(false);
    }
  });
});

describe("darkBackground", () => {
  it("keeps a dark colour as it is", () => {
    expect(darkBackground("#07050D")).toEqual({ rgb: [7, 5, 13], adjusted: false });
  });

  it("takes a light one down to a dark tone of the same hue, where light labels still read", () => {
    for (const hex of ["#FFFFFF", "#8B5CF6", "#00E5FF"]) {
      const { rgb, adjusted } = darkBackground(hex);
      expect(adjusted).toBe(true);
      expect(luminance(rgb)).toBeLessThanOrEqual(0.028);
      expect(contrast(rgb, [232, 234, 239])).toBeGreaterThan(9);
    }
    const { rgb } = darkBackground("#00E5FF");
    expect(rgb[0]).toBe(0);
    expect(rgb[2]).toBeGreaterThan(rgb[0]);
  });
});

describe("graphEffects", () => {
  it("is the identity at Hubble's own settings", () => {
    expect(graphEffects(DEFAULT_GRAPH_APPEARANCE)).toEqual({ glow: 1, stars: 1, connections: 1, nodeScale: 1, labels: true, space: true });
  });

  it("runs from subtle to vivid, never to nothing for connections", () => {
    const low = graphEffects({ ...DEFAULT_GRAPH_APPEARANCE, glow: 0, stars: 0, connections: 0, nodeSize: "small" });
    const high = graphEffects({ ...DEFAULT_GRAPH_APPEARANCE, glow: 1, stars: 1, connections: 1, nodeSize: "large" });
    expect(low.stars).toBe(0);
    expect(low.connections).toBeGreaterThan(0);
    expect(low.glow).toBeLessThan(1);
    expect(high.glow).toBeGreaterThan(1);
    expect(low.nodeScale).toBeLessThan(1);
    expect(high.nodeScale).toBeGreaterThan(1);
  });
});
