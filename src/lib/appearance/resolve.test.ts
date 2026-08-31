import { describe, expect, it } from "vitest";
import { appearanceToCssVars, resolveThemeColors } from "./resolve";
import { DEFAULT_APPEARANCE_SETTINGS } from "./defaults";
import { getTheme } from "./themes";
import type { AppearanceSettings } from "./types";

describe("resolveThemeColors", () => {
  it("resolves the active preset theme's colors when there's no custom theme", () => {
    const colors = resolveThemeColors(DEFAULT_APPEARANCE_SETTINGS);
    expect(colors).toEqual(getTheme(DEFAULT_APPEARANCE_SETTINGS.themeId)!.colors);
  });

  it("prefers the custom theme over the preset when both are present", () => {
    const midnight = getTheme("midnight")!.colors;
    const custom = { ...midnight, background: "#123456" };
    const settings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS, customTheme: custom };
    expect(resolveThemeColors(settings).background).toBe("#123456");
  });

  it("applies an accent override on top of the base theme without touching unrelated colors", () => {
    const settings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS, accentOverride: "#ff00aa" };
    const base = getTheme(settings.themeId)!.colors;
    const resolved = resolveThemeColors(settings);
    expect(resolved.accent).toBe("#ff00aa");
    expect(resolved.focus).toBe("#ff00aa");
    expect(resolved.background).toBe(base.background);
    expect(resolved.text).toBe(base.text);
  });

  it("ignores an invalid accent override rather than corrupting the theme", () => {
    const settings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS, accentOverride: "not-a-color" };
    const base = getTheme(settings.themeId)!.colors;
    expect(resolveThemeColors(settings).accent).toBe(base.accent);
  });

  it("falls back to midnight for an unknown theme id", () => {
    const settings: AppearanceSettings = { ...DEFAULT_APPEARANCE_SETTINGS, themeId: "does-not-exist" };
    expect(resolveThemeColors(settings)).toEqual(getTheme("midnight")!.colors);
  });
});

describe("appearanceToCssVars", () => {
  const colors = resolveThemeColors(DEFAULT_APPEARANCE_SETTINGS);
  const vars = appearanceToCssVars(DEFAULT_APPEARANCE_SETTINGS, colors);

  it("maps theme colors onto the legacy shadcn-style var names every component already consumes", () => {
    expect(vars["--background"]).toBe(colors.background);
    expect(vars["--foreground"]).toBe(colors.text);
    expect(vars["--card"]).toBe(colors.surface);
    expect(vars["--primary"]).toBe(colors.accent);
    expect(vars["--destructive"]).toBe(colors.error);
  });

  it("produces the new semantic vars the appearance system introduces", () => {
    expect(vars["--surface-selected"]).toBe(colors.surfaceSelected);
    expect(vars["--graph-node"]).toBe(colors.graphNode);
    expect(vars["--editor-background"]).toBe(colors.editorBackground);
  });

  it("turns radius/border/shadow/motion settings into real CSS values", () => {
    expect(vars["--radius"]).toBe("0.625rem");
    expect(vars["--motion-scale"]).toBe("1");
  });

  it("resolves 'none' shadow intensity to literal 'none' box-shadows", () => {
    const none = appearanceToCssVars({ ...DEFAULT_APPEARANCE_SETTINGS, shape: { ...DEFAULT_APPEARANCE_SETTINGS.shape, shadowIntensity: "none" } }, colors);
    expect(none["--shadow-sm"]).toBe("none");
    expect(none["--shadow-md"]).toBe("none");
    expect(none["--shadow-lg"]).toBe("none");
  });

  it("collapses borders to the background color when border intensity is 'none'", () => {
    const none = appearanceToCssVars({ ...DEFAULT_APPEARANCE_SETTINGS, shape: { ...DEFAULT_APPEARANCE_SETTINGS.shape, borderIntensity: "none" } }, colors);
    expect(none["--border"]).toBe(colors.background);
  });

  it("maps content width presets, including 'full' to an unconstrained value", () => {
    const full = appearanceToCssVars({ ...DEFAULT_APPEARANCE_SETTINGS, layout: { ...DEFAULT_APPEARANCE_SETTINGS.layout, contentWidth: "full" } }, colors);
    expect(full["--tabdump-content-max-width"]).toBe("none");
  });

  it("produces no background image for the default solid background", () => {
    expect(vars["--tabdump-bg-image"]).toBe("none");
  });

  it("builds a gradient background image from the two gradient stops", () => {
    const gradient = appearanceToCssVars(
      {
        ...DEFAULT_APPEARANCE_SETTINGS,
        background: { ...DEFAULT_APPEARANCE_SETTINGS.background, type: "gradient", gradientFrom: "#111111", gradientTo: "#222222", gradientAngle: 45 },
      },
      colors
    );
    expect(gradient["--tabdump-bg-image"]).toBe("linear-gradient(45deg, #111111, #222222)");
  });
});
