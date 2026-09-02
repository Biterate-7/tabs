import { describe, expect, it } from "vitest";
import {
  LOGO_MAX_DATA_URL_LENGTH,
  LOGO_MAX_DIMENSION,
  LOGO_MAX_SOURCE_BYTES,
  fitLogoDimensions,
  isValidLogoDataUrl,
  processLogoFile,
  validateLogoFile,
} from "./logo";

describe("validateLogoFile", () => {
  it("accepts png, jpeg, webp, and svg", () => {
    for (const type of ["image/png", "image/jpeg", "image/webp", "image/svg+xml"]) {
      expect(validateLogoFile({ type, size: 1024 })).toBeNull();
    }
  });

  it("rejects a non-image type", () => {
    expect(validateLogoFile({ type: "application/pdf", size: 1024 })).toMatch(/PNG, JPG, WEBP, or SVG/);
  });

  it("rejects a file over the source size cap", () => {
    expect(validateLogoFile({ type: "image/png", size: LOGO_MAX_SOURCE_BYTES + 1 })).toMatch(/too large/);
  });

  it("accepts a file exactly at the source size cap", () => {
    expect(validateLogoFile({ type: "image/png", size: LOGO_MAX_SOURCE_BYTES })).toBeNull();
  });
});

describe("fitLogoDimensions", () => {
  it("leaves a small image untouched (never upscales)", () => {
    expect(fitLogoDimensions(100, 50)).toEqual({ width: 100, height: 50 });
  });

  it("downscales a large square image to the max dimension", () => {
    expect(fitLogoDimensions(2000, 2000)).toEqual({ width: LOGO_MAX_DIMENSION, height: LOGO_MAX_DIMENSION });
  });

  it("preserves aspect ratio for a wide image", () => {
    const result = fitLogoDimensions(4000, 1000, 512);
    expect(result.width).toBe(512);
    expect(result.height).toBe(128);
  });

  it("preserves aspect ratio for a tall image", () => {
    const result = fitLogoDimensions(1000, 4000, 512);
    expect(result.width).toBe(128);
    expect(result.height).toBe(512);
  });

  it("only scales down to the longer edge, keeping the shorter edge under the cap too", () => {
    const { width, height } = fitLogoDimensions(3000, 1500, 512);
    expect(Math.max(width, height)).toBeLessThanOrEqual(512);
  });
});

describe("isValidLogoDataUrl", () => {
  it("accepts a well-formed, reasonably sized data URL", () => {
    expect(isValidLogoDataUrl("data:image/png;base64,aGVsbG8=")).toBe(true);
  });

  it("rejects a non-data-url string", () => {
    expect(isValidLogoDataUrl("https://example.com/logo.png")).toBe(false);
  });

  it("rejects an unsupported mime type", () => {
    expect(isValidLogoDataUrl("data:application/pdf;base64,aGVsbG8=")).toBe(false);
  });

  it("rejects a data URL over the length cap", () => {
    const huge = `data:image/png;base64,${"A".repeat(LOGO_MAX_DATA_URL_LENGTH + 1)}`;
    expect(isValidLogoDataUrl(huge)).toBe(false);
  });
});

describe("processLogoFile (SVG path — doesn't require canvas)", () => {
  it("encodes a valid SVG as a data URL", async () => {
    const file = new File(["<svg><circle r='1'/></svg>"], "logo.svg", { type: "image/svg+xml" });
    const result = await processLogoFile(file);
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("expected ok");
    expect(result.dataUrl.startsWith("data:image/svg+xml;base64,")).toBe(true);
    expect(isValidLogoDataUrl(result.dataUrl)).toBe(true);
  });

  it("rejects an SVG containing a <script> element", async () => {
    const file = new File(["<svg><script>alert(1)</script></svg>"], "logo.svg", { type: "image/svg+xml" });
    const result = await processLogoFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/script/i);
  });

  it("rejects a non-image file before touching its content", async () => {
    const file = new File(["not an image"], "notes.txt", { type: "text/plain" });
    const result = await processLogoFile(file);
    expect(result.ok).toBe(false);
    if (result.ok) throw new Error("expected error");
    expect(result.error).toMatch(/PNG, JPG, WEBP, or SVG/);
  });
});
