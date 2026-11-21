"use client"

import type { CSSProperties } from "react"
import Link from "next/link"
import { ArrowRight, Globe, Monitor, ShieldCheck } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import type { ReleaseView } from "@/lib/desktop/artifacts"
import { BrowserDataNotice } from "./browser-data-notice"
import { DownloadCta, ReleaseLine } from "./download-cta"
import { RevealSection, revealStep } from "./reveal"
import { CaptureDemo } from "./showcase/capture-demo"
import { HandoffDemo } from "./showcase/handoff-demo"
import { HeroDemo } from "./showcase/hero-demo"
import { ReviewDemo } from "./showcase/review-demo"
import { SearchDemo } from "./showcase/search-demo"
import { DesktopVisual, ExtensionVisual, LoopBand, SurfaceCard, WorksWith } from "./showcase/sections"
import { CHROME_SECTION_HREF, Container, FeatureSection, MoreLink, SiteFooter, SiteHeader, Stage, type PrimaryAction } from "./site"

export type LaunchPageProps = {
  /** The latest published Hubble Desktop release, or null when there is none to offer. */
  release: ReleaseView | null
}

/** Said wherever the page shows AI connectors: they need an account, and accounts are not switched on yet (docs/release-notes/0.2.0.md). */
export const CONNECTORS_AVAILABILITY = "AI connectors need a Hubble account. Signing in arrives in an update — no new download needed."

/**
 * Hubble's launch site: the control layer for your work with AI. Hubble is
 * a desktop app; Hubble for Chrome is its companion; this page is where you
 * get both.
 *
 * Led by the product rather than by paragraphs: every section is a Hubble
 * window running over a fixed sample project, and nothing is claimed that
 * the product does not do. The windows run the product's own search, context
 * and proposal-wording code; the rows of apps read the provider registry;
 * what is not available yet says so; and nothing on the page reads or
 * writes anyone's data.
 */
