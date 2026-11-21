import type { Metadata } from "next"
import { DownloadPage } from "@/components/marketing/download-page"
import { releaseView } from "@/lib/desktop/artifacts"
import { getLatestDesktopRelease } from "@/lib/desktop/release-source"
import { siteUrl } from "@/lib/site-url"

const TITLE = "Download Hubble"
const DESCRIPTION =
  "Download Hubble for your computer: your projects, AI conversations and notes, kept locally and searchable offline — with Hubble for Chrome as its companion."

/**
 * `/download` — website only. Server-rendered with the latest published
 * release (src/lib/desktop/release-source.ts), refreshed every few minutes,
 * so a newly published release appears here without a deploy.
 */
export const revalidate = 600

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: siteUrl("/download") },
  openGraph: {
    type: "website",
    url: siteUrl("/download"),
    siteName: "Hubble",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default async function DownloadRoute() {
  return <DownloadPage release={releaseView(await getLatestDesktopRelease())} />
}
