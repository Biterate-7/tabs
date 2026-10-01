import type { Metadata } from "next"
import { DownloadPage } from "@/components/marketing/download-page"
import { siteUrl } from "@/lib/site-url"

const TITLE = "Download Hubble Desktop"
const DESCRIPTION =
  "Hubble Desktop connects your workspace to the AI agents already running on your computer — Claude Code, Codex, Gemini CLI and Grok Build."

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
