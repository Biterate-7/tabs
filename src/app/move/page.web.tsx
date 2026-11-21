import type { Metadata } from "next"
import { MovePage } from "@/components/marketing/move-page"
import { releaseView } from "@/lib/desktop/artifacts"
import { getLatestDesktopRelease } from "@/lib/desktop/release-source"
import { siteUrl } from "@/lib/site-url"

export const revalidate = 600

export const metadata: Metadata = {
  title: "Move your projects to Hubble Desktop",
  description: "Take the projects you made with Hubble on the web to the Hubble desktop app.",
  alternates: { canonical: siteUrl("/move") },
  robots: { index: false },
}

/** `/move` — website only: the projects the retired web app left in this browser, saved for Hubble Desktop. */
export default async function MoveRoute() {
  return <MovePage release={releaseView(await getLatestDesktopRelease())} />
}
