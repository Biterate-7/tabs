import { describe, expect, it } from "vitest";
import { parseThemeImport, serializeCustomTheme } from "./export-import";
import { getTheme } from "./themes";

const colors = getTheme("midnight")!.colors;

describe("serializeCustomTheme / parseThemeImport", () => {
  it("round-trips a theme through export then import", () => {
    const json = serializeCustomTheme("My theme", colors);
    const result = parseThemeImport(json);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.name).toBe("My theme");
      expect(result.colors).toEqual(colors);
    }
  });

  it("rejects malformed JSON without throwing", () => {
    const result = parseThemeImport("not json");
    expect(result).toEqual({ ok: false, reason: "That file isn't valid JSON." });
  });

  it("rejects JSON that isn't a theme export", () => {
    const result = parseThemeImport(JSON.stringify({ hello: "world" }));
    expect(result.ok).toBe(false);
  });

  it("rejects a theme missing required color fields", () => {
    const result = parseThemeImport(JSON.stringify({ name: "Broken", colors: { background: "#000000" } }));
    expect(result.ok).toBe(false);
  });

  it("rejects a theme with an invalid color value", () => {
    const broken = { ...colors, background: "not-a-color" };
    const result = parseThemeImport(JSON.stringify({ name: "Broken", colors: broken }));
    expect(result.ok).toBe(false);
  });

  it("falls back to a default name when none is provided", () => {
    const result = parseThemeImport(JSON.stringify({ colors }));
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.name).toBe("Imported theme");
  });
});
