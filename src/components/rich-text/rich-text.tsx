"use client"

import "katex/dist/katex.min.css"
import { Component, createContext, Fragment, useContext, useMemo } from "react"
import type { ErrorInfo, ReactNode } from "react"
import { lexRichText } from "@/lib/rich-text/markdown"
import { typesetMath } from "@/lib/rich-text/math"
import { markMatches } from "@/lib/resources/search"
import { cn } from "@/lib/utils"
import type { RichTextVariant } from "@/lib/rich-text/markdown"

/** The parts of a marked token this reader uses. */
type Tok = {
  type: string
  raw?: string
  text?: string
  tokens?: Tok[]
  depth?: number
  lang?: string
  ordered?: boolean
  start?: number | ""
  items?: (Tok & { task?: boolean; checked?: boolean })[]
  header?: { tokens: Tok[]; align: string | null }[]
  rows?: { tokens: Tok[]; align: string | null }[][]
  href?: string
  display?: boolean
}

/** Where a link may go: the web and email, never a script. */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

/** The search words to mark in the text (not in formulas or code). */
const Terms = createContext<readonly string[]>([])

function Words({ text }: { text: string }) {
  const terms = useContext(Terms)
  if (terms.length === 0) return <>{text}</>
  return (
    <>
      {markMatches(text, terms).map((part, key) =>
        part.match ? (
          <mark key={key} className="rounded-xs bg-surface-active px-0.5 text-foreground">
            {part.text}
          </mark>
        ) : (
          <Fragment key={key}>{part.text}</Fragment>
        )
      )}
    </>
  )
}

/**
 * A formula, typeset by KaTeX. KaTeX writes the markup from its own parse of
 * the formula with every piece of text escaped and the commands that reach
 * outside a formula refused (lib/rich-text/math.ts), which is why this one
 * element takes markup. A formula KaTeX can't read is shown as the source it
 * was written in, marked as such — never an error in place of the message.
 */
function Formula({ token, block = false }: { token: Tok; block?: boolean }) {
  const display = token.display === true
  const result = typesetMath(token.text ?? "", display)
  if (!result.ok) {
    const source = (token.raw ?? token.text ?? "").trim()
    const Tag = block ? "pre" : "code"
    return (
      <Tag className={cn("text-code text-muted-foreground", block ? "overflow-x-auto whitespace-pre-wrap" : "rounded-xs bg-surface-active px-1 py-0.5")} title="This formula couldn't be typeset — shown as written" data-math-error="">
        {source}
      </Tag>
    )
  }
  const Tag = block ? "div" : "span"
  return <Tag className={display ? "rich-math-display" : "rich-math"} data-math={display ? "display" : "inline"} dangerouslySetInnerHTML={{ __html: result.html }} />
}

function Inline({ tokens }: { tokens: Tok[] | undefined }) {
  return (
    <>
      {(tokens ?? []).map((token, index) => {
        const children = token.tokens ? <Inline tokens={token.tokens} /> : <Words text={token.text ?? ""} />
        switch (token.type) {
          case "math":
            return <Formula key={index} token={token} />
          case "strong":
            return <strong key={index}>{children}</strong>
          case "em":
            return <em key={index}>{children}</em>
          case "del":
            return <del key={index}>{children}</del>
          case "codespan":
            return (
              <code key={index} className="rounded-xs bg-surface-active px-1 py-0.5 text-code">
                {token.text}
              </code>
            )
          case "br":
            return <br key={index} />
          case "link": {
            const href = safeHref(token.href)
            return href ? (
              <a key={index} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline-offset-4 hover:underline">
                {children}
              </a>
            ) : (
              <Fragment key={index}>{children}</Fragment>
            )
          }
          // A picture is not fetched (that would tell its host this was opened): its description stands in.
          case "image":
            return (
              <span key={index} className="text-tertiary">
                [{token.text || "image"}]
              </span>
            )
          // Raw HTML is shown as the text it is, never run.
          default:
            return <Fragment key={index}>{children}</Fragment>
        }
      })}
    </>
  )
}

const HEADING_SIZE: Record<RichTextVariant, (level: number) => string> = {
  document: (level) => (level === 1 ? "text-h1" : level === 2 ? "text-h2" : "text-label"),
  // A heading inside a chat reply is a section of one message, not a page title.
  message: (level) => (level <= 2 ? "text-body font-medium" : "text-body-sm font-medium"),
}

