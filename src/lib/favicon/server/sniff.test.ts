// @vitest-environment node
import { describe, expect, it } from "vitest";
import { GIF, HTML_ERROR_PAGE, ICO, JPEG, PNG, SVG, WEBP } from "../__fixtures__/icons";
import { sniffIconType } from "./sniff";

describe("sniffIconType", () => {
  it("recognises every format browsers render as a favicon", () => {
    expect(sniffIconType(PNG)).toBe("image/png");
    expect(sniffIconType(ICO)).toBe("image/x-icon");
    expect(sniffIconType(SVG)).toBe("image/svg+xml");
    expect(sniffIconType(GIF)).toBe("image/gif");
    expect(sniffIconType(JPEG)).toBe("image/jpeg");
    expect(sniffIconType(WEBP)).toBe("image/webp");
  });

  it("accepts an SVG with a BOM, whitespace and a DOCTYPE before the root", () => {
    const svg = Buffer.from(
      `﻿  <!DOCTYPE svg PUBLIC "-//W3C//DTD SVG 1.1//EN" "http://www.w3.org/Graphics/SVG/1.1/DTD/svg11.dtd">\n<svg width="16" height="16"></svg>`
    );
    expect(sniffIconType(svg)).toBe("image/svg+xml");
  });

  it("rejects a soft-404 HTML page even when it contains an inline <svg>", () => {
    expect(sniffIconType(HTML_ERROR_PAGE)).toBeNull();
  });

  it("rejects malformed and unsupported bodies", () => {
    expect(sniffIconType(Buffer.alloc(0))).toBeNull();
    expect(sniffIconType(Buffer.from("{}"))).toBeNull();
    expect(sniffIconType(Buffer.from('{"error":"not found"}'))).toBeNull();
    expect(sniffIconType(Buffer.from("%PDF-1.7 ..."))).toBeNull();
    // An ICONDIR that declares zero images is not an icon.
    expect(sniffIconType(Buffer.from([0, 0, 1, 0, 0, 0]))).toBeNull();
    // A truncated PNG signature is not a PNG.
    expect(sniffIconType(Buffer.from([0x89, 0x50, 0x4e, 0x47]))).toBeNull();
  });
});
