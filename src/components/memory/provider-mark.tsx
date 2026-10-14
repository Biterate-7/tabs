"use client"

import { aiProviderName } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import type { AiProviderId } from "@/lib/providers/registry"

/**
 * An AI app's mark, and its name beside it.
 *
 * Every mark here is an **original geometric device** drawn for Hubble —
 * none reproduces a provider's logo or wordmark. Each only has to be told
 * apart at 14px, and the name always travels with it (\`ProviderBadge\`),
 * so the mark is decorative unless given a title.
 */

type MarkProps = { size?: number; title?: string; className?: string }

function Mark({ size = 14, title, className, children }: MarkProps & { children: React.ReactNode }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.7}
      strokeLinecap="round"
      strokeLinejoin="round"
      className={cn("shrink-0", className)}
      {...(title ? { role: "img" } : { "aria-hidden": true, focusable: false })}
    >
      {title ? <title>{title}</title> : null}
      {children}
    </svg>
  )
}

/** ChatGPT: a lattice cell — a hexagon holding its own centre. */
function ChatGptMark(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M12 3.2 19.6 7.6v8.8L12 20.8 4.4 16.4V7.6Z" />
      <path d="M12 8.4 15.8 10.6v4.4L12 17.2 8.2 15V10.6Z" />
    </Mark>
  )
}

/** Claude: an open ring around a point. */
function ClaudeMark(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M17.4 6.2a8 8 0 1 0 2.4 7.3" />
      <circle cx={12} cy={12} r={2.2} fill="currentColor" stroke="none" />
      <circle cx={19.4} cy={5.6} r={1.9} fill="currentColor" stroke="none" />
    </Mark>
  )
}

/** Gemini: twin diamonds. */
function GeminiMark(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M9 3.6 14.4 12 9 20.4 3.6 12Z" />
      <path d="M15.6 7.2 20.4 12l-4.8 4.8L10.8 12Z" />
    </Mark>
  )
}

/** Perplexity: a compass rose — four arms from one centre. */
function PerplexityMark(props: MarkProps) {
  return (
    <Mark {...props}>
      <path d="M12 3v18M3 12h18" />
      <path d="M6.6 6.6 12 12l5.4-5.4M6.6 17.4 12 12l5.4 5.4" />
    </Mark>
  )
}

const MARKS: Record<AiProviderId, (props: MarkProps) => React.ReactElement> = {
  chatgpt: ChatGptMark,
  claude: ClaudeMark,
  gemini: GeminiMark,
  perplexity: PerplexityMark,
}

export function ProviderMark({ provider, size, title, className }: MarkProps & { provider: AiProviderId }) {
  const Component = MARKS[provider]
  return <Component size={size} {...(title ? { title } : {})} {...(className ? { className } : {})} />
}

/** The mark and the name, as one quiet chip: "◇ ChatGPT". */
export function ProviderBadge({ provider, className }: { provider: AiProviderId; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-meta text-muted-foreground", className)} data-provider={provider}>
      <ProviderMark provider={provider} size={12} />
      <span className="truncate">{aiProviderName(provider)}</span>
    </span>
  )
}
