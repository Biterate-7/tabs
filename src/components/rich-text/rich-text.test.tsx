import { describe, expect, it, vi } from "vitest"
import { render } from "@testing-library/react"
import { RichText } from "./rich-text"

/**
 * The shared reader, judged by what it draws: a valid formula comes out as
 * KaTeX markup (its TeX only in the hidden MathML copy), never as the source
 * a person would see; prose, lists, tables and code around it keep their
 * shape; and nothing in the text is run as HTML.
 */

function draw(source: string, variant?: "message" | "document") {
  const { container } = render(<RichText source={source} {...(variant ? { variant } : {})} />)
  return container
}

/** What a person sees: the text with KaTeX's hidden MathML copy (which repeats the TeX) left out. */
function visible(element: Element): string {
  const copy = element.cloneNode(true) as Element
  for (const hidden of copy.querySelectorAll(".katex-mathml")) hidden.remove()
  return copy.textContent ?? ""
}

/** The TeX of every typeset formula, in order, as KaTeX recorded it. */
function typeset(element: Element): string[] {
  return [...element.querySelectorAll('.katex annotation[encoding="application/x-tex"]')].map((node) => node.textContent ?? "")
}

describe("formulas", () => {
  it("typesets inline math in a sentence", () => {
    const page = draw(String.raw`The answer is $\frac{3}{2}\theta$.`)
    const formula = page.querySelector('[data-math="inline"]')!
    expect(formula.closest("p")).toBeTruthy()
    expect(formula.querySelector(".katex .mfrac")).toBeTruthy()
    expect(typeset(page)).toEqual([String.raw`\frac{3}{2}\theta`])
    expect(visible(page)).toMatch(/^The answer is .*\.$/)
    expect(visible(page)).not.toMatch(/\\frac|\$/)
  })

  it("typesets a display equation as its own block", () => {
    const page = draw(String.raw`$$\frac{3}{2}\theta=\sin\theta$$`)
    const formula = page.querySelector('div[data-math="display"]')!
    expect(formula.className).toBe("rich-math-display")
    expect(formula.querySelector(".katex-display")).toBeTruthy()
    expect(typeset(page)).toEqual([String.raw`\frac{3}{2}\theta=\sin\theta`])
    expect(visible(page)).not.toMatch(/\\frac|\\sin|\$\$/)
  })

  it("typesets the screenshot's \\left, \\right, \\neq, \\leq, \\boxed and \\text", () => {
    const source = [
      String.raw`We need $\sin\theta \neq 0$, so divide by it:`,
      String.raw`$$\left(\frac{3}{2}\right)\theta = \sin\theta \quad\text{where}\quad -1 \leq \sin\theta \leq 1$$`,
      String.raw`$$\boxed{\theta = 0}$$`,
    ].join("\n\n")
    const page = draw(source)
    expect(page.querySelectorAll("[data-math-error]")).toHaveLength(0)
    expect(typeset(page)).toHaveLength(3)
    const mathml = [...page.querySelectorAll("math")].map((node) => node.textContent).join(" ")
    expect(mathml).toContain("≠")
    expect(mathml).toContain("≤")
    expect(page.querySelector(".katex .fbox, .katex .boxpad")).toBeTruthy()
    expect(page.querySelector(".katex .delimsizing, .katex .mopen")).toBeTruthy()
    expect(visible(page)).toContain("where")
    expect(visible(page)).not.toMatch(/\\(left|right|neq|leq|boxed|text|frac)\b/)
  })

  it("typesets Greek letters, powers, subscripts, roots, fractions, sums, integrals, limits and vectors", () => {
    const source = String.raw`$\alpha^2 + \beta_1 = \sqrt{\gamma}$, $\dfrac{a}{b}$, $\sum_{n=1}^{\infty} \frac{1}{n^2}$, $\int_0^1 x\,dx$, $\lim_{x \to 0} \frac{\sin x}{x}$, $\vec{v} \geq \tan\phi \cos\psi$`
    const page = draw(source)
    expect(page.querySelectorAll("[data-math-error]")).toHaveLength(0)
    expect(typeset(page)).toHaveLength(6)
    expect(page.querySelector(".katex .sqrt")).toBeTruthy()
    expect(page.querySelector(".katex .msupsub")).toBeTruthy()
    expect(page.querySelector(".katex .op-symbol")).toBeTruthy()
    expect(visible(page)).toContain("α")
    expect(visible(page)).not.toMatch(/\\(alpha|sqrt|sum|int|lim|vec)\b/)
  })

  it("typesets aligned equations, matrices and piecewise functions over several lines", () => {
    const source = [
      "$$",
      String.raw`\begin{aligned}`,
      String.raw`\frac{3}{2}\theta &= \sin\theta \\`,
      String.raw`- \sin\theta &= -\tfrac{3}{2}\theta`,
      String.raw`\end{aligned}`,
      "$$",
      "",
      String.raw`$$A = \begin{pmatrix} 1 & 2 \\ 3 & 4 \end{pmatrix}, \quad I = \begin{matrix} 1 & 0 \\ 0 & 1 \end{matrix}$$`,
      "",
      String.raw`$$f(x) = \begin{cases} x^2 & x \geq 0 \\ -x & x < 0 \end{cases}$$`,
    ].join("\n")
    const page = draw(source)
    expect(page.querySelectorAll("[data-math-error]")).toHaveLength(0)
    expect(page.querySelectorAll('div[data-math="display"]')).toHaveLength(3)
    // The "- \sin" line stays inside the formula rather than becoming a list.
    expect(page.querySelector("ul")).toBeNull()
    expect(page.querySelector(".katex .mtable")).toBeTruthy()
  })

  it("reads ChatGPT's \\( \\) and \\[ \\] delimiters", () => {
    const page = draw(String.raw`Since \(x^2 = 4\), \[x = \pm 2\]`)
    expect(typeset(page)).toEqual(["x^2 = 4", String.raw`x = \pm 2`])
  })
})

