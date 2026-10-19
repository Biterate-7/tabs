import { Marked } from "marked"
import type { Token, Tokens } from "marked"
import { blockMath, inlineMath, maskMath } from "./math"

/**
 * Text Hubble shows formatted — an AI's reply, a saved conversation, a
 * Markdown file — parsed once, here, into Markdown tokens with formulas.
 *
 *   document  a Markdown file: CommonMark + GFM, a single line break is a
 *             space, as the file's author meant it;
 *   message   what an AI app or a person wrote in a chat: the same, except a
 *             line break is kept as one (chat apps show them, and a saved
 *             reply's lines are lines), and a table Hubble for Chrome saved
 *             as rows of cells joined by " | " is read as the table it was.
 *
 * The result is tokens, never HTML: the reader (components/rich-text) builds
 * React elements from them, so nothing in the text is ever run as markup.
 */
export type RichTextVariant = "document" | "message"

const parsers: Record<RichTextVariant, Marked> = {
  document: new Marked({ gfm: true, breaks: false, extensions: [blockMath, inlineMath], hooks: { emStrongMask: maskMath } }),
  message: new Marked({ gfm: true, breaks: true, extensions: [blockMath, inlineMath], hooks: { emStrongMask: maskMath } }),
}

/**
 * A table as Hubble for Chrome has saved it from a reply (extension/src/ai-pages.js):
 * one row per line, cells joined by " | ", no header rule. Every line has the
 * same number of cells, at least two, and none is already a Markdown table row.
 */
function savedTableRows(paragraph: string): string[][] | undefined {
  const lines = paragraph.replace(/\n+$/, "").split("\n")
  if (lines.length < 2) return undefined
  const rows = lines.map((line) => line.split(" | "))
  const width = rows[0]!.length
  if (width < 2) return undefined
  for (const [index, row] of rows.entries()) {
    const line = lines[index]!.trim()
    if (row.length !== width || line.startsWith("|") || line.endsWith("|") || /^[\s|:-]+$/.test(line)) return undefined
  }
  return rows
}

function asMarkdownTable(rows: string[][]): string {
  // A "|" inside a cell (|x| in a formula) is escaped so it stays in its cell.
  const line = (cells: string[]) => `| ${cells.map((cell) => cell.trim().replace(/(?<!\\)\|/g, "\\|")).join(" | ")} |`
  return [line(rows[0]!), line(rows[0]!.map(() => "---")), ...rows.slice(1).map(line)].join("\n")
}

/** Parse failures never reach the page: the text is shown as plain paragraphs instead. */
function plainParagraphs(source: string): Token[] {
  return source
    .split(/\n{2,}/)
    .filter((part) => part.trim())
    .map((part) => ({ type: "paragraph", raw: part, text: part, tokens: [{ type: "text", raw: part, text: part }] }) as Tokens.Paragraph)
}

export function lexRichText(source: string, variant: RichTextVariant): Token[] {
  const parser = parsers[variant]
  try {
    const tokens: Token[] = parser.lexer(source)
    if (variant !== "message") return tokens
    return tokens.map((token) => {
      if (token.type !== "paragraph") return token
      const rows = savedTableRows(token.raw)
      if (!rows) return token
      const [table] = parser.lexer(asMarkdownTable(rows))
      return table?.type === "table" ? table : token
    })
  } catch {
    return plainParagraphs(source)
  }
}
