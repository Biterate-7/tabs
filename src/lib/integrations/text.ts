/**
 * Characters the integration layer strips from any text it stores or shows:
 * C0/C1 controls, zero-width characters, line/paragraph separators,
 * bidirectional overrides and isolates, and the byte-order mark — the ones
 * that let saved text hide or reorder what a person reads.
 *
 * Built from code points rather than written as a literal class, so the
 * source file holds no invisible characters itself.
 */
const hex = (code: number) => code.toString(16).padStart(4, "0");
const ranges = (spans: readonly (readonly [number, number])[]) => spans.map(([a, b]) => `\\u${hex(a)}-\\u${hex(b)}`).join("");

const INVISIBLE: readonly (readonly [number, number])[] = [
  [0x7f, 0x9f],
  [0x200b, 0x200f],
  [0x2028, 0x202e],
  [0x2060, 0x2069],
  [0xfeff, 0xfeff],
];

/** Every control character, newlines included, plus the invisible ones. For one-line labels. */
export const UNSAFE_ANY = new RegExp(`[${ranges([[0x00, 0x1f], ...INVISIBLE])}]`, "g");

/** The same, but keeping tab, newline and carriage return. For multi-line text. */
export const UNSAFE_KEEP_LINES = new RegExp(`[${ranges([[0x00, 0x08], [0x0b, 0x0c], [0x0e, 0x1f], ...INVISIBLE])}]`, "g");