function Blocks({ tokens, variant }: { tokens: Tok[] | undefined; variant: RichTextVariant }): ReactNode {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "math":
        return <Formula key={index} token={token} block />
      case "heading": {
        const level = Math.min(Math.max(token.depth ?? 1, 1), 6)
        const Tag = `h${level}` as "h1"
        return (
          <Tag key={index} className={`${HEADING_SIZE[variant](level)} mt-1 text-foreground`}>
            <Inline tokens={token.tokens} />
          </Tag>
        )
      }
      case "paragraph":
      case "text":
        return (
          <p key={index} className="text-body-sm text-foreground">
            {token.tokens ? <Inline tokens={token.tokens} /> : <Words text={token.text ?? ""} />}
          </p>
        )
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-md bg-surface-active p-3 text-code text-foreground" {...(token.lang ? { "data-language": token.lang } : {})}>
            <code>{token.text}</code>
          </pre>
        )
      case "blockquote":
        return (
          <blockquote key={index} className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground">
            <Blocks tokens={token.tokens} variant={variant} />
          </blockquote>
        )
      case "hr":
        return <hr key={index} className="border-border" />
      case "list": {
        const Tag = token.ordered ? "ol" : "ul"
        return (
          <Tag key={index} className={`flex flex-col gap-1 pl-5 ${token.ordered ? "list-decimal" : "list-disc"}`} {...(token.ordered && typeof token.start === "number" ? { start: token.start } : {})}>
            {(token.items ?? []).map((item, at) => (
              <li key={at} className="text-body-sm text-foreground marker:text-tertiary">
                {item.task && <input type="checkbox" checked={!!item.checked} readOnly disabled className="mr-1.5 align-middle" aria-label={item.checked ? "Done" : "Not done"} />}
                <div className="inline-flex max-w-full min-w-0 flex-col gap-1 align-top">
                  <Blocks tokens={item.tokens} variant={variant} />
                </div>
              </li>
            ))}
          </Tag>
        )
      }
      case "table":
        return (
          <div key={index} className="max-w-full overflow-x-auto">
            <table className="w-full border-collapse text-body-sm">
              <thead>
                <tr>
                  {(token.header ?? []).map((cell, at) => (
                    <th key={at} className="border border-border px-2 py-1 text-left font-medium text-foreground" style={{ textAlign: (cell.align as "left" | "center" | "right" | null) ?? undefined }}>
                      <Inline tokens={cell.tokens} />
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {(token.rows ?? []).map((row, at) => (
                  <tr key={at}>
                    {row.map((cell, column) => (
                      <td key={column} className="border border-border px-2 py-1 text-foreground" style={{ textAlign: (cell.align as "left" | "center" | "right" | null) ?? undefined }}>
                        <Inline tokens={cell.tokens} />
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )
      case "html":
        return (
          <p key={index} className="text-body-sm whitespace-pre-wrap text-muted-foreground">
            {token.text}
          </p>
        )
      default:
        return null
    }
  })
}

/** If drawing the text fails for any reason, the text is still shown — as it was written. */
class PlainOnError extends Component<{ source: string; className?: string; children: ReactNode }, { failed: boolean }> {
  state = { failed: false }
  static getDerivedStateFromError() {
    return { failed: true }
  }
  componentDidCatch(error: unknown, info: ErrorInfo) {
    console.error("Rich text could not be drawn; showing it as plain text.", error, info.componentStack)
  }
  componentDidUpdate(previous: { source: string }) {
    // Other text gets its own try.
    if (this.state.failed && previous.source !== this.props.source) this.setState({ failed: false })
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div className={this.props.className} data-rich-text="plain">
        <p className="text-body-sm whitespace-pre-wrap text-foreground">{this.props.source}</p>
      </div>
    )
  }
}

/**
 * Text written in Markdown — an AI's reply, a saved conversation, a Markdown
 * file — formatted in Hubble's own type: headings, lists, tables, quotes,
 * code, and formulas typeset by KaTeX (`$…$`, `$$…$$`, `\(…\)`, `\[…\]`).
 *
 * Built as React elements from the parsed text: raw HTML in it is shown as
 * text, links go only to the web and email, and pictures are not fetched.
 * `terms` marks search words in the text.
 *
 * Use it for the content, never for a title, a label or other metadata.
 */
export function RichText({ source, variant = "message", terms, className }: { source: string; variant?: RichTextVariant; terms?: readonly string[]; className?: string }) {
  const tokens = useMemo(() => lexRichText(source, variant) as unknown as Tok[], [source, variant])
  const classes = cn("rich-text flex min-w-0 flex-col gap-2 break-words", className)
  return (
    <PlainOnError source={source} className={classes}>
      <Terms.Provider value={terms ?? []}>
        <div className={classes} data-rich-text={variant}>
          <Blocks tokens={tokens} variant={variant} />
        </div>
      </Terms.Provider>
    </PlainOnError>
  )
}
