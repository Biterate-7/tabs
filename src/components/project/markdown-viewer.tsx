"use client"

import { RichText } from "@/components/rich-text/rich-text"

export { safeHref } from "@/components/rich-text/rich-text"

/**
 * A Markdown file, formatted: headings, lists, tables, quotes, code and
 * formulas, in Hubble's own type (components/rich-text). The file's HTML is
 * never inserted into the page, links are limited to the web and email, and
 * pictures are not fetched.
 */
export function MarkdownViewer({ source, label }: { source: string; label: string }) {
  return (
    <div className="flex min-h-0 flex-1 flex-col overflow-y-auto rounded-md border border-border bg-background-secondary p-4" role="document" aria-label={label} tabIndex={0} data-markdown-viewer>
      <RichText source={source} variant="document" className="gap-3" />
    </div>
  )
}