export function LaunchPage({ release }: LaunchPageProps) {
  const install = getExtensionInstallInfo()
  const installAction: PrimaryAction =
    install.mode === "store" ? { label: "Hubble for Chrome", href: install.url } : { label: "Hubble for Chrome", href: CHROME_SECTION_HREF }
  const extensionLink = (
    <MoreLink href={installAction.href} external={install.mode === "store"}>
      Get Hubble for Chrome
    </MoreLink>
  )

  return (
    <div id="hubble-marketing" className="tabdump-marketing min-h-screen">
      <SiteHeader install={installAction} />
      <BrowserDataNotice />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-[clamp(3.5rem,2rem+6vw,8rem)] pb-[calc(var(--hb-v)*2)]">
          <Container>
            <p className="m-small m-intro text-muted-foreground" style={step(0)}>
              Hubble Desktop
            </p>
            <h1 className="m-hero m-intro mt-4 max-w-[880px] text-foreground" style={step(1)}>
              Hubble is the control layer for your work with AI.
            </h1>
            <p className="m-lede m-intro mt-5 max-w-[560px] text-muted-foreground" style={step(2)}>
              An app for your computer that keeps your AI conversations, research and browser context in one workspace. Hand any AI the context it needs — and review what it does.
            </p>
            <div className="m-intro mt-8 flex flex-wrap items-center gap-2.5" style={step(3)}>
              <DownloadCta release={release} />
              <a href="#desktop-and-chrome" className={buttonVariants({ variant: "secondary", size: "hero" })}>
                How it works with Chrome
              </a>
            </div>
            <div className="m-intro" style={step(4)}>
              <ReleaseLine release={release} className="mt-3" />
            </div>
            <div className="m-intro-stage mt-12 sm:mt-16">
              <HeroDemo />
              <p className="m-small mt-4 text-tertiary">A sample project. Nothing on this page reads or stores your data. {CONNECTORS_AVAILABILITY}</p>
            </div>
          </Container>
        </section>

        {/* ---- Works with --------------------------------------------------- */}
        <RevealSection className="m-page pt-[calc(var(--hb-v)*2)] pb-[calc(var(--hb-v)*3)]">
          <Container>
            <h2 className="m-small m-reveal-item text-center text-foreground" style={revealStep(0)}>
              Works with the AI apps you already use
            </h2>
            <div className="m-reveal-item mt-6" style={revealStep(1)}>
              <WorksWith />
            </div>
          </Container>
        </RevealSection>

        {/* ---- Desktop + Chrome ------------------------------------------------ */}
        <RevealSection id="desktop-and-chrome" className="m-page scroll-mt-(--hb-header-h) pb-[var(--hb-section-y)]">
          <Container>
            <h2 className="m-h2 m-reveal-item m-reveal-text max-w-[760px] text-foreground" style={revealStep(0)}>
              The app is Hubble. Chrome is how your browser reaches it.
            </h2>
            <p className="m-lede m-reveal-item m-reveal-text mt-4 max-w-[600px] text-muted-foreground" style={revealStep(1)}>
              Hubble Desktop holds your projects and works on its own. Hubble for Chrome is a small companion: it saves the AI conversation or tabs you choose straight into the app on the same computer.
            </p>
            <div className="m-reveal-item mt-10 grid gap-2.5 md:grid-cols-2" style={revealStep(2)}>
              <SurfaceCard title="Hubble Desktop" body="Your projects, conversations and notes, in an app of their own on your computer." link={<MoreLink href="/download">All platforms</MoreLink>}>
                <DesktopVisual />
              </SurfaceCard>
              <SurfaceCard title="Hubble for Chrome" body="Save the conversation on screen, any page, or your open tabs as a session — straight into the app." link={extensionLink}>
                <ExtensionVisual />
              </SurfaceCard>
            </div>
            <ol aria-label="How Hubble for Chrome reaches Hubble Desktop" className="m-reveal-item mt-10 grid gap-x-10 gap-y-6 border-t border-subtle pt-8 md:grid-cols-3" style={revealStep(3)}>
              {COMPANION.map(({ icon: Icon, title, body }) => (
                <li key={title}>
                  <Icon aria-hidden className="size-4 text-tertiary" />
                  <h3 className="m-body mt-3 text-foreground">{title}</h3>
                  <p className="m-body text-muted-foreground">{body}</p>
                </li>
              ))}
            </ol>
            <div className="m-reveal-item mt-6" style={revealStep(4)}>
              <MoreLink href="/download#how-they-connect">How they connect</MoreLink>
            </div>
          </Container>
        </RevealSection>

        {/* ---- Showcases ------------------------------------------------------ */}
        <FeatureSection
          id="capture"
          title="Rebuild your context in one place."
          body="Save conversations from every AI app with the pages, PDFs and notes behind them — each one keeps where it came from."
          link={extensionLink}
          stage={
            <Stage>
              <CaptureDemo />
            </Stage>
          }
        />
        <FeatureSection
          id="find"
          reverse
          title="Find it, whichever AI said it."
          body="One search across every conversation, page and note, opened at the passage that matched."
          stage={
            <Stage>
              <SearchDemo />
            </Stage>
          }
        />
        <FeatureSection
          id="reuse"
          title="Hand off with the full picture."
          body="Hubble writes up what you choose for any AI app, quoted with sources. You decide when it's sent."
          link={<MoreLink href="/download">Download Hubble</MoreLink>}
          stage={
            <Stage>
              <HandoffDemo />
            </Stage>
          }
        />
        <FeatureSection
          id="agents"
          reverse
          title="Agents act. You approve."
          body="Connected AI apps save notes and propose changes. Nothing is reorganised until you approve it."
          link={<p className="m-small max-w-[360px] text-tertiary">{CONNECTORS_AVAILABILITY}</p>}
          stage={
            <Stage>
              <ReviewDemo />
            </Stage>
          }
        />

        {/* ---- The loop ------------------------------------------------------ */}
        <RevealSection id="how-it-works" className="m-section m-page scroll-mt-(--hb-header-h)">
          <Container>
            <div className="flex flex-col items-center text-center">
              <h2 className="m-h2 m-reveal-item m-reveal-text max-w-[760px] text-foreground" style={revealStep(0)}>
                Your work stays on your computer. Hubble runs the loop.
              </h2>
              <p className="m-lede m-reveal-item m-reveal-text mt-4 max-w-[560px] text-muted-foreground" style={revealStep(1)}>
                Workspace, context, agent, action, review — and back, with nothing to rebuild from memory.
              </p>
            </div>
            <div className="m-reveal-item mt-12 sm:mt-16" style={revealStep(2)}>
              <LoopBand />
            </div>
            <ul className="m-reveal-item mt-14 grid gap-x-10 gap-y-6 border-t border-subtle pt-8 md:grid-cols-3" style={revealStep(3)}>
              {PRINCIPLES.map((principle) => (
                <li key={principle.title}>
                  <h3 className="m-body text-foreground">{principle.title}</h3>
                  <p className="m-body text-muted-foreground">{principle.body}</p>
                </li>
              ))}
            </ul>
          </Container>
        </RevealSection>

        {/* ---- Changelog ----------------------------------------------------- */}
        <RevealSection id="changelog" className="m-page scroll-mt-(--hb-header-h) pb-[var(--hb-section-y)]">
          <Container>
            <h2 className="m-title m-reveal-item text-foreground" style={revealStep(0)}>
              Changelog
            </h2>
            <ul className="m-reveal-item mt-6 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4" style={revealStep(1)}>
              {CHANGELOG.map((entry) => (
                <li key={entry.title} className="m-tile min-h-[108px] px-[17.5px] pt-[15.9px] pb-5">
                  <p className="m-body text-tertiary">{entry.date}</p>
                  <p className="m-body text-foreground">{entry.title}</p>
                </li>
              ))}
            </ul>
          </Container>
        </RevealSection>

        {/* ---- Closing -------------------------------------------------------- */}
        <RevealSection className="m-page pt-[calc(var(--hb-section-y)*1.6)] pb-[calc(var(--hb-section-y)*2.2)]">
          <Container className="flex flex-col items-center text-center">
            <h2 className="m-cta m-reveal-item m-reveal-text text-balance text-foreground" style={revealStep(0)}>
              Get Hubble for your computer.
            </h2>
            <div className="m-reveal-item mt-8 flex flex-wrap justify-center gap-2.5" style={revealStep(1)}>
              <DownloadCta release={release} />
              <Link href="/download" className={buttonVariants({ variant: "secondary", size: "hero" })}>
                All platforms
                <ArrowRight aria-hidden />
              </Link>
            </div>
            <div className="m-reveal-item" style={revealStep(2)}>
              <ReleaseLine release={release} className="mt-3" />
            </div>
          </Container>
        </RevealSection>
      </main>

      <SiteFooter />
    </div>
  )
}

