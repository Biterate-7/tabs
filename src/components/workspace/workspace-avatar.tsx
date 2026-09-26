import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { avatarFallback } from "@/lib/workspace/favicon"
import { cn } from "@/lib/utils"

/**
 * A workspace's visual identity, wherever it's represented (sidebar rail,
 * workspace switcher, the logo uploader's own preview): the user's uploaded
 * logo when present, falling back to the existing initial-letter badge
 * otherwise — exactly the same fallback every workspace already got before
 * this component existed. Squircle (rounded-lg), not the circular treatment
 * TabFavicon uses for per-tab favicons, so a workspace's identity reads as
 * visually distinct from a single tab's site icon.
 */
export function WorkspaceAvatar({
  workspace,
  size = 24,
  className,
}: {
  workspace: { name: string; logo?: string }
  size?: number
  className?: string
}) {
  const { letter } = avatarFallback(workspace.name)
  // A defensive `typeof` check, not just truthiness — `logo` only ever
  // reaches here from app state, but that state can originate from a
  // hand-edited localStorage value or an old export the import sanitizer
  // hasn't seen, so it isn't guaranteed to actually be a string at runtime.
  const logo = typeof workspace.logo === "string" ? workspace.logo : undefined

  return (
    // Monochrome by design: a tonal tile with the initial in ink. Identity
    // comes from the name beside it (or an uploaded logo), not from a hue.
    <Avatar
      style={{ width: size, height: size, borderRadius: Math.max(3, Math.round(size * 0.22)) }}
      className={cn("shrink-0 after:rounded-[inherit]", className)}
    >
      {logo && <AvatarImage src={logo} alt={workspace.name} className="rounded-[inherit] object-cover" />}
      <AvatarFallback
        className="rounded-[inherit] bg-surface-active font-medium text-muted-foreground"
        style={{ fontSize: Math.max(9, Math.round(size * 0.5)) }}
      >
        {letter}
      </AvatarFallback>
    </Avatar>
  )
}
