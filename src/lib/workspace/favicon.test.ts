import { describe, expect, it } from "vitest";
import { faviconUrl, avatarFallback } from "./favicon";

describe("faviconUrl", () => {
  it("builds a favicon-service URL for the domain", () => {
    expect(faviconUrl("github.com")).toBe(
      "https://www.google.com/s2/favicons?sz=64&domain=github.com"
    );
  });
});

describe("avatarFallback", () => {
  it("uses the first letter of the domain, uppercased", () => {
    expect(avatarFallback("github.com").letter).toBe("G");
    expect(avatarFallback("amazon.in").letter).toBe("A");
  });

  it("is deterministic for the same domain", () => {
    expect(avatarFallback("github.com")).toEqual(avatarFallback("github.com"));
  });

  it("picks a category accent CSS variable as the color", () => {
    const { colorVar } = avatarFallback("github.com");
    expect(colorVar.startsWith("--category-")).toBe(true);
  });

  it("handles an empty domain without throwing", () => {
    expect(() => avatarFallback("")).not.toThrow();
    expect(avatarFallback("").letter).toBe("?");
  });
});
