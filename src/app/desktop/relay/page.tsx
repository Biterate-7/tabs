import type { Metadata } from "next"
import { DesktopRelayPage } from "@/components/desktop-relay/desktop-relay-page"

/**
 * `/desktop/relay` — Hubble Desktop asking Chrome for open tabs or history,
 * answered with the person's say-so. See src/components/desktop-relay.
 */
export const metadata: Metadata = {
  title: "Hubble Desktop is asking Chrome",
  robots: { index: false, follow: false },
}

export default function DesktopRelayRoute() {
  return <DesktopRelayPage />
}
