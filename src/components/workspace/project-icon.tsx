"use client"

import { BookOpen, CodeXml, Dna, Folder, FlaskConical, Globe, Landmark, Music, Palette, Sigma, Telescope, TrendingUp, type LucideIcon } from "lucide-react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { resolveProjectIcon, type ProjectGlyph } from "@/lib/workspace/project-icon"
import { cn } from "@/lib/utils"

/** One plain outline glyph per subject; anything unrecognised is a folder. */
const GLYPHS: Record<ProjectGlyph, LucideIcon> = {
  math: Sigma,
  history: Landmark,
  code: CodeXml,
  research: Telescope,
  science: FlaskConical,
  biology: Dna,
  writing: BookOpen,
  design: Palette,
  music: Music,
  business: TrendingUp,
  world: Globe,
  folder: Folder,
}

/**
 * A project's mark, wherever it's shown: the image the user uploaded when
 * there is one, otherwise a quiet outline glyph chosen from the project's
 * title (see resolveProjectIcon). No tile, no tint — the glyph takes its
 * colour from the text around it (muted by default) so it sits beside a label
 * like any other icon. The glyph is also what shows if an uploaded image ever
 * fails to load, so there is never a broken image.
 *
 * `size` is the box; the glyph itself never grows past 20px, so a large box
 * (a header) gives a little air rather than a bigger symbol.
 */
export function ProjectIcon({
  workspace,
  size = 16,
  className,
}: {
  workspace: { name: string; logo?: string; brief?: { description?: string; focus?: string } }
  size?: number
  className?: string
}) {
  const brief = workspace.brief
  const context = `${typeof brief?.focus === "string" ? brief.focus : ""} ${typeof brief?.description === "string" ? brief.description : ""}`
  const { glyph } = resolveProjectIcon(workspace.name, context)
  const Glyph = GLYPHS[glyph]
  const glyphSize = Math.min(size, 20)
  // `logo` can come from a hand-edited store or an old export, so it is
  // only trusted if it is actually a string.
  const logo = typeof workspace.logo === "string" && workspace.logo ? workspace.logo : undefined

  const mark = <Glyph aria-hidden width={glyphSize} height={glyphSize} className="shrink-0" />
  if (!logo) {
    return (
      <span
        data-project-icon={glyph}
        style={{ width: size, height: size }}
        className={cn("inline-flex shrink-0 items-center justify-center text-muted-foreground", className)}
      >
        {mark}
      </span>
    )
  }
  return (
    <Avatar
      data-project-icon={glyph}
      style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.2)) }}
      className={cn("shrink-0 after:rounded-[inherit]", className)}
    >
      <AvatarImage src={logo} alt={workspace.name} className="rounded-[inherit] object-cover" />
      <AvatarFallback className="rounded-[inherit] bg-transparent text-muted-foreground">{mark}</AvatarFallback>
    </Avatar>
  )
}
