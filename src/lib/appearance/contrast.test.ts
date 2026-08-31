import { describe, expect, it } from "vitest";
import {
  bestForeground,
  contrastLevel,
  contrastRatio,
  getContrastWarning,
  isDarkColor,
  isValidColor,
  mix,
  normalizeHex,
  rgbTriplet,
} from "./contrast";

describe("isValidColor", () => {
  it.each(["#fff", "#ffffff", "#ffffffaa", "fff", "abc123"])("accepts %s", (hex) => {
    expect(isValidColor(hex)).toBe(true);
  });

  it.each(["", "#ff", "#gggggg", "not-a-color", "#12345"])("rejects %s", (hex) => {
    expect(isValidColor(hex)).toBe(false);
  });
});

describe("normalizeHex", () => {
  it("expands 3-digit shorthand", () => {
    expect(normalizeHex("#abc")).toBe("aabbcc");
  });

  it("passes through 6-digit hex", () => {
    expect(normalizeHex("#123456")).toBe("123456");
  });

  it("drops alpha from 8-digit hex", () => {
    expect(normalizeHex("#123456ff")).toBe("123456");
  });
});

describe("contrastRatio", () => {
  it("is 21 for black on white", () => {
    expect(contrastRatio("#000000", "#ffffff")).toBeCloseTo(21, 0);
  });

  it("is 1 for identical colors", () => {
    expect(contrastRatio("#4361ff", "#4361ff")).toBeCloseTo(1, 5);
  });

  it("is symmetric", () => {
    expect(contrastRatio("#111111", "#eeeeee")).toBeCloseTo(contrastRatio("#eeeeee", "#111111")!, 5);
  });

  it("returns null for unparseable input", () => {
    expect(contrastRatio("not-a-color", "#ffffff")).toBeNull();
  });
});

describe("contrastLevel", () => {
  it("classifies black-on-white as aaa", () => {
    expect(contrastLevel(contrastRatio("#000000", "#ffffff"))).toBe("aaa");
  });

  it("classifies near-identical colors as fail", () => {
    expect(contrastLevel(contrastRatio("#808080", "#828282"))).toBe("fail");
  });

  it("treats null as fail", () => {
    expect(contrastLevel(null)).toBe("fail");
  });
});

describe("getContrastWarning", () => {
  it("warns nothing for a high-contrast pair", () => {
    expect(getContrastWarning("#000000", "#ffffff")).toBeNull();
  });

  it("warns for a low-contrast pair", () => {
    expect(getContrastWarning("#888888", "#999999")).not.toBeNull();
  });
});

describe("bestForeground", () => {
  it("picks a light foreground for a dark fill", () => {
    expect(bestForeground("#111111")).toBe("#ffffff");
  });

  it("picks a dark foreground for a light fill", () => {
    expect(bestForeground("#f5f5f5")).toBe("#181818");
  });
});

describe("mix", () => {
  it("returns the original color at amount 0", () => {
    expect(mix("#112233", "#ffffff", 0)).toBe("#112233");
  });

  it("returns the target color at amount 1", () => {
    expect(mix("#112233", "#ffffff", 1)).toBe("#ffffff");
  });

  it("clamps out-of-range amounts", () => {
    expect(mix("#112233", "#ffffff", -1)).toBe("#112233");
    expect(mix("#112233", "#ffffff", 2)).toBe("#ffffff");
  });
});

describe("rgbTriplet", () => {
  it("formats a hex color as r, g, b", () => {
    expect(rgbTriplet("#ff0080")).toBe("255, 0, 128");
  });

  it("falls back to a neutral gray for invalid input", () => {
    expect(rgbTriplet("nope")).toBe("128, 128, 128");
  });
});

describe("isDarkColor", () => {
  it("treats black as dark", () => {
    expect(isDarkColor("#000000")).toBe(true);
  });

  it("treats white as light", () => {
    expect(isDarkColor("#ffffff")).toBe(false);
  });
});
