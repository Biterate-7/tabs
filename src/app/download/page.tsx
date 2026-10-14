import type { Metadata } from "next"
import { DownloadPage } from "@/components/marketing/download-page"
import { siteUrl } from "@/lib/site-url"

const TITLE = "Download Hubble Desktop"
const DESCRIPTION =
  "Hubble as an app on your computer: your projects, AI conversations and notes, kept locally and searchable offline."

/**
 * `/download` — server-rendered like `/welcome`, so the page and its
 * metadata are in the response. Whether there is anything to download is
 * decided by src/lib/desktop/release.ts, never by the request.
 */
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

export default function DownloadRoute() {
  return <DownloadPage />
}
