"use client"

import { useState } from "react"
import Link from "next/link"
import { PanelLeftOpen } from "lucide-react"
import { TabInput } from "@/components/tab-input"
import { ExtensionInstallGuide } from "@/components/extension-install-guide"
import { HubbleIntro } from "@/components/intro/hubble-intro"
import { IntroReveal } from "@/components/intro/intro-reveal"
import { Button, buttonVariants } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { getOnboardingState, dismissOnboarding } from "@/lib/onboarding"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { shouldPlayIntro } from "@/lib/intro"
import type { Tab } from "@/lib/tabs/types"

/** The five steps of Hubble, in order, so a first-time visitor can see the whole shape of the product before signing up for any of it. Text only and deliberately static — it sits directly under the headline, where an animation would compete with the call to action rather than support it. */
const CORE_LOOP = ["Dump", "Organize", "Explore", "Find", "Reuse"] as const

function CoreLoop() {
  return (
    <ol className="mt-5 flex flex-wrap items-center gap-x-2 gap-y-1 text-body-sm text-muted-foreground">
      {CORE_LOOP.map((step, index) => (
        <li key={step} className="flex items-center gap-2">
          {index > 0 && (
            <span aria-hidden className="text-tertiary">
              →
            </span>
          )}
          <span>{step}</span>
        </li>
      ))}
    </ol>
  )
}

export function LandingView({
  onDump,
  onOpenSidebar,
}: {
  onDump: (tabs: Tab[]) => void
  /** Opens the mobile sidebar drawer — the sidebar has no other affordance below the `md` breakpoint. Omitted in standalone/test contexts that don't render a shell around this view. */
  onOpenSidebar?: () => void
}) {
  // Lazy initializer only ever runs on a client-side render (AppShell holds
  // this component back behind its own post-mount `hydrated` gate), so
  // reading localStorage here doesn't risk an SSR hydration mismatch the
  // way reading it during a server-rendered pass would.
  const [onboarding, setOnboarding] = useState(getOnboardingState)
  // Ephemeral, not persisted: the install guide is a sub-screen of the
  // "new visitor" state, not a fourth top-level onboarding state.
  const [guideOpen, setGuideOpen] = useState(false)
  // Read once at mount, same lazy-initializer reasoning as `onboarding`
  // above. When this is false, HubbleIntro is never even mounted below —
  // not mounted-then-hidden — so a disabled intro carries no timers, no
  // audio, and no extra DOM at all.
  const [playIntro] = useState(shouldPlayIntro)

  function handleDismiss() {
    dismissOnboarding()
    setOnboarding((prev) => ({ ...prev, dismissed: true }))
    setGuideOpen(false)
  }

  const installInfo = getExtensionInstallInfo()

  const content = (
    <div className="relative flex min-h-screen flex-1 flex-col">
        {onOpenSidebar && (
          <div className="relative p-3 md:hidden">
            <IconButton aria-label="Open sidebar" tooltip="Spaces" onClick={onOpenSidebar}>
              <PanelLeftOpen />
            </IconButton>
          </div>
        )}
        {/* The reference's hero, in product scale: a left-aligned 26px
            statement, one muted sentence, quiet actions, then the one field
            that matters. Nothing decorative behind it. */}
        <main className="relative mx-auto flex w-full max-w-[640px] flex-1 flex-col px-6 pt-16 pb-16 sm:pt-[16vh]">
          {onboarding.extensionConnected ? (
            <>
              <IntroReveal order={0}>
                <h1 className="text-statement text-foreground">
                  Hubble is ready.
                </h1>
              </IntroReveal>
              <IntroReveal order={1}>
                <p className="mt-2 max-w-xl text-body text-pretty text-muted-foreground">
                  Click the Hubble extension whenever you want to dump your open tabs.
                </p>
              </IntroReveal>
            </>
          ) : onboarding.dismissed ? (
            <>
              <IntroReveal order={0}>
                <h1 className="text-statement text-foreground">
                  Your tabs are a mess.
                  <br />
                  Dump them.
                </h1>
              </IntroReveal>
              <IntroReveal order={1}>
                <p className="mt-2 max-w-xl text-body text-pretty text-muted-foreground">
                  Paste your browser tabs and turn the chaos
                   into an organized workspace.
                </p>
              </IntroReveal>
            </>
          ) : guideOpen ? (
            <IntroReveal order={0}>
              <ExtensionInstallGuide onBack={() => setGuideOpen(false)} onContinueWithoutExtension={handleDismiss} />
            </IntroReveal>
          ) : (
            <>
              <IntroReveal order={0}>
                <h1 className="text-statement text-foreground">
                  Your tabs, turned into a workspace you can see.
                </h1>
              </IntroReveal>
              <IntroReveal order={1}>
                <p className="mt-2 max-w-xl text-body text-pretty text-muted-foreground">
                  Dump every open tab in one click. Hubble sorts them into categories and lays them out as a
                  map you can explore — so the tab you saved last month is still findable.
                </p>
              </IntroReveal>

              <IntroReveal order={2}>
                <CoreLoop />
              </IntroReveal>

              <IntroReveal order={3}>
                <div className="mt-6 flex flex-wrap items-center gap-2">
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
                      Download Extension
                    </Button>
                  )}
                  <Button variant="link" size="sm" onClick={handleDismiss}>
                    Paste URLs manually
                  </Button>
                </div>
              </IntroReveal>
            </>
          )}

          <IntroReveal order={3}>
            <div className="mt-8 w-full">
              <TabInput onDump={onDump} />
            </div>
          </IntroReveal>
        </main>

        <footer className="relative mx-auto flex w-full max-w-[640px] gap-x-5 gap-y-1 px-6 pb-8 text-body-sm text-tertiary">
          <Link href="/privacy" className="rounded-xs transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            Privacy Policy
          </Link>
          <Link href="/terms" className="rounded-xs transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            Terms & Conditions
          </Link>
          <Link href="/cookies" className="rounded-xs transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60">
            Cookie Policy
          </Link>
        </footer>
      </div>
  )

  return playIntro ? <HubbleIntro>{content}</HubbleIntro> : content
}
