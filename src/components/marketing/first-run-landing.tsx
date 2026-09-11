"use client"

import { useState } from "react"
import { ExtensionInstallGuide } from "@/components/extension-install-guide"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { dismissOnboarding } from "@/lib/onboarding"
import { BrandGlyph } from "./primitives"
import { MarketingPage } from "./marketing-page"

/**
 * What `/` is for someone who has never used TabDump: the landing page, plus
 * the one sub-screen it can lead to.
 *
 * This is the only place the marketing components touch app state, and it
 * touches exactly one thing — the onboarding flag that decides whether `/`
 * shows the landing page or the app. Everything else (the workspace store,
 * persistence, auth, the extension bridge) stays behind AppShell, which is
 * still mounted above this and still receiving extension dumps: a dump that
 * arrives while the landing page is open fills the workspace, and AppShell
 * swaps to the real app on the next render without anything here noticing.
 */
export function FirstRunLanding({ onEnterApp }: { onEnterApp: () => void }) {
  const [guideOpen, setGuideOpen] = useState(false)
  const install = getExtensionInstallInfo()

  function skipOnboarding() {
    // Persisted, then reported upward: the flag is what keeps `/` on the app
    // for this visitor from now on, and the callback is what re-renders the
    // shell now rather than on the next reload.
    dismissOnboarding()
    onEnterApp()
  }

  if (guideOpen) {
    return (
      <div className="tabdump-marketing flex min-h-screen flex-col">
        <div className="flex items-center gap-2 px-6 py-5 text-foreground">
          <BrandGlyph className="size-[1.125rem]" />
          <span className="text-[0.9375rem] font-medium tracking-[-0.01em]">TabDump</span>
        </div>
        <div className="flex flex-1 items-start justify-center px-6 pt-6 pb-20">
          {/* The app's own guide, unmodified. Inside the marketing scope its
              tokens resolve to the landing palette, so it reads as the same
              surface rather than a jump back into app chrome. */}
          <ExtensionInstallGuide
            onBack={() => setGuideOpen(false)}
            onContinueWithoutExtension={skipOnboarding}
          />
        </div>
      </div>
    )
  }

  return (
    <MarketingPage
      // Never called when a Chrome Web Store listing is configured — the page
      // renders that as a real link instead. See getExtensionInstallInfo.
      onInstallExtension={() => install.mode === "download" && setGuideOpen(true)}
      onPasteTabs={skipOnboarding}
    />
  )
}
