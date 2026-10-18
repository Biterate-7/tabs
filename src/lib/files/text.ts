/**
 * A text file's characters, whatever it was saved as.
 *
 * A byte-order mark decides when there is one (UTF-8, UTF-16 LE/BE). Without
 * one, strict UTF-8 is tried first — almost every modern file — and a file
 * that isn't valid UTF-8 is read as Windows-1252, what older Windows editors
 * wrote. A file that turns out to be binary (an image renamed .txt) is
 * refused rather than stored as noise.
 */

export class NotTextError extends Error {
  constructor() {
    super("This file doesn't contain readable text.");
    this.name = "NotTextError";
  }
}

function utf16WithoutBom(bytes: Uint8Array): "utf-16le" | "utf-16be" | undefined {
  // ASCII-heavy UTF-16 has a zero in every other byte.
  const sample = bytes.subarray(0, Math.min(bytes.length, 4096));
  if (sample.length < 4) return undefined;
  let evenZeros = 0;
  let oddZeros = 0;
  for (let index = 0; index < sample.length; index++) {
    if (sample[index] !== 0) continue;
    if (index % 2 === 0) evenZeros += 1;
    else oddZeros += 1;
  }
  const half = sample.length / 2;
  if (oddZeros > half * 0.6 && evenZeros < half * 0.05) return "utf-16le";
  if (evenZeros > half * 0.6 && oddZeros < half * 0.05) return "utf-16be";
  return undefined;
}

function decodeWith(encoding: string, bytes: Uint8Array, fatal = false): string {
  return new TextDecoder(encoding, { fatal }).decode(bytes);
}

/** Share of characters that no text file contains (controls other than tab, line breaks and form feed). */
function controlShare(text: string): number {
  if (text.length === 0) return 0;
  const sample = text.slice(0, 20_000);
  let controls = 0;
  for (let index = 0; index < sample.length; index++) {
    const code = sample.charCodeAt(index);
    if ((code < 32 && code !== 9 && code !== 10 && code !== 12 && code !== 13) || code === 0xfffd) controls += 1;
  }
  return controls / sample.length;
}

export function decodeTextFile(bytes: Uint8Array): string {
  let text: string;
  if (bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf) text = decodeWith("utf-8", bytes.subarray(3));
  else if (bytes[0] === 0xff && bytes[1] === 0xfe) text = decodeWith("utf-16le", bytes.subarray(2));
  else if (bytes[0] === 0xfe && bytes[1] === 0xff) text = decodeWith("utf-16be", bytes.subarray(2));
  else {
    const utf16 = utf16WithoutBom(bytes);
    if (utf16) text = decodeWith(utf16, bytes);
    else {
      try {
        text = decodeWith("utf-8", bytes, true);
      } catch {
        text = decodeWith("windows-1252", bytes);
      }
    }
  }
  if (controlShare(text) > 0.01) throw new NotTextError();
  return text.replace(/\r\n?/g, "\n");
}