function step(index: number): CSSProperties {
  return { "--m-step": index } as CSSProperties
}

/** How the companion reaches the app — the pairing as it actually works (docs/desktop-architecture.md). */
const COMPANION: { title: string; body: string; icon: typeof Globe }[] = [
  { title: "Save in Chrome", body: "On an AI app's page, or with tabs you want to keep, choose Save to Hubble in the extension.", icon: Globe },
  { title: "Paired on this computer", body: "The extension talks only to the Hubble app on the same computer, once you approve it in the app. Nothing passes through a server.", icon: ShieldCheck },
  { title: "Kept until Hubble is open", body: "If the app isn't running, the extension keeps what you saved and delivers it when Hubble starts.", icon: Monitor },
]

const PRINCIPLES: { title: string; body: string }[] = [
  { title: "On your computer", body: "Projects, conversations and notes are kept by the app on your computer and open without a network." },
  { title: "Only what you choose", body: "Hubble saves when you ask, never signs in to your AI accounts, and sends nothing for you unless you turn that on." },
  { title: "Honest about sources", body: "Every item keeps where it came from. AI answers are marked as AI answers." },
]

// The project's own history, newest first — merged releases, in their own words.
const CHANGELOG = [
  { date: "Nov 19, 2026", title: "Hubble is a desktop app; Hubble for Chrome pairs with it and saves straight into it" },
  { date: "Nov 8, 2026", title: "Conversation intelligence: decisions and links across your conversations, on your device" },
  { date: "Oct 30, 2026", title: "Smart Save, Organize and Resume" },
  { date: "Oct 19, 2026", title: "Use in AI: bring chosen context into a new ChatGPT, Claude, Gemini or Perplexity chat" },
]
