"use client"

import type { CSSProperties } from "react"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { RevealSection, revealStep } from "./reveal"
import { CaptureDemo } from "./showcase/capture-demo"
import { HandoffDemo } from "./showcase/handoff-demo"
import { HeroDemo } from "./showcase/hero-demo"
import { ReviewDemo } from "./showcase/review-demo"
import { SearchDemo } from "./showcase/search-demo"
import { ConnectorsVisual, DesktopVisual, ExtensionVisual, LoopBand, SurfaceCard, WorksWith } from "./showcase/sections"
import { Container, FeatureSection, HeroActions, MoreLink, SiteFooter, SiteHeader, Stage, useDesktopLink, type PrimaryAction } from "./site"

export type MarketingPageProps = {
  /** Opens the in-page install guide when the extension is a download. */
  onInstallExtension: () => void
  /** Enters the app. */
  onPasteTabs: () => void
  /** Enters the app at Settings → AI connectors. Without it, the connector links are not shown. */
  onOpenConnectors?: () => void
}

/**
 * Hubble's public page: the control layer for work with AI.
 *
 * Led by the product rather than by paragraphs: every section is a Hubble
 * window running over a fixed sample project, and nothing is claimed that the
 * product does not do. The windows run the product's own search, context and
 * proposal-wording code; the rows of apps read the provider registry; and
 * nothing on the page reads or writes anyone's data.
 */
export function MarketingPage({ onInstallExtension, onPasteTabs, onOpenConnectors }: MarketingPageProps) {
  const install = getExtensionInstallInfo()
  const installAction: PrimaryAction = install.mode === "store" ? { label: "Hubble for Chrome", href: install.url } : { label: "Hubble for Chrome", onClick: onInstallExtension }
  // Hubble Desktop — absent inside the desktop app itself.
  const desktopLink = useDesktopLink()
  const extensionLink = installAction.href ? (
    <MoreLink href={installAction.href} external>
      Get Hubble for Chrome
    </MoreLink>
  ) : (
    <MoreLink onClick={onInstallExtension}>Get Hubble for Chrome</MoreLink>
  )

  return (
    <div id="hubble-marketing" className="tabdump-marketing min-h-screen">
      <SiteHeader install={installAction} onOpenApp={onPasteTabs} />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-[clamp(3.5rem,2rem+6vw,8rem)] pb-[calc(var(--hb-v)*2)]">
          <Container>
            <h1 className="m-hero m-intro max-w-[880px] text-foreground" style={step(0)}>
              Hubble is the control layer for your work with AI.
            </h1>
            <p className="m-lede m-intro mt-5 max-w-[540px] text-muted-foreground" style={step(1)}>
              Your conversations, research and browser context in one workspace on your device. Hand any AI the context it needs — and review what it does.
            </p>
            <div className="m-intro mt-8" style={step(2)}>
              <HeroActions onOpenApp={onPasteTabs} exploreHref="#how-it-works" secondary={desktopLink} />
            </div>
            <div className="m-intro-stage mt-12 sm:mt-16">
              <HeroDemo />
              <p className="m-small mt-4 text-tertiary">A sample project. Nothing on this page reads or stores your data.</p>
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
          link={<MoreLink onClick={onPasteTabs}>Open Hubble</MoreLink>}
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
          link={onOpenConnectors ? <MoreLink onClick={onOpenConnectors}>Set up AI connectors</MoreLink> : undefined}
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
                Your work stays on your device. Hubble runs the loop.
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

        {/* ---- Everywhere ------------------------------------------------------ */}
        <RevealSection id="everywhere" className="m-page scroll-mt-(--hb-header-h) pb-[var(--hb-section-y)]">
          <Container>
            <h2 className="m-title m-reveal-item text-foreground" style={revealStep(0)}>
              Everywhere you work
            </h2>
            <div className="m-reveal-item mt-6 grid gap-2.5 md:grid-cols-3" style={revealStep(1)}>
              <SurfaceCard title="Hubble for Chrome" body="Save the conversation on screen, any page, or your open tabs as a session." link={extensionLink}>
                <ExtensionVisual />
              </SurfaceCard>
              <SurfaceCard
                title="Hubble Desktop"
                body="Your projects in an app of their own, on your computer."
                link={desktopLink ? <MoreLink href={desktopLink.href}>{desktopLink.label}</MoreLink> : undefined}
              >
                <DesktopVisual />
              </SurfaceCard>
              <SurfaceCard
                title="AI connectors"
                body="Your synced projects, readable by the AI apps you connect — on the permission you choose."
                link={onOpenConnectors ? <MoreLink onClick={onOpenConnectors}>Set up AI connectors</MoreLink> : undefined}
              >
                <ConnectorsVisual />
              </SurfaceCard>
            </div>
          </Container>
        </RevealSection>

        {/* ---- Changelog ----------------------------------------------------- */}
        <RevealSection id="changelog" className="m-page scroll-mt-(--hb-header-h) pt-[var(--hb-section-y)] pb-[var(--hb-section-y)]">
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
            <h2 className="m-cta m-reveal-item m-reveal-text text-foreground" style={revealStep(0)}>
              Try Hubble now.
            </h2>
            <div className="m-reveal-item mt-8" style={revealStep(1)}>
              <HeroActions onOpenApp={onPasteTabs} exploreHref="#how-it-works" secondary={desktopLink} className="justify-center" />
            </div>
          </Container>
        </RevealSection>
      </main>

      <SiteFooter onOpenApp={onPasteTabs} install={installAction} />
    </div>
  )
}

function step(index: number): CSSProperties {
  return { "--m-step": index } as CSSProperties
}

const PRINCIPLES: { title: string; body: string }[] = [
  { title: "Local first", body: "Projects, conversations and notes live on your device. Sign in only to sync them." },
  { title: "Only what you choose", body: "Hubble saves when you ask, and sends nothing for you unless you turn that on." },
  { title: "Honest about sources", body: "Every item keeps where it came from. AI answers are marked as AI answers." },
]

// The project's own history, newest first — merged releases, in their own words.
const CHANGELOG = [
  { date: "Nov 8, 2026", title: "Conversation intelligence: decisions and links across your conversations, on your device" },
  { date: "Oct 30, 2026", title: "Smart Save, Organize and Resume" },
  { date: "Oct 28, 2026", title: "Hubble Desktop 0.2: sign in, sync, and a relay from Chrome" },
  { date: "Oct 19, 2026", title: "Use in AI: bring chosen context into a new ChatGPT, Claude, Gemini or Perplexity chat" },
]
