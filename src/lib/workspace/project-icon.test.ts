import { describe, expect, it } from "vitest";
import { DEFAULT_PROJECT_ICON, resolveProjectIcon } from "./project-icon";

describe("resolveProjectIcon", () => {
  it("chooses a glyph from the subject in the title", () => {
    expect(resolveProjectIcon("AP Calculus").glyph).toBe("math");
    expect(resolveProjectIcon("World History 101").glyph).toBe("history");
    expect(resolveProjectIcon("Hubble web app").glyph).toBe("code");
    expect(resolveProjectIcon("Thesis research").glyph).toBe("research");
    expect(resolveProjectIcon("Organic Chemistry").glyph).toBe("science");
  });

  it("is deterministic and never throws on odd input", () => {
    expect(resolveProjectIcon("Fall term")).toEqual(resolveProjectIcon("Fall term"));
    expect(() => resolveProjectIcon(undefined as unknown as string)).not.toThrow();
    expect(resolveProjectIcon("")).toEqual(DEFAULT_PROJECT_ICON);
    expect(resolveProjectIcon("   ")).toEqual(DEFAULT_PROJECT_ICON);
  });

  it("falls back to the brief when the title names no subject, and to a plain folder otherwise", () => {
    expect(resolveProjectIcon("Fall term", "Calculus and linear algebra").glyph).toBe("math");
    expect(resolveProjectIcon("Zzyzx").glyph).toBe("folder");
  });

  it("lets the title beat the brief", () => {
    expect(resolveProjectIcon("History", "calculus").glyph).toBe("history");
  });
});
