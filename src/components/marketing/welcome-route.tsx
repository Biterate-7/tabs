"use client"

import { useRouter } from "next/navigation"
import { useState } from "react"
import { ExtensionInstallGuide } from "@/components/extension-install-guide"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { dismissOnboarding } from "@/lib/onboarding"
import { MarketingPage } from "./marketing-page"
import { BrandGlyph } from "./primitives"

/**
 * The landing page as a standalone route (`/welcome`).
 *
 * Exists for one reason the in-app copy cannot give: this renders on the
 * server. At `/` the same page is mounted underneath AppShell, which returns
 * null until it has read localStorage — so that HTML is empty until hydration
 * and there is nothing for a crawler, a link preview, or a reader without JS
 * to see. Here the markup is in the response.
 *
 * The calls to action route into the real app rather than looping back here:
 * both of them record the onboarding choice *before* navigating, so `/`
 * resolves to the workspace rather than showing this page a second time.
 */
export function WelcomeRoute() {
  const router = useRouter()
  const [guideOpen, setGuideOpen] = useState(false)
  const install = getExtensionInstallInfo()

  function enterApp() {
    // Persisted first, navigated second — the flag is what stops `/` from
    // deciding this visitor has never used TabDump and serving the landing
    // page again.
    dismissOnboarding()
    router.push("/")
  }

  if (guideOpen) {
    return (
      <div className="tabdump-marketing flex min-h-screen flex-col">
        <div className="flex items-center gap-2 px-6 py-5 text-foreground">
          <BrandGlyph className="size-[1.125rem]" />
          <span className="text-[0.9375rem] font-medium tracking-[-0.01em]">TabDump</span>
        </div>
        <div className="flex flex-1 items-start justify-center px-6 pt-6 pb-20">
          <ExtensionInstallGuide onBack={() => setGuideOpen(false)} onContinueWithoutExtension={enterApp} />
        </div>
      </div>
    )
  }

  return (
    <MarketingPage
      // Never called when a Chrome Web Store listing is configured — the page
      // renders that as a real link instead.
      onInstallExtension={() => install.mode === "download" && setGuideOpen(true)}
      onPasteTabs={enterApp}
    />
  )
}
