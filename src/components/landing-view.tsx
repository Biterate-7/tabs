"use client"

import { useState } from "react"
import { Header } from "@/components/header"
import { HeroBackground } from "@/components/hero-background"
import { TabInput } from "@/components/tab-input"
import { ExtensionInstallGuide } from "@/components/extension-install-guide"
import { Button, buttonVariants } from "@/components/ui/button"
import { getOnboardingState, dismissOnboarding } from "@/lib/onboarding"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import type { Tab } from "@/lib/tabs/types"

export function LandingView({ onDump }: { onDump: (tabs: Tab[]) => void }) {
  // Lazy initializer only ever runs on a client-side render (AppShell holds
  // this component back behind its own post-mount `hydrated` gate), so
  // reading localStorage here doesn't risk an SSR hydration mismatch the
  // way reading it during a server-rendered pass would.
  const [onboarding, setOnboarding] = useState(getOnboardingState)
  // Ephemeral, not persisted: the install guide is a sub-screen of the
  // "new visitor" state, not a fourth top-level onboarding state.
  const [guideOpen, setGuideOpen] = useState(false)

  function handleDismiss() {
    dismissOnboarding()
    setOnboarding((prev) => ({ ...prev, dismissed: true }))
    setGuideOpen(false)
  }

  const installInfo = getExtensionInstallInfo()

  return (
    <div className="relative flex min-h-screen flex-1 flex-col">
      <HeroBackground />
      <Header />
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-6 py-20 text-center sm:py-28">
        {onboarding.extensionConnected ? (
          <>
            <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
              TabDump is ready.
            </h1>
            <p className="mt-5 max-w-xl text-base text-balance text-muted-foreground sm:text-lg">
              Click the TabDump extension whenever you want to dump your open tabs.
            </p>
          </>
        ) : onboarding.dismissed ? (
          <>
            <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
              Your tabs are a mess.
              <br />
              Dump them.
            </h1>
            <p className="mt-5 max-w-xl text-base text-balance text-muted-foreground sm:text-lg">
              Paste your browser tabs and turn the chaos
              <br className="hidden sm:block" /> into an organized workspace.
            </p>
          </>
        ) : guideOpen ? (
          <ExtensionInstallGuide onBack={() => setGuideOpen(false)} onContinueWithoutExtension={handleDismiss} />
        ) : (
          <>
            <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
              Dump your Chrome tabs in one click.
            </h1>
            <p className="mt-5 max-w-xl text-base text-balance text-muted-foreground sm:text-lg">
              Install the TabDump Chrome extension to instantly bring your open tabs into TabDump.
            </p>

            <div className="mt-8 flex flex-col items-center gap-3">
              {installInfo.mode === "store" ? (
                // A real anchor, not a Button-rendered-as-anchor: this
                // genuinely navigates (to the Chrome Web Store, in a new
                // tab), so it keeps native link semantics (role="link")
                // rather than being announced as a button.
                <a
                  href={installInfo.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className={buttonVariants({ size: "lg" })}
                >
                  Install from Chrome Web Store
                </a>
              ) : (
                <Button size="lg" onClick={() => setGuideOpen(true)}>
                  Install Chrome Extension
                </Button>
              )}
              <Button variant="link" size="sm" onClick={handleDismiss}>
                Paste URLs manually
              </Button>
            </div>
          </>
        )}

        <div className="mt-10 w-full">
          <TabInput onDump={onDump} />
        </div>
      </main>
    </div>
  )
}
