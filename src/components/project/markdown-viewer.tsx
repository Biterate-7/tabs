"use client"

import { Fragment } from "react"
import { Lexer } from "marked"
import type { ReactNode } from "react"

/** The parts of a marked token this reader uses. */
type Tok = {
  type: string
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
}

/** Where a link in a document may go: the web and email, never a script. */
export function safeHref(href: string | undefined): string | undefined {
  if (!href) return undefined
  try {
    const url = new URL(href)
    return ["http:", "https:", "mailto:"].includes(url.protocol) ? url.href : undefined
  } catch {
    return undefined
  }
}

function Inline({ tokens }: { tokens: Tok[] | undefined }) {
  return (
    <>
      {(tokens ?? []).map((token, index) => {
        const children = token.tokens ? <Inline tokens={token.tokens} /> : token.text
        switch (token.type) {
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
          // A picture in a note is not fetched (that would tell its host this file was opened): its description stands in.
          case "image":
            return (
              <span key={index} className="text-tertiary">
                [{token.text || "image"}]
              </span>
            )
          // Raw HTML in a document is shown as the text it is, never run.
          default:
            return <Fragment key={index}>{children}</Fragment>
        }
      })}
    </>
  )
}

function Blocks({ tokens }: { tokens: Tok[] | undefined }): ReactNode {
  return (tokens ?? []).map((token, index) => {
    switch (token.type) {
      case "heading": {
        const level = Math.min(Math.max(token.depth ?? 1, 1), 6)
        const Tag = `h${level}` as "h1"
        const size = level === 1 ? "text-h1" : level === 2 ? "text-h2" : "text-label"
        return (
          <Tag key={index} className={`${size} mt-2 text-foreground`}>
            <Inline tokens={token.tokens} />
          </Tag>
        )
      }
      case "paragraph":
      case "text":
        return (
          <p key={index} className="text-body-sm text-foreground">
            {token.tokens ? <Inline tokens={token.tokens} /> : token.text}
          </p>
        )
      case "code":
        return (
          <pre key={index} className="overflow-x-auto rounded-md bg-surface-active p-3 text-code text-foreground">
            <code>{token.text}</code>
          </pre>
        )
      case "blockquote":
        return (
          <blockquote key={index} className="flex flex-col gap-2 border-l-2 border-border pl-3 text-muted-foreground">
            <Blocks tokens={token.tokens} />
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
                <div className="inline-flex flex-col gap-1 align-top">
                  <Blocks tokens={item.tokens} />
                </div>
              </li>
            ))}
          </Tag>
        )
      }
      case "table":
        return (
          <div key={index} className="overflow-x-auto">
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

/**
 * A Markdown file, formatted: headings, lists, tables, quotes and code, in
 * Hubble's own type. Built as React elements from the parsed document — the
 * file's HTML is never inserted into the page, links are limited to the web
 * and email, and pictures are not fetched.
 */
export function MarkdownViewer({ source, label }: { source: string; label: string }) {
  const tokens = new Lexer().lex(source) as unknown as Tok[]
  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto rounded-md border border-border bg-background-secondary p-4" role="document" aria-label={label} tabIndex={0} data-markdown-viewer>
      <Blocks tokens={tokens} />
    </div>
  )
}
