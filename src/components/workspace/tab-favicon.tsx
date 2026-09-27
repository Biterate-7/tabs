import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { useFaviconSrc } from "@/hooks/use-favicon-src"
import { reportFaviconBroken } from "@/lib/favicon/client"
import { avatarFallback } from "@/lib/workspace/favicon"

/**
 * A site's favicon, or its letter badge whenever there is no icon to show —
 * still resolving, no icon found, or a load that fails at render time. The
 * image is only mounted once src/lib/favicon/client.ts has verified it
 * loads, so a broken-image glyph can never appear.
 */
export function TabFavicon({ domain, size = 28 }: { domain: string; size?: number }) {
  const { letter, colorVar } = avatarFallback(domain)
  const src = useFaviconSrc(domain)

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
            if (status === "error") reportFaviconBroken(domain, src)
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
