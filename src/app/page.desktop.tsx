import { AppRoot } from "@/components/app-root"
import { DesktopOnlyGate } from "@/components/desktop-only-gate"
import { siteUrl } from "@/lib/site-url"

/**
 * `/` in Hubble Desktop: the app itself. Only the desktop build has this page
 * (next.config.ts picks `*.desktop.tsx` there and `*.web.tsx` on the website).
 * Opened outside Hubble Desktop, a production build points to the download.
 */
export default function Home() {
  return (
    <DesktopOnlyGate downloadUrl={siteUrl("/download")}>
      <AppRoot />
    </DesktopOnlyGate>
  )
}