describe("structured content around formulas", () => {
  it("draws a Markdown table with formulas in its cells, scrolling when wide", () => {
    const page = draw("| Identity | Formula |\n|---|:-:|\n| Pythagorean | $\\sin^2\\theta + \\cos^2\\theta = 1$ |\n| Double angle | $\\sin 2\\theta = 2\\sin\\theta\\cos\\theta$ |")
    const table = page.querySelector("table")!
    expect(table.parentElement!.className).toContain("overflow-x-auto")
    expect(table.querySelectorAll("tbody tr")).toHaveLength(2)
    expect(table.querySelectorAll("td .katex")).toHaveLength(2)
    expect(table.querySelector("th:nth-child(2)")!.getAttribute("style")).toContain("center")
  })

  it("draws a table Hubble for Chrome saved as rows of ' | ' cells as a table", () => {
    const page = draw("Before:\n\nArea | Assessment\nAcademics | $|x| \\leq 7$\n\nAfter.")
    const table = page.querySelector("table")!
    expect([...table.querySelectorAll("th")].map((cell) => cell.textContent)).toEqual(["Area", "Assessment"])
    expect(table.querySelector("td")!.textContent).toBe("Academics")
    expect(typeset(table)).toEqual(["|x| \\leq 7"])
    // A document is taken as written: no table is made from lines that are not one.
    expect(draw("a | b\nc | d", "document").querySelector("table")).toBeNull()
  })

  it("keeps a fenced code block's dollars and backslashes as code", () => {
    const code = 'price = "$5"\nlatex = r"$\\frac{1}{2}$ and $$x$$"\npath = "C:\\\\Users\\\\me"'
    const page = draw("Here:\n\n```python\n" + code + "\n```\n\nAnd inline `$HOME$` too.")
    const pre = page.querySelector("pre")!
    expect(pre.getAttribute("data-language")).toBe("python")
    expect(pre.textContent).toBe(code)
    expect(page.querySelector("p code")!.textContent).toBe("$HOME$")
    expect(page.querySelector(".katex")).toBeNull()
  })

  it("leaves prices and other dollar signs as text", () => {
    const text = "The book costs $5 and the course $10. Plans run between $5-$10 a month (US$20 a year); run `echo $PATH`, or pay \\$3."
    const page = draw(text)
    expect(page.querySelector(".katex")).toBeNull()
    expect(page.textContent).toBe("The book costs $5 and the course $10. Plans run between $5-$10 a month (US$20 a year); run echo $PATH, or pay $3.")
  })

  it("shows a formula KaTeX can't read as its source, and the rest of the message as usual", () => {
    const errors = vi.spyOn(console, "error").mockImplementation(() => {})
    const page = draw(String.raw`Bad: $\frac{1}{$ then good: $x^2$.` + "\n\n$$\\begin{tikzpicture}\\draw (0,0);\\end{tikzpicture}$$\n\n**Still here.**")
    const broken = [...page.querySelectorAll("[data-math-error]")]
    expect(broken.map((node) => node.textContent)).toEqual([String.raw`$\frac{1}{$`, String.raw`$$\begin{tikzpicture}\draw (0,0);\end{tikzpicture}$$`])
    expect(broken[0]!.getAttribute("title")).toMatch(/couldn't be typeset/)
    expect(typeset(page)).toEqual(["x^2"])
    expect(page.querySelector("strong")!.textContent).toBe("Still here.")
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it("draws a whole AI reply: headings, prose, inline and display math, lists, quotes, code and links", () => {
    const reply = [
      "## Solving $\\frac{3}{2}\\theta = \\sin\\theta$",
      "First, note that **$\\theta = 0$** is a solution, and *only* one with $|\\theta| \\leq \\tfrac{2}{3}$.",
      "$$\\frac{3}{2}\\theta - \\sin\\theta = 0$$",
      "1. Let $f(\\theta) = \\frac{3}{2}\\theta - \\sin\\theta$.\n2. Then $f'(\\theta) = \\frac{3}{2} - \\cos\\theta > 0$:\n   - so $f$ is increasing,\n   - hence one root.",
      "> Check: $f(0) = 0$.",
      "```js\nconst f = (t) => 1.5 * t - Math.sin(t)\n```",
      "---",
      "See [KaTeX](https://katex.org) for more.",
    ].join("\n\n")
    const page = draw(reply)
    expect(page.querySelector("h2 .katex")).toBeTruthy()
    expect(page.querySelector("strong .katex")).toBeTruthy()
    expect(page.querySelector("em")!.textContent).toBe("only")
    expect(page.querySelectorAll('div[data-math="display"]')).toHaveLength(1)
    expect(page.querySelectorAll("ol > li")).toHaveLength(2)
    expect(page.querySelectorAll("ol ul > li")).toHaveLength(2)
    expect(page.querySelector("blockquote .katex")).toBeTruthy()
    expect(page.querySelector("pre")!.textContent).toBe("const f = (t) => 1.5 * t - Math.sin(t)")
    expect(page.querySelector("hr")).toBeTruthy()
    expect(page.querySelector("a")!.getAttribute("href")).toBe("https://katex.org/")
    expect(page.querySelectorAll("[data-math-error]")).toHaveLength(0)
    expect(visible(page)).not.toMatch(/\$|\\frac|\\theta|\\sin/)
  })

  it("keeps a chat message's line breaks", () => {
    const page = draw("Line one\nLine two")
    expect(page.querySelector("p br")).toBeTruthy()
    expect(draw("Line one\nLine two", "document").querySelector("p br")).toBeNull()
  })
})

describe("safety and limits", () => {
  it("never runs HTML in the text, and links only to the web", () => {
    const page = draw('<script>alert(1)</script>\n\n<img src="https://tracker.example/x.png" onerror="alert(2)">\n\n[click](javascript:alert(3)) $\\href{javascript:alert(4)}{x}$\n\n![chart](https://tracker.example/pixel.png)')
    expect(page.querySelector("script, img, [onerror]")).toBeNull()
    expect(page.querySelector("a")).toBeNull()
    expect(page.textContent).toContain("<script>alert(1)</script>")
    expect(page.textContent).toContain("[chart]")
  })

  it("draws nothing for empty text, without failing", () => {
    expect(draw("").textContent).toBe("")
    expect(draw("   \n\n  ").querySelector("[data-math-error]")).toBeNull()
  })

  it("draws a very long reply with many formulas", () => {
    const reply = Array.from({ length: 400 }, (_, index) => `Step ${index}: $x_{${index}} = \\frac{${index}}{2}$ costs $${index} per unit.`).join("\n\n")
    const page = draw(reply)
    expect(page.querySelectorAll('[data-math="inline"]')).toHaveLength(400)
    expect(page.querySelectorAll("p")).toHaveLength(400)
  })

  it("marks search words in the text, not inside formulas", () => {
    const { container } = render(<RichText source={"The sine of $\\sin\\theta$ is the sine."} terms={["sine"]} />)
    expect([...container.querySelectorAll("mark")].map((mark) => mark.textContent)).toEqual(["sine", "sine"])
    expect(container.querySelector(".katex mark")).toBeNull()
  })
})
