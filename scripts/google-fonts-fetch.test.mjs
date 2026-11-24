import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { fontExtension, localizeCss, nextReadablePath } from "./google-fonts-fetch.mjs";

/**
 * The desktop export hands next/font local font files, so the build no
 * longer depends on the form of Google's font addresses — including the
 * extension-less `fonts.gstatic.com/l/font?kit=…` form that broke the
 * macOS build (2026-11-22 Turbopack, 2026-11-24 webpack).
 */

const WOFF2 = Buffer.concat([Buffer.from("wOF2", "latin1"), Buffer.alloc(60, 7)]);
const TTF = Buffer.concat([Buffer.from([0, 1, 0, 0]), Buffer.alloc(60, 3)]);
// What next/font's loader does with each address in the stylesheet (find-font-files-in-css + loader).
const nextFindsFiles = (css) => [...css.matchAll(/src: url\((.+?)\)/g)].map((match) => match[1]);
const nextExtension = (address) => /\.(woff|woff2|eot|ttf|otf)$/.exec(address)?.[1];

let dir;
afterEach(() => dir && rmSync(dir, { recursive: true, force: true }));

describe("local Google Fonts for the desktop export", () => {
  it("turns Google's extension-less addresses into local files next/font can read", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hubble-fonts-"));
    const css = [
      "/* latin */",
      "@font-face {",
      "  font-family: 'Merriweather';",
      "  src: url(https://fonts.gstatic.com/l/font?kit=u-4e0qyriQwlOrhSvowK&skey=abc&v=v33) format('woff2');",
      "}",
      "/* latin */",
      "@font-face {",
      "  font-family: 'Cascadia Code';",
      "  src: url(https://fonts.gstatic.com/s/cascadiacode/v5/qWc_B6.ttf) format('truetype');",
      "}",
    ].join("\n");
    // As shipped, next/font can't read the first address — the macOS failure.
    expect(nextExtension(nextFindsFiles(css)[0])).toBeUndefined();

    const fetched = [];
    const local = await localizeCss(css, { cacheDir: dir, fetch: async (url) => (fetched.push(url), url.includes("/l/font") ? WOFF2 : TTF) });
    expect(fetched).toHaveLength(2);
    const files = nextFindsFiles(local);
    expect(files.map(nextExtension)).toEqual(["woff2", "ttf"]);
    for (const file of files) {
      // next/font reads a file from disk only when the address starts with "/".
      expect(file.startsWith("/")).toBe(true);
      expect(readFileSync(file).subarray(0, 4)).toEqual(file.endsWith("woff2") ? WOFF2.subarray(0, 4) : TTF.subarray(0, 4));
    }
    // Comments that decide which subsets are preloaded are kept.
    expect(local).toContain("/* latin */");
    expect(local).toContain("format('woff2')");
  });

  it("refuses an answer that isn't a font file", async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), "hubble-fonts-"));
    const css = "@font-face { src: url(https://fonts.gstatic.com/l/font?kit=x) format('woff2'); }";
    await expect(localizeCss(css, { cacheDir: dir, fetch: async () => Buffer.from("<html>blocked</html>") })).rejects.toThrow(/is not a font file/);
  });

  it("names formats by their first bytes", () => {
    expect(fontExtension(WOFF2)).toBe("woff2");
    expect(fontExtension(Buffer.from("wOFFxxxx", "latin1"))).toBe("woff");
    expect(fontExtension(Buffer.from("OTTOxxxx", "latin1"))).toBe("otf");
    expect(fontExtension(TTF)).toBe("ttf");
    expect(fontExtension(Buffer.from("<!DOCTYPE", "latin1"))).toBeUndefined();
  });

  it("writes paths next/font treats as local on every platform", () => {
    const readable = nextReadablePath(path.join(os.tmpdir(), "a", "b.woff2"));
    expect(readable.startsWith("/")).toBe(true);
    expect(readable).not.toMatch(/^[A-Za-z]:|\\/);
    expect(existsSync(path.resolve(readable).replace(/[\\/]a[\\/]b\.woff2$/, ""))).toBe(true);
  });

  it("answers only Google Fonts stylesheet lookups", () => {
    const fonts = createRequire(import.meta.url)("./google-fonts-local.cjs");
    expect(fonts["https://example.com/x.css"]).toBeUndefined();
    expect(fonts[Symbol.toStringTag]).toBeUndefined();
  });
});
