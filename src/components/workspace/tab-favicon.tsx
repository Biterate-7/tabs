import { useState } from "react"
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useFaviconSrc } from "@/hooks/use-favicon-src"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { reportFaviconBroken } from "@/lib/favicon/client"
import { drawablePageIcon } from "@/lib/favicon/page-icon"
import { avatarFallback } from "@/lib/workspace/favicon"

/**
 * A site's favicon, or its letter badge whenever there is no icon to show —
 * still resolving, no icon found, or a load that fails at render time.
 *
 * `icon` is the icon Chrome showed for this very page (`Tab.favicon`, see
 * src/lib/favicon/page-icon.ts). When the platform can draw it, it is tried
 * first; if it fails to load, the domain's icon from
 * src/lib/favicon/client.ts takes over, which is only mounted once it has
 * verified it loads — so a broken-image glyph can never appear.
 */
export function TabFavicon({ domain, icon, size = 28 }: { domain: string; icon?: string; size?: number }) {
  const { letter, colorVar } = avatarFallback(domain)
  const isDesktop = useIsDesktop()
  const [failedIcon, setFailedIcon] = useState<string | null>(null)
  const pageIcon = drawablePageIcon(icon, isDesktop ? "desktop" : "web")
  const direct = pageIcon && pageIcon !== failedIcon ? pageIcon : null
  // No resolver lookup while Chrome's own icon is in hand.
  const resolved = useFaviconSrc(direct ? "" : domain)
  const src = direct ?? resolved

  return (
    <Avatar
      style={{ width: size, height: size }}
      className="shrink-0 rounded-md after:rounded-md"
    >
      {src && (
        <AvatarImage
          key={src}
          src={src}
          alt=""
          referrerPolicy="no-referrer"
          className="rounded-md"
          onLoadingStatusChange={(status) => {
            if (status !== "error") return
            if (src === direct) setFailedIcon(direct)
            else reportFaviconBroken(domain, src)
          }}
        />
      )}
      <AvatarFallback
        className="rounded-md text-[0.65rem] font-medium text-white"
        style={{ backgroundColor: `var(${colorVar})` }}
      >
        {letter}
      </AvatarFallback>
    </Avatar>
  )
}
