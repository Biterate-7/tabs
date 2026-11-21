import type { Metadata } from "next"
import { LaunchPage } from "@/components/marketing/launch-page"
import { releaseView } from "@/lib/desktop/artifacts"
import { getLatestDesktopRelease } from "@/lib/desktop/release-source"
import { siteUrl } from "@/lib/site-url"

const TITLE = "Hubble — the desktop app for everything you learn with AI"
const DESCRIPTION =
  "Hubble is a desktop app that keeps your conversations from ChatGPT, Claude, Gemini and Perplexity in projects with the pages and notes behind them — on your computer, searchable, ready for your next AI chat."

/**
 * `/` on the website: Hubble's launch site.
 *
 * Hubble is a desktop app (src/app/page.desktop.tsx is its entry, and only
 * the desktop build has it). This page says what Hubble is and offers the
 * installer for the visitor's computer — the latest published release, read
 * from GitHub (src/lib/desktop/release-source.ts) and refreshed every few
 * minutes without a deploy.
 *
 * Server-rendered with real metadata; the release is resolved here and handed
 * to the client page as plain data.
 */
export const revalidate = 600

export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: siteUrl("/") },
  openGraph: {
    type: "website",
    url: siteUrl("/"),
    siteName: "Hubble",
    title: TITLE,
    description: DESCRIPTION,
  },
  twitter: {
    card: "summary_large_image",
    title: TITLE,
    description: DESCRIPTION,
  },
}

export default async function LaunchRoute() {
  const release = releaseView(await getLatestDesktopRelease())
  return <LaunchPage release={release} />
}
