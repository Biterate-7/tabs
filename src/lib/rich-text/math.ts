import katex from "katex"
import type { TokenizerExtension, Tokens } from "marked"

/**
 * Formulas in Markdown, for the shared rich-text reader.
 *
 * Every AI app writes TeX between delimiters, and Hubble keeps it that way:
 * a conversation saved from the page has each KaTeX formula turned back into
 * `$…$` (inline) or `$$…$$` (display) by Hubble for Chrome; an export file or
 * a paste carries whatever the provider wrote — ChatGPT's `\(…\)` and
 * `\[…\]`, Claude's and Gemini's `$…$` and `$$…$$`. The stored text is never
 * rewritten; these are tokenizers for the Markdown parser (marked), so a
 * formula is recognised where it is written and nowhere else — never inside a
 * code span or a fenced block, which the parser has already claimed.
 *
 * Telling a formula from a price follows Pandoc's rule for `$…$`: the opening
 * `$` is not followed by a space, the closing one is not preceded by a space
 * nor followed by a digit. So "$5 and $10" and "between $5-$10" stay text,
 * and `\$` is always a dollar sign.
 */

export type MathToken = Tokens.Generic & { type: "math"; text: string; display: boolean }

/** A formula longer than this is shown as its source, not typeset (KaTeX's cost grows with it). */
export const MAX_TEX = 20_000

/** The characters before `at` that are backslashes, counted — an odd count escapes the character at `at`. */
function escaped(src: string, at: number): boolean {
  let count = 0
  for (let index = at - 1; index >= 0 && src[index] === "\\"; index--) count++
  return count % 2 === 1
}

/**
 * The first unescaped `close` at or after `from`, before a blank line and
 * within a formula's length; -1 if none. Bounded, so a page of unmatched
 * dollar signs costs a short scan per sign, not the whole page per sign.
 */
function closing(src: string, close: string, from: number): number {
  const last = Math.min(src.length, from + MAX_TEX)
  for (let index = from; index < last; index++) {
    if (src[index] === "\n" && /^\n[ \t]*\n/.test(src.slice(index, index + 64))) return -1
    if (src.startsWith(close, index) && !escaped(src, index)) return index
  }
  return -1
}

/** `\[…\]` is also Markdown's way to write brackets that are not a link: it is a formula only when it reads as one. */
const LOOKS_LIKE_TEX = /[\\^_={}+\-*/<>|]/

type Span = { raw: string; tex: string; display: boolean }

/** The formula that starts exactly at the beginning of `src`, if one does. */
export function inlineMathAt(src: string): Span | undefined {
  if (src.startsWith("$$")) {
    const end = closing(src, "$$", 2)
    if (end < 0) return undefined
    const tex = src.slice(2, end)
    if (!tex.trim()) return undefined
    return { raw: src.slice(0, end + 2), tex: tex.trim(), display: true }
  }
  if (src.startsWith("$")) {
    if (src.length < 3 || /\s/.test(src[1]!)) return undefined
    for (let from = 1; ; ) {
      const end = closing(src, "$", from)
      if (end < 0) return undefined
      // `$$` is never the end of a `$…$` formula, and a closing `$` hugs its formula and is not the start of a price.
      if (src[end + 1] === "$") return undefined
      if (end > 1 && !/\s/.test(src[end - 1]!) && !/[0-9]/.test(src[end + 1] ?? "")) {
        return { raw: src.slice(0, end + 1), tex: src.slice(1, end), display: false }
      }
      from = end + 1
    }
  }
  if (src.startsWith("\\(") || src.startsWith("\\[")) {
    const display = src[1] === "["
    const end = closing(src, display ? "\\]" : "\\)", 2)
    if (end < 0) return undefined
    const tex = src.slice(2, end)
    if (!tex.trim() || (display && !LOOKS_LIKE_TEX.test(tex))) return undefined
    return { raw: src.slice(0, end + 2), tex: tex.trim(), display }
  }
  return undefined
}

/**
 * A display formula that is a block of its own: `$$` or `\[` opening a line
 * (up to three spaces in), closing with nothing after it on its line. Inside,
 * lines that would otherwise read as Markdown — `- x`, `1. y`, a blank line
 * in an `aligned` — stay part of the formula.
 */
