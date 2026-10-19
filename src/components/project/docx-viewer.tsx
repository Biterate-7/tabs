"use client"

import { Fragment, useEffect, useState } from "react"
import { safeHref } from "./markdown-viewer"
import type { ReactNode } from "react"

/** Where a Word file's own pictures are shown from: only images the file carries itself. */
const DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|bmp);base64,[A-Za-z0-9+/=]+$/

const TEXT_BLOCKS: Record<string, string> = {
  p: "text-body-sm text-foreground",
  h1: "text-h1 mt-2 text-foreground",
  h2: "text-h2 mt-2 text-foreground",
  h3: "text-label mt-1 text-foreground",
  h4: "text-label mt-1 text-foreground",
  h5: "text-label text-foreground",
  h6: "text-label text-muted-foreground",
  blockquote: "border-l-2 border-border pl-3 text-muted-foreground",
}
const INLINE = new Set(["strong", "b", "em", "i", "u", "s", "del", "sup", "sub", "code"])

/**
 * Word's text as React elements, from the HTML a converter produced — kept
 * to a short list of document elements. Nothing else survives: no scripts,
 * styles, event handlers or frames, links only to the web and email, and
 * pictures only when they are embedded in the file itself.
 */
export function documentNodes(html: string): ReactNode {
  const body = new DOMParser().parseFromString(html, "text/html").body
  const walk = (parent: Node, path: string): ReactNode[] =>
    [...parent.childNodes].map((node, index) => {
      const key = `${path}.${index}`
      if (node.nodeType === Node.TEXT_NODE) return <Fragment key={key}>{node.nodeValue}</Fragment>
      if (node.nodeType !== Node.ELEMENT_NODE) return null
      const element = node as Element
      const tag = element.tagName.toLowerCase()
      const children = walk(element, key)
      if (tag in TEXT_BLOCKS) {
        const Tag = tag as "p"
        return (
          <Tag key={key} className={TEXT_BLOCKS[tag]}>
            {children}
          </Tag>
        )
      }
      if (INLINE.has(tag)) {
        const Tag = tag as "strong"
        return <Tag key={key}>{children}</Tag>
      }
      switch (tag) {
        case "br":
          return <br key={key} />
        case "ul":
        case "ol":
          return tag === "ul" ? (
            <ul key={key} className="flex list-disc flex-col gap-1 pl-5">
              {children}
            </ul>
          ) : (
            <ol key={key} className="flex list-decimal flex-col gap-1 pl-5">
              {children}
            </ol>
          )
        case "li":
          return (
            <li key={key} className="text-body-sm text-foreground marker:text-tertiary">
              {children}
            </li>
          )
        case "table":
          return (
            <div key={key} className="overflow-x-auto">
              <table className="w-full border-collapse text-body-sm">{children}</table>
            </div>
          )
        case "thead":
        case "tbody":
        case "tfoot":
        case "tr": {
          const Tag = tag as "tbody"
          return <Tag key={key}>{children}</Tag>
        }
        case "th":
        case "td": {
          const Tag = tag as "td"
          const span = (name: string) => {
            const value = Number(element.getAttribute(name))
            return Number.isInteger(value) && value > 1 && value <= 100 ? value : undefined
          }
          return (
            <Tag key={key} className="border border-border px-2 py-1 align-top text-foreground" {...(span("colspan") ? { colSpan: span("colspan")! } : {})} {...(span("rowspan") ? { rowSpan: span("rowspan")! } : {})}>
              {children}
            </Tag>
          )
        }
        case "a": {
          const href = safeHref(element.getAttribute("href") ?? undefined)
          return href ? (
            <a key={key} href={href} target="_blank" rel="noopener noreferrer nofollow" className="text-link underline-offset-4 hover:underline">
              {children}
            </a>
          ) : (
            <Fragment key={key}>{children}</Fragment>
          )
        }
        case "img": {
          const src = element.getAttribute("src") ?? ""
          // eslint-disable-next-line @next/next/no-img-element -- an image embedded in the file, shown as is
          return DATA_IMAGE.test(src) ? <img key={key} src={src} alt={element.getAttribute("alt") ?? ""} className="h-auto max-w-full" /> : null
        }
        case "script":
        case "style":
        case "iframe":
        case "object":
        case "embed":
          return null
        default:
          return <Fragment key={key}>{children}</Fragment>
      }
    })
  return <>{walk(body, "d")}</>
}

type State = { bytes: ArrayBuffer; nodes: ReactNode } | { bytes: ArrayBuffer; failed: true }

/**
 * A Word document, formatted: headings, paragraphs, bold and italic, lists,
 * tables and embedded pictures. It is a reflowed preview of the document's
 * content, not a copy of its pages — fonts, margins and page breaks are not
 * reproduced, and the reader says so.
 */
export function DocxViewer({ bytes, label, onFail }: { bytes: ArrayBuffer; label: string; onFail: () => void }) {
  const [state, setState] = useState<State | null>(null)

  useEffect(() => {
    let cancelled = false
    void import("mammoth/mammoth.browser.min.js")
      .then(({ default: mammoth }) => mammoth.convertToHtml({ arrayBuffer: bytes.slice(0) }))
      .then((result) => !cancelled && setState({ bytes, nodes: documentNodes(result.value) }))
      .catch(() => !cancelled && setState({ bytes, failed: true }))
    return () => {
      cancelled = true
    }
  }, [bytes])

  const current = state?.bytes === bytes ? state : null
  const failed = current !== null && "failed" in current
  useEffect(() => {
    if (failed) onFail()
  }, [failed, onFail])

  if (!current) return <p className="text-body-sm text-muted-foreground">Opening…</p>
  if ("failed" in current) return null
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-md border border-border bg-background-secondary">
      <p className="shrink-0 border-b border-border px-3 py-1.5 text-meta text-tertiary">Preview of the document&apos;s content · fonts and page layout aren&apos;t reproduced</p>
      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto p-4" role="document" aria-label={label} tabIndex={0} data-docx-viewer>
        {current.nodes}
      </div>
    </div>
  )
}
