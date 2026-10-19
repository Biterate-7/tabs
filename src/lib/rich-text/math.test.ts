import { describe, expect, it } from "vitest"
import { blockMathAt, inlineMathAt, maskMath, typesetMath } from "./math"
import { lexRichText } from "./markdown"
import type { Token } from "marked"

/** Every formula the parser found, in order, as "I:tex" (inline) or "D:tex" (display). */
function formulas(source: string, variant: "message" | "document" = "message"): string[] {
  const out: string[] = []
  const walk = (tokens: unknown[] | undefined) => {
    for (const token of (tokens ?? []) as (Token & { display?: boolean; items?: unknown[]; header?: { tokens: unknown[] }[]; rows?: { tokens: unknown[] }[][] })[]) {
      if (token.type === "math") out.push(`${token.display ? "D" : "I"}:${token.text}`)
      if ("tokens" in token) walk(token.tokens as unknown[])
      if (token.items) walk(token.items)
      if (token.header) for (const cell of token.header) walk(cell.tokens)
      if (token.rows) for (const row of token.rows) for (const cell of row) walk(cell.tokens)
    }
  }
  walk(lexRichText(source, variant))
  return out
}

describe("finding formulas", () => {
  it("reads $…$ as inline and $$…$$ as display", () => {
    expect(formulas(String.raw`The answer is $\frac{3}{2}\theta$.`)).toEqual([String.raw`I:\frac{3}{2}\theta`])
    expect(formulas(String.raw`$$\frac{3}{2}\theta=\sin\theta$$`)).toEqual([String.raw`D:\frac{3}{2}\theta=\sin\theta`])
  })

  it("reads ChatGPT's \\(…\\) and \\[…\\] delimiters", () => {
    expect(formulas(String.raw`Since \(x^2 = 4\), we get \[x = \pm 2\]`)).toEqual([String.raw`I:x^2 = 4`, String.raw`D:x = \pm 2`])
    expect(formulas("\\[\n\\int_0^1 x\\,dx = \\tfrac12\n\\]")).toEqual([String.raw`D:\int_0^1 x\,dx = \tfrac12`])
  })

  it("keeps a multi-line display formula whole, even lines that look like Markdown", () => {
    const aligned = "$$\n\\begin{aligned}\n2x + 1 &= 5 \\\\\n- x &= -2 \\\\\n1. &\\text{done}\n\\end{aligned}\n$$"
    expect(formulas(aligned)).toEqual(["D:\\begin{aligned}\n2x + 1 &= 5 \\\\\n- x &= -2 \\\\\n1. &\\text{done}\n\\end{aligned}"])
  })

  it("ends a paragraph at a display formula that starts on the next line", () => {
    const tokens = lexRichText("Solve:\n$$x = 1$$\nThen check.", "document")
    expect(tokens.map((token) => token.type)).toEqual(["paragraph", "math", "paragraph"])
  })

  it("leaves prices, shell variables and escaped dollars as text", () => {
    for (const text of ["It costs $5 and $10.", "between $5-$10 a month", "US$20 or AU$30", "echo $PATH and $HOME", "a lone $ sign", "\\$x\\$ stays", "$ 5 $", "from $5 to $20, total $25"]) {
      expect(formulas(text), text).toEqual([])
    }
  })

  it("leaves brackets written as \\[1\\] alone — they are Markdown escapes, not a formula", () => {
    expect(formulas("See \\[1\\] and \\[note\\].")).toEqual([])
  })

  it("never looks for formulas in code", () => {
    expect(formulas("Run `echo $HOME$` now.")).toEqual([])
    expect(formulas("```bash\nprice=$5; echo \"$price$\"\n$$not math$$\n```")).toEqual([])
    expect(formulas("    $$indented code$$")).toEqual([])
  })

  it("keeps a * or _ inside a formula from closing emphasis opened outside it", () => {
    const [paragraph] = lexRichText("*Let $a*b_c$ hold*", "message") as (Token & { tokens: Token[] })[]
    expect(paragraph!.tokens[0]!.type).toBe("em")
    expect(formulas("*Let $a*b_c$ hold*")).toEqual(["I:a*b_c"])
    expect(maskMath("x $a*b$ y")).toBe("x $aaa$ y")
  })

  it("finds formulas in list items, quotes, headings and tables", () => {
    expect(formulas("# Area $A$\n\n- $x_1$\n  - $x_2$\n\n> $y$\n\n| a | b |\n|---|---|\n| $\\alpha$ | $\\|x\\|$ |")).toEqual(["I:A", "I:x_1", "I:x_2", "I:y", "I:\\alpha", "I:|x|"])
  })

  it("does not run past a blank line looking for the closing delimiter", () => {
    expect(inlineMathAt("$x\n\ny$")).toBeUndefined()
    expect(inlineMathAt("$$x\n\ny$$")).toBeUndefined()
    expect(blockMathAt("$$ x\n\n y $$\n")).toMatchObject({ tex: "x\n\n y" })
  })
})

describe("typesetting", () => {
  it("returns KaTeX markup for a valid formula, with the TeX kept for screen readers and copying", () => {
    const result = typesetMath(String.raw`\frac{3}{2}\theta=\sin\theta`, true)
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.html).toContain('class="katex-display"')
    expect(result.html).toContain('<annotation encoding="application/x-tex">\\frac{3}{2}\\theta=\\sin\\theta</annotation>')
  })

  it("returns the reason instead of throwing for a formula KaTeX can't read", () => {
    expect(typesetMath(String.raw`\frac{1}{`, false)).toMatchObject({ ok: false })
    expect(typesetMath(String.raw`\begin{tikzpicture}x\end{tikzpicture}`, true)).toMatchObject({ ok: false })
    expect(typesetMath("x".repeat(20_001), false)).toMatchObject({ ok: false })
  })

  it("refuses the commands that reach outside a formula", () => {
    for (const tex of [String.raw`\href{javascript:alert(1)}{x}`, String.raw`\url{javascript:alert(1)}`, String.raw`\htmlClass{x}{y}`, String.raw`\includegraphics{https://tracker.example/x.png}`]) {
      const result = typesetMath(tex, false)
      const drawn = document.createElement("div")
      drawn.innerHTML = result.ok ? result.html : ""
      expect(drawn.querySelector("a, img, [href], [src], .x"), tex).toBeNull()
    }
  })
})