export function blockMathAt(src: string): Span | undefined {
  const open = /^ {0,3}(\$\$|\\\[)/.exec(src)
  if (!open) return undefined
  const close = open[1] === "$$" ? "$$" : "\\]"
  const start = open[0].length
  const last = Math.min(src.length, start + MAX_TEX)
  for (let index = start; index < last; index++) {
    if (!src.startsWith(close, index) || escaped(src, index)) continue
    const rest = /^[ \t]*(?:\n|$)/.exec(src.slice(index + close.length))
    if (!rest) return undefined
    const tex = src.slice(start, index).trim()
    if (!tex || (close === "\\]" && !LOOKS_LIKE_TEX.test(tex))) return undefined
    return { raw: src.slice(0, index + close.length + rest[0].length), tex, display: true }
  }
  return undefined
}

/** Where the next formula may start in a run of inline text — the parser stops its plain text there to ask. */
function nextInlineStart(src: string): number | undefined {
  for (let index = 0; index < src.length; index++) {
    const char = src[index]
    if (char === "$" && !escaped(src, index)) return index
    if (char === "\\" && (src[index + 1] === "(" || src[index + 1] === "[") && !escaped(src, index)) return index
  }
  return undefined
}

/**
 * The start of the next line that opens a block formula, for the parser to
 * end a paragraph before it. The parser asks with the rest of the document;
 * only the paragraph it is reading (up to a blank line) can be cut.
 */
function nextBlockStart(src: string): number | undefined {
  const blank = /\n[ \t]*\n/.exec(src)
  const paragraph = blank ? src.slice(0, blank.index) : src
  const lines = /(^|\n) {0,3}(?:\$\$|\\\[)/g
  for (let match = lines.exec(paragraph); match; match = lines.exec(paragraph)) {
    const at = match.index + match[1]!.length
    if (blockMathAt(src.slice(at))) return at
  }
  return undefined
}

export const blockMath: TokenizerExtension = {
  name: "math",
  level: "block",
  start: nextBlockStart,
  tokenizer(src) {
    const span = blockMathAt(src)
    return span ? ({ type: "math", raw: span.raw, text: span.tex, display: true } satisfies MathToken) : undefined
  },
}

export const inlineMath: TokenizerExtension = {
  name: "math",
  level: "inline",
  start: nextInlineStart,
  tokenizer(src) {
    const span = inlineMathAt(src)
    return span ? ({ type: "math", raw: span.raw, text: span.tex, display: span.display } satisfies MathToken) : undefined
  },
}

/**
 * The inline text with each formula's inside blanked, same length — what the
 * parser looks through for the closing `*` or `_` of an emphasis, so that the
 * `*` in `$a*b$` never closes one opened outside the formula.
 */
export function maskMath(src: string): string {
  let out = ""
  for (let index = 0; index < src.length; ) {
    const at = nextInlineStart(src.slice(index))
    if (at === undefined) return out + src.slice(index)
    out += src.slice(index, index + at)
    index += at
    const span = inlineMathAt(src.slice(index))
    if (!span) {
      out += src[index]
      index += 1
      continue
    }
    const open = span.raw.startsWith("$$") || span.raw.startsWith("\\") ? 2 : 1
    out += span.raw.slice(0, open) + "a".repeat(span.raw.length - open * 2) + span.raw.slice(-open)
    index += span.raw.length
  }
  return out
}

export type Typeset = { ok: true; html: string } | { ok: false; error: string }

const typeset = new Map<string, Typeset>()
const TYPESET_CACHE = 500

/**
 * A formula as KaTeX markup, or why it could not be typeset.
 *
 * KaTeX builds this markup itself from the parsed formula, escaping every
 * piece of text; with `trust: false` the commands that could reach outside
 * the formula (`\href`, `\url`, `\includegraphics`, `\htmlClass`…) are
 * refused, so the result is safe to place in the page. Errors are returned,
 * never thrown — one bad formula never takes its message down with it.
 */
export function typesetMath(tex: string, display: boolean): Typeset {
  const key = `${display ? "D" : "I"}${tex}`
  const known = typeset.get(key)
  if (known) return known
  let result: Typeset
  if (tex.length > MAX_TEX) result = { ok: false, error: "This formula is too long to typeset." }
  else {
    try {
      result = {
        ok: true,
        html: katex.renderToString(tex, {
          displayMode: display,
          throwOnError: true,
          output: "htmlAndMathml",
          trust: false,
          strict: "ignore",
          maxSize: 50,
          maxExpand: 1000,
        }),
      }
    } catch (error) {
      result = { ok: false, error: error instanceof Error ? error.message : "This formula could not be typeset." }
    }
  }
  if (typeset.size >= TYPESET_CACHE) typeset.delete(typeset.keys().next().value!)
  typeset.set(key, result)
  return result
}
