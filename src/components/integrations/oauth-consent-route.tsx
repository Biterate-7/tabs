import type { Metadata } from "next"
import { AuthProvider } from "@/components/auth/auth-provider"
import { OAuthConsent } from "./oauth-consent"

/**
 * The /oauth/authorize route's page — Hubble's OAuth authorization endpoint.
 *
 * Mounted from src/app/oauth/authorize/page.ts, a `.ts` re-export, so the
 * desktop static export (`pageExtensions: ["tsx"]`) never contains it: the
 * packaged app has no server to answer the page's requests, and an
 * authorization endpoint that cannot authorize must not exist there.
 */
export const metadata: Metadata = {
  title: "Connect an AI client — Hubble",
  robots: { index: false, follow: false },
}

export default function OAuthAuthorizePage() {
  return (
    <AuthProvider>
      <OAuthConsent />
    </AuthProvider>
  )
}
