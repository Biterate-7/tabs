import type { Metadata } from "next"
import { WelcomeRoute } from "@/components/marketing/welcome-route"
import { siteUrl } from "@/lib/site-url"

const TITLE = "Hubble — one workspace for everything you learn with AI"
const DESCRIPTION =
  "Save conversations from ChatGPT, Claude, Gemini and Perplexity into projects with the pages and notes behind them, find them later, and bring the right parts into your next AI chat."

/**
 * The server-rendered landing page.
 *
 * `/` shows the same page to a first-time visitor, but it does so from inside
 * AppShell — which renders nothing until it has read localStorage, so that
 * route's HTML is empty until hydration. This route has no such dependency:
 * MarketingPage reads one environment variable and otherwise renders from
 * static data, so the whole page is in the server response with real metadata
 * attached. That makes this the URL worth sharing and the one worth indexing.
 */
export const metadata: Metadata = {
  title: TITLE,
  description: DESCRIPTION,
  alternates: { canonical: siteUrl("/welcome") },
  openGraph: {
    type: "website",
    url: siteUrl("/welcome"),
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

export default function WelcomePage() {
  return <WelcomeRoute />
}
