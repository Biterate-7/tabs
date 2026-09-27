/**
 * Identifies an icon by its bytes, never by the response's Content-Type.
 *
 * Both halves of that matter. Servers label real icons wrongly all the time
 * (`text/plain`, `application/octet-stream` for .ico), so trusting the header
 * would reject working favicons. And a `/favicon.ico` that "succeeds" is very
 * often a soft 404 — the site's HTML error page served with status 200 — or,
 * as with Google's own favicon service, a placeholder globe served with a
 * 404. Only a body that is actually an image in a format browsers render
 * counts, and the returned MIME type is the one the route sends.
 */
export function sniffIconType(bytes: Uint8Array): string | null {
  if (bytes.length < 4) return null;
  const at = (offset: number, ...values: number[]) => values.every((value, i) => bytes[offset + i] === value);
  const ascii = (offset: number, text: string) => at(offset, ...Array.from(text, (ch) => ch.charCodeAt(0)));

  if (at(0, 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a)) return "image/png";
  // ICONDIR: reserved 0, type 1 (icon), and at least one image.
  if (bytes.length >= 6 && at(0, 0x00, 0x00, 0x01, 0x00) && (bytes[4] | (bytes[5] << 8)) > 0) return "image/x-icon";
  if (ascii(0, "GIF87a") || ascii(0, "GIF89a")) return "image/gif";
  if (at(0, 0xff, 0xd8, 0xff)) return "image/jpeg";
  if (bytes.length >= 12 && ascii(0, "RIFF") && ascii(8, "WEBP")) return "image/webp";
  if (bytes.length >= 12 && ascii(4, "ftyp") && (ascii(8, "avif") || ascii(8, "avis"))) return "image/avif";
  if (bytes.length >= 14 && ascii(0, "BM")) return "image/bmp";
  if (isSvgDocument(bytes)) return "image/svg+xml";
  return null;
}

/**
 * True only when the document's root element is `<svg>`. An HTML error page
 * that merely contains an inline <svg> logo somewhere in its body must not
 * pass, which is why this skips the prolog and then insists the first
 * element is the svg one, rather than searching for "<svg" anywhere.
 */
function isSvgDocument(bytes: Uint8Array): boolean {
  let text = new TextDecoder("utf-8", { fatal: false }).decode(bytes.subarray(0, 4096));
  text = text.replace(/^﻿/, "");
  // Prolog: whitespace, <?xml …?>, comments, and a DOCTYPE, in any order.
  let previous: string;
  do {
    previous = text;
    text = text
      .replace(/^\s+/, "")
      .replace(/^<\?xml[\s\S]*?\?>/i, "")
      .replace(/^<!--[\s\S]*?-->/, "")
      .replace(/^<!DOCTYPE[^>[]*(\[[\s\S]*?\])?\s*>/i, "");
  } while (text !== previous);
  return /^<svg[\s>/]/i.test(text);
}
