// Fetches one Google Fonts stylesheet and every font file it names, keeps
// them in node_modules/.cache/hubble-fonts, and writes the stylesheet with
// each `url(...)` pointing at the local copy. Used by
// scripts/google-fonts-local.cjs (NEXT_FONT_GOOGLE_MOCKED_RESPONSES) so the
// desktop export never depends on the form of Google's font addresses.
//
// Why: next/font (webpack and Turbopack alike) reads a font file's format
// from the end of its address — `/\.(woff|woff2|eot|ttf|otf)$/` — and some
// Google Fonts edges (seen on the macOS CI runner, 2026-11-22 and -24) answer
// with `fonts.gstatic.com/l/font?kit=…&skey=…` instead. Webpack then fails
// with "Cannot read properties of null (reading '1')", Turbopack with
// "next/font/google queries have exactly one entry". Here each file is named
// by what its first bytes say it is, whatever its address.
//
//   node scripts/google-fonts-fetch.mjs <stylesheet url> <output .css path>
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

// The browser next/font announces itself as, so Google answers with the same files (woff2).
export const USER_AGENT = "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/104.0.0.0 Safari/537.36";

const sha = (text) => createHash("sha256").update(text).digest("hex").slice(0, 32);

/** The font format a file's first bytes declare, or undefined. */
export function fontExtension(bytes) {
  const tag = bytes.subarray(0, 4).toString("latin1");
  if (tag === "wOF2") return "woff2";
  if (tag === "wOFF") return "woff";
  if (tag === "OTTO") return "otf";
  if (tag === "true" || bytes.readUInt32BE(0) === 0x00010000) return "ttf";
  return undefined;
}

/**
 * The path next/font will read: it reads a font from disk only when the
 * address starts with "/", so on Windows the drive letter is dropped (the
 * path then resolves on the current drive, where the repository is).
 */
export function nextReadablePath(file) {
  return path.resolve(file).replace(/^[A-Za-z]:/, "").replace(/\\/g, "/");
}

async function withRetries(work, tries = 4) {
  let last;
  for (let attempt = 0; attempt < tries; attempt++) {
    try {
      return await work();
    } catch (error) {
      last = error;
      await new Promise((resolve) => setTimeout(resolve, 500 * 2 ** attempt));
    }
  }
  throw last;
}

export async function fetchBytes(url) {
  return withRetries(async () => {
    const response = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!response.ok) throw new Error(`${url} answered ${response.status}`);
    return Buffer.from(await response.arrayBuffer());
  });
}

/** Downloads every font file in the stylesheet into `cacheDir` and points the stylesheet at those copies. */
export async function localizeCss(css, { cacheDir, fetch: get = fetchBytes }) {
  mkdirSync(cacheDir, { recursive: true });
  const urls = [...new Set([...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].replace(/^['"]|['"]$/g, "")))];
  const local = new Map();
  for (const url of urls) {
    const bytes = await get(url);
    const extension = fontExtension(bytes);
    if (!extension) throw new Error(`${url} is not a font file (first bytes ${bytes.subarray(0, 4).toString("hex")})`);
    const file = path.join(cacheDir, `${sha(url)}.${extension}`);
    if (!existsSync(file)) writeFileSync(file, bytes);
    local.set(url, nextReadablePath(file));
  }
  return css.replace(/url\(([^)]+)\)/g, (whole, raw) => {
    const url = raw.replace(/^['"]|['"]$/g, "");
    return local.has(url) ? `url(${local.get(url)})` : whole;
  });
}

const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const [url, output] = process.argv.slice(2);
  if (!url || !output) {
    console.error("usage: node scripts/google-fonts-fetch.mjs <stylesheet url> <output .css path>");
    process.exit(2);
  }
  try {
    const css = (await fetchBytes(url)).toString("utf8");
    const localized = await localizeCss(css, { cacheDir: path.dirname(output) });
    writeFileSync(output, localized);
  } catch (error) {
    console.error(`[google-fonts] ${error.message}`);
    process.exit(1);
  }
}

