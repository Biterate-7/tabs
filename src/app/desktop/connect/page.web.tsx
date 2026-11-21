import type { Metadata } from "next"
import { DesktopConnectPage } from "@/components/desktop-connect/desktop-connect-page"

/**
 * `/desktop/connect` — approve Hubble Desktop for this account. Opened by the
 * desktop app (src-tauri/src/account.rs); see src/lib/auth/device.ts.
 */
export const metadata: Metadata = {
  title: "Connect Hubble Desktop",
  robots: { index: false, follow: false },
}

export default function DesktopConnectRoute() {
  return <DesktopConnectPage />
}
