"use client"

import { aiProviderName, isAiProviderId } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import type { AiProviderId } from "@/lib/providers/registry"

/**
 * An AI app's logo, and its name beside it.
 *
 * The logos are the supplied official artwork (brand/providers/, resized for
 * the UI by scripts/build-provider-logos.mjs into public/brand/providers/) —
 * never redrawn, and never recoloured except as noted below. The name always
 * travels with the logo (`ProviderBadge`), so it is decorative unless given a
 * `title`.
 */

type Logo = {
  src: string
  /**
   * How much of the box the file fills. The files differ — the ChatGPT knot
   * has its own margin, the Claude and Perplexity tiles are solid squares
   * that read heavier at the same size — so this evens out how large each one
   * looks, not how many pixels it covers.
   */
  fill: number
  /**
   * A one-colour logo supplied in black: drawn as a mask in the theme's
   * foreground colour so it stays visible on dark themes. Every other logo is
   * shown exactly as supplied.
   */
  mono?: boolean
  /** The supplied file is a square tile; round its corners to sit beside the Claude tile. */
  round?: boolean
}

const LOGOS: Record<AiProviderId, Logo> = {
  chatgpt: { src: "/brand/providers/chatgpt.png", fill: 1, mono: true },
  claude: { src: "/brand/providers/claude.png", fill: 1 },
  gemini: { src: "/brand/providers/gemini.png", fill: 1 },
  perplexity: { src: "/brand/providers/perplexity.png", fill: 1, round: true },
}

/** The supplied logo for an AI app, for surfaces that paint it themselves (the graph's canvas). */
export function providerLogo(provider: string | null | undefined): Readonly<Logo> | undefined {
  return isAiProviderId(provider) ? LOGOS[provider] : undefined
}

/**
 * The provider's logo in a `size`px box. A provider this build does not know
 * draws nothing — never another provider's logo.
 */
export function ProviderMark({ provider, size = 14, title, className }: { provider: string | null | undefined; size?: number; title?: string; className?: string }) {
  if (!isAiProviderId(provider)) return null
  const logo = LOGOS[provider]
  const inner = Math.round(size * logo.fill * 100) / 100
  return (
    <span
      className={cn("inline-flex shrink-0 items-center justify-center select-none", className)}
      style={{ width: size, height: size }}
      data-provider-logo={provider}
      {...(title ? { role: "img", "aria-label": title } : { "aria-hidden": true })}
    >
      {logo.mono ? (
        <span
          className="block bg-foreground"
          style={{
            width: inner,
            height: inner,
            maskImage: `url(${logo.src})`,
            WebkitMaskImage: `url(${logo.src})`,
            maskSize: "contain",
            WebkitMaskSize: "contain",
            maskRepeat: "no-repeat",
            WebkitMaskRepeat: "no-repeat",
            maskPosition: "center",
            WebkitMaskPosition: "center",
          }}
        />
      ) : (
        // A plain <img>: the static desktop export has no image optimizer, and
        // these 128px files are already sized for the UI.
        // eslint-disable-next-line @next/next/no-img-element
        <img src={logo.src} alt="" width={inner} height={inner} draggable={false} className={cn("object-contain", logo.round && "rounded-[22%]")} />
      )}
    </span>
  )
}

/** The logo and the name, as one quiet chip: "ChatGPT" with its logo before it. */
export function ProviderBadge({ provider, className }: { provider: AiProviderId; className?: string }) {
  return (
    <span className={cn("inline-flex min-w-0 items-center gap-1 text-meta text-muted-foreground", className)} data-provider={provider}>
      <ProviderMark provider={provider} size={12} />
      <span className="truncate">{aiProviderName(provider)}</span>
    </span>
  )
}
