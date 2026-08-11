import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { faviconUrl, avatarFallback } from "@/lib/workspace/favicon"

export function TabFavicon({ domain, size = 28 }: { domain: string; size?: number }) {
  const { letter, colorVar } = avatarFallback(domain)

  return (
    <Avatar
      style={{ width: size, height: size }}
      className="shrink-0 rounded-md after:rounded-md"
    >
      <AvatarImage src={faviconUrl(domain)} alt="" className="rounded-md" />
      <AvatarFallback
        className="rounded-md text-[0.65rem] font-semibold text-white"
        style={{ backgroundColor: `var(${colorVar})` }}
      >
        {letter}
      </AvatarFallback>
    </Avatar>
  )
}
