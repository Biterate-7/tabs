"use client"

import { useId, type ReactNode } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { resolveProjectIcon, TONE_HUE, type ProjectGlyph } from "@/lib/workspace/project-icon"
import { cn } from "@/lib/utils"

/**
 * Fine-stroke glyphs on a 24-unit grid. Strokes only (plus a few filled
 * points), so they stay legible at 16px and take the gradient the tile gives
 * them. Each one is a small piece of the subject, not an illustration.
 */
const GLYPHS: Record<ProjectGlyph, ReactNode> = {
  // Orbit around an inscribed triangle: geometry as an orbital system.
  math: (
    <>
      <circle cx="12" cy="12" r="8" />
      <path d="M12 5.2 18.2 15.8H5.8Z" />
      <ellipse cx="12" cy="12" rx="8" ry="3" transform="rotate(-30 12 12)" opacity="0.55" />
      <circle cx="12" cy="5.2" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  // A pediment on columns, with a timeline rule under it.
  history: (
    <>
      <path d="M4 9.5 12 4.5l8 5Z" />
      <path d="M6.5 11.5v6M12 11.5v6M17.5 11.5v6" />
      <path d="M4 20h16" />
      <circle cx="12" cy="20" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // A terminal prompt in a window.
  code: (
    <>
      <rect x="3.5" y="5" width="17" height="14" rx="3" />
      <path d="m8 10 3 2.5L8 15" />
      <path d="M13 15h3.5" />
    </>
  ),
  // A telescope on a tripod, one star in view.
  research: (
    <>
      <path d="m4.5 12.5 10.5-5.6 1.9 3.6-10.5 5.6Z" />
      <path d="m16.4 8.2 2.3-1.2" />
      <path d="m10.8 16.2-2.1 4.3M13.5 14.7l2.3 5.8" />
      <circle cx="19.5" cy="12.5" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // An atom: three orbits, one nucleus.
  science: (
    <>
      <ellipse cx="12" cy="12" rx="8.5" ry="3.4" />
      <ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(60 12 12)" />
      <ellipse cx="12" cy="12" rx="8.5" ry="3.4" transform="rotate(120 12 12)" />
      <circle cx="12" cy="12" r="1.4" fill="currentColor" stroke="none" />
    </>
  ),
  // A double helix with its rungs.
  biology: (
    <>
      <path d="M8 3.5c0 5 8 5 8 8.5s-8 3.5-8 8.5" />
      <path d="M16 3.5c0 5-8 5-8 8.5s8 3.5 8 8.5" />
      <path d="M9 7.5h6M9 16.5h6" opacity="0.6" />
    </>
  ),
  // An open book with a spark above the spine.
  writing: (
    <>
      <path d="M12 8.5C10 6.8 7 6.5 4 7v11c3-.5 6 0 8 1.7 2-1.7 5-2.2 8-1.7V7c-3-.5-6-.2-8 1.5Z" />
      <path d="M12 8.5v11" opacity="0.6" />
      <path d="M12 2.5v2.4M10.8 3.7h2.4" />
    </>
  ),
  // Three overlapping rings: colour mixing.
  design: (
    <>
      <circle cx="9.5" cy="9.5" r="5" />
      <circle cx="14.5" cy="9.5" r="5" opacity="0.8" />
      <circle cx="12" cy="14.5" r="5" opacity="0.65" />
    </>
  ),
  // A waveform.
  music: <path d="M4 12h1.5M8 8v8M12 4.5v15M16 8.5v7M20 12h-1" />,
  // A rising line with its readings.
  business: (
    <>
      <path d="M4 18.5V5.5M4 18.5h16" opacity="0.55" />
      <path d="m7 15 3.4-4 3 2.3L19 7" />
      <circle cx="19" cy="7" r="1.2" fill="currentColor" stroke="none" />
    </>
  ),
  // A globe with a meridian and a parallel.
  world: (
    <>
      <circle cx="12" cy="12" r="8.5" />
      <ellipse cx="12" cy="12" rx="3.6" ry="8.5" />
      <path d="M3.8 9.5h16.4M3.8 14.5h16.4" opacity="0.5" />
    </>
  ),
  // A spiral arm with a bright core.
  nebula: (
    <>
      <path d="M12 12c0-1.6 2.3-1.6 2.3 0S11 15.4 9 14c-2.6-1.8-1-6 3-6.5 4.5-.6 7.5 3.6 5.5 7.5" opacity="0.9" />
      <path d="M6.6 17.6c-3-3.6-2-9 2.3-11.6" opacity="0.5" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
  // A comet with a streaming tail.
  comet: (
    <>
      <circle cx="16.5" cy="7.5" r="3" />
      <path d="m14.4 9.6-9.9 9.9M15.2 10.8 9 17M12.2 9 8.4 12.8" opacity="0.6" />
    </>
  ),
  // Stars joined into a figure.
  constellation: (
    <>
      <path d="m5 16 4.5-7 5 4L19 6" opacity="0.65" />
      <circle cx="5" cy="16" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="9.5" cy="9" r="1.1" fill="currentColor" stroke="none" />
      <circle cx="14.5" cy="13" r="1.4" fill="currentColor" stroke="none" />
      <circle cx="19" cy="6" r="1.1" fill="currentColor" stroke="none" />
    </>
  ),
  // A ringed planet.
  ringed: (
    <>
      <circle cx="12" cy="12" r="4.6" />
      <ellipse cx="12" cy="12" rx="9.5" ry="3" transform="rotate(-24 12 12)" opacity="0.7" />
    </>
  ),
  // A crescent with a companion star.
  crescent: (
    <>
      <path d="M17.5 14.6A7 7 0 1 1 9.4 5.5a5.6 5.6 0 0 0 8.1 9.1Z" />
      <path d="M17.5 4v3M16 5.5h3" />
    </>
  ),
  // Hubble's own four-point star.
  star: (
    <>
      <path d="M12 3c.7 5.1 3.9 8.3 9 9-5.1.7-8.3 3.9-9 9-.7-5.1-3.9-8.3-9-9 5.1-.7 8.3-3.9 9-9Z" />
      <circle cx="12" cy="12" r="1" fill="currentColor" stroke="none" />
    </>
  ),
}

function Glyph({ glyph, hue, size }: { glyph: ProjectGlyph; hue: number; size: number }) {
  const id = useId()
  const gradient = `${id}-g`
  // Heavier strokes on small tiles so the mark survives at 16px.
  const stroke = size <= 20 ? 1.7 : size <= 32 ? 1.5 : 1.3
  return (
    <svg viewBox="0 0 24 24" width={size} height={size} aria-hidden fill="none" strokeLinecap="round" strokeLinejoin="round" strokeWidth={stroke} className="block">
      <defs>
        <linearGradient id={gradient} x1="4" y1="3" x2="20" y2="21" gradientUnits="userSpaceOnUse">
          <stop offset="0" stopColor={`oklch(0.9 0.09 ${hue - 25})`} />
          <stop offset="1" stopColor={`oklch(0.72 0.15 ${hue + 25})`} />
        </linearGradient>
      </defs>
      <g stroke={`url(#${gradient})`} color={`oklch(0.88 0.1 ${hue})`}>
        {GLYPHS[glyph]}
      </g>
    </svg>
  )
}

/**
 * A project's visual identity, wherever it's shown: the image the user
 * uploaded when there is one, otherwise a deep-space tile carrying a glyph
 * chosen from the project's title (see resolveProjectIcon). The glyph is also
 * what shows if an uploaded image ever fails to load, so there is never a
 * broken image and never a letter tile. The tile is deliberately dark in
 * every theme: it is the one fixed "instrument" mark in the interface.
 */
export function ProjectIcon({
  workspace,
  size = 24,
  className,
}: {
  workspace: { name: string; logo?: string; brief?: { description?: string; focus?: string } }
  size?: number
  className?: string
}) {
  const brief = workspace.brief
  const context = `${typeof brief?.focus === "string" ? brief.focus : ""} ${typeof brief?.description === "string" ? brief.description : ""}`
  const { glyph, tone } = resolveProjectIcon(workspace.name, context)
  const hue = TONE_HUE[tone]
  // `logo` can come from a hand-edited store or an old export, so it is
  // only trusted if it is actually a string.
  const logo = typeof workspace.logo === "string" && workspace.logo ? workspace.logo : undefined
  const radius = Math.max(3, Math.round(size * 0.24))

  return (
    <Avatar
      data-project-icon={glyph}
      style={{ width: size, height: size, borderRadius: radius }}
      className={cn("shrink-0 after:rounded-[inherit]", className)}
    >
      {logo && <AvatarImage src={logo} alt={workspace.name} className="rounded-[inherit] object-cover" />}
      <AvatarFallback
        className="overflow-hidden rounded-[inherit]"
        style={{
          background: `radial-gradient(120% 120% at 25% 15%, oklch(0.3 0.08 ${hue}) 0%, oklch(0.17 0.035 ${hue}) 55%, oklch(0.12 0.02 ${hue}) 100%)`,
          boxShadow: `inset 0 0 0 1px oklch(0.8 0.08 ${hue} / 0.18), 0 0 ${Math.round(size * 0.5)}px -${Math.round(size * 0.2)}px oklch(0.7 0.15 ${hue} / 0.55)`,
        }}
      >
        <Glyph glyph={glyph} hue={hue} size={Math.round(size * 0.66)} />
      </AvatarFallback>
    </Avatar>
  )
}
