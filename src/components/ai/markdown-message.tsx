import ReactMarkdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { stripSpuriousMarkdownEscapes } from "@/lib/markdown/unescape"

/**
 * Renders an assistant message's Markdown — headings, bold/italic, inline
 * code, code blocks, and (via remark-gfm) lists and links. react-markdown
 * never uses dangerouslySetInnerHTML and treats raw HTML in the source as
 * plain text rather than executing it (no rehype-raw plugin is installed),
 * so arbitrary HTML/script content from the model can't run here — the
 * same guarantee the previous plain-text rendering had, just with actual
 * Markdown structure on top of it instead of asterisks and hashes shown
 * literally. `target="_blank"` links still get `rel="noopener noreferrer"`
 * per the `a` override below.
 */
export function MarkdownMessage({ text }: { text: string }) {
  return (
    <div className="min-w-0 space-y-2 text-body text-foreground [&_:first-child]:mt-0 [&_:last-child]:mb-0">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          h1: ({ children }) => <h1 className="text-h1 mt-3 mb-1">{children}</h1>,
          h2: ({ children }) => <h2 className="text-h2 mt-3 mb-1">{children}</h2>,
          h3: ({ children }) => <h3 className="text-body font-semibold mt-3 mb-1">{children}</h3>,
          p: ({ children }) => <p className="whitespace-pre-wrap break-words leading-relaxed">{children}</p>,
          ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
          ol: ({ children }) => <ol className="list-decimal space-y-1 pl-5">{children}</ol>,
          li: ({ children }) => <li className="leading-relaxed">{children}</li>,
          strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
          a: ({ children, href }) => (
            <a href={href} target="_blank" rel="noopener noreferrer" className="text-accent-text underline underline-offset-2">
              {children}
            </a>
          ),
          code: ({ className, children }) => {
            // remark/rehype's convention: a fenced code block's <code> carries a
            // `language-xxx` class from the fence info string; inline code never
            // does — this is the standard way to tell them apart.
            const isBlock = Boolean(className);
            return isBlock ? (
              <code className={className}>{children}</code>
            ) : (
              <code className="rounded bg-muted px-1 py-0.5 text-meta">{children}</code>
            );
          },
          pre: ({ children }) => (
            <pre className="overflow-x-auto rounded-lg border border-subtle bg-muted p-3 text-meta">{children}</pre>
          ),
          blockquote: ({ children }) => (
            <blockquote className="border-l-2 border-subtle pl-3 text-tertiary">{children}</blockquote>
          ),
          hr: () => <hr className="border-subtle" />,
        }}
      >
        {stripSpuriousMarkdownEscapes(text)}
      </ReactMarkdown>
    </div>
  )
}
