"use client"

import type { ReactNode } from "react"
import Link from "next/link"
import { ArrowRight, Eye, Globe, Laptop, MessageSquareShare, MessagesSquare, Monitor, Search, ShieldCheck, Waypoints } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { ProviderMark } from "@/components/memory/provider-mark"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import type { ReleaseView } from "@/lib/desktop/artifacts"
import { AI_PROVIDERS, AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { AppThemeStyle } from "./app-theme"
import { CaptureIllustration, KnowledgeIllustration, ReuseIllustration, SearchIllustration } from "./memory-illustrations"
import { RevealSection, revealStep } from "./reveal"
import { BrowserDataNotice } from "./browser-data-notice"
import { DownloadCta, ReleaseLine } from "./download-cta"
import { CHROME_SECTION_HREF, Container, FeatureSection, MoreLink, SiteFooter, SiteHeader, Stage, useMarketingScheme, type PrimaryAction } from "./site"

export type LaunchPageProps = {
  /** The latest published Hubble Desktop release, or null when there is none to offer. */
  release: ReleaseView | null
}

const ROOT_ID = "hubble-marketing"

const LOOP = [
  { icon: MessagesSquare, title: "Capture", body: "Save conversations from ChatGPT, Claude, Gemini and Perplexity, and the pages, PDFs, videos and notes behind them." },
  { icon: Waypoints, title: "Connect", body: "Keep them in projects. See what relates to what, and where every piece came from." },
  { icon: Search, title: "Find", body: "Search everything you saved, whichever AI app it came from." },
  { icon: MessageSquareShare, title: "Reuse", body: "Bring the parts you choose into your next AI chat — quoted, with their sources." },
] as const

/**
 * Hubble's launch site. Hubble is a desktop app; Hubble for Chrome is its
 * companion; this page is where you get both.
 *
 * Nothing is claimed that the product does not do. The "works with" row reads
 * the provider registry, so it says exactly what Hubble can do with each AI
 * app; the illustrations run the product's own search and context code over
 * a fixed sample project and touch no one's data.
 */
export function LaunchPage({ release }: LaunchPageProps) {
  const install = getExtensionInstallInfo()
  const installAction: PrimaryAction =
    install.mode === "store" ? { label: "Hubble for Chrome", href: install.url } : { label: "Hubble for Chrome", href: CHROME_SECTION_HREF }
  const [scheme, setScheme] = useMarketingScheme(ROOT_ID)
  const extensionLink = (
    <MoreLink href={installAction.href} external={install.mode === "store"}>
      Get Hubble for Chrome
    </MoreLink>
  )

  return (
    <div id={ROOT_ID} className="tabdump-marketing min-h-screen">
      <AppThemeStyle />
      <SiteHeader install={installAction} />
      <BrowserDataNotice />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-12 pb-[calc(var(--hb-v)*2)] sm:pt-(--hb-hero-top)">
          <Container>
            <p className="m-small text-muted-foreground">Hubble Desktop</p>
            <h1 className="m-hero mt-3 max-w-[680px] text-foreground">One connected workspace for everything you learn with AI.</h1>
            <p className="m-body mt-3 max-w-[620px] text-muted-foreground">
              An app for your computer. Keep what you work out in ChatGPT, Claude, Gemini and Perplexity — with the pages and notes behind it — find it later, and bring the right parts into your next AI chat.
            </p>
            <div className="mt-[22px] flex flex-wrap items-center gap-2.5">
              <DownloadCta release={release} />
              <a href="#desktop-and-chrome" className={buttonVariants({ variant: "secondary", size: "hero" })}>
                How it works with Chrome
              </a>
            </div>
            <ReleaseLine release={release} className="mt-3" />
            <div className="mt-12 sm:mt-14">
              <Stage className="m-bleed">
                <KnowledgeIllustration className="h-[440px] md:h-[480px]" />
              </Stage>
              <p className="m-small mt-3 text-muted-foreground">A sample project. Nothing on this page reads or stores your data.</p>
            </div>
          </Container>
        </section>

        {/* ---- The loop ------------------------------------------------------ */}
        <RevealSection id="how-it-works" className="m-page pb-[calc(var(--hb-v)*1.5)] scroll-mt-(--hb-header-h)">
          <Container>
            <h2 className="m-h2 m-reveal-item max-w-[810px] text-foreground" style={revealStep(0)}>
              Capture → Connect → Find → Reuse.
            </h2>
            <p className="m-body m-reveal-item mt-3 max-w-[640px] text-muted-foreground" style={revealStep(1)}>
              Your AI conversations stop being scattered across apps and tabs. The project is what lasts; each new chat can start from what you already know.
            </p>
            <ol className="m-reveal-item mt-8 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4" style={revealStep(2)}>
              {LOOP.map(({ icon: Icon, title, body }) => (
                <li key={title} className="m-card flex flex-col gap-2 px-[17.5px] pt-[15.9px] pb-5">
                  <Icon aria-hidden className="size-4 text-muted-foreground" />
                  <p className="m-body text-foreground">{title}</p>
                  <p className="m-small text-muted-foreground">{body}</p>
                </li>
              ))}
            </ol>
          </Container>
        </RevealSection>

        {/* ---- Desktop + Chrome ------------------------------------------------ */}
        <RevealSection id="desktop-and-chrome" className="m-page scroll-mt-(--hb-header-h) pb-[calc(var(--hb-v)*1.5)]">
          <Container>
            <h2 className="m-h2 m-reveal-item max-w-[810px] text-foreground" style={revealStep(0)}>
              The app is Hubble. Chrome is how your browser reaches it.
            </h2>
            <p className="m-body m-reveal-item mt-3 max-w-[640px] text-muted-foreground" style={revealStep(1)}>
              Hubble Desktop holds your projects and works on its own. Hubble for Chrome is a small companion: it saves the AI conversation or tabs you choose straight into the app on the same computer.
            </p>
            <ol className="m-reveal-item mt-8 grid gap-2.5 lg:grid-cols-3" style={revealStep(2)} aria-label="How Hubble for Chrome reaches Hubble Desktop">
              {COMPANION.map(({ icon: Icon, title, body }) => (
                <li key={title} className="m-card flex flex-col gap-2 px-[17.5px] pt-[15.9px] pb-5">
                  <Icon aria-hidden className="size-4 text-muted-foreground" />
                  <p className="m-body text-foreground">{title}</p>
                  <p className="m-small text-muted-foreground">{body}</p>
                </li>
              ))}
            </ol>
            <div className="m-reveal-item mt-6 flex flex-wrap gap-x-6 gap-y-2" style={revealStep(3)}>
              {extensionLink}
              <MoreLink href="/download#how-they-connect">How they connect</MoreLink>
            </div>
          </Container>
        </RevealSection>

        {/* ---- Works with --------------------------------------------------- */}
        <RevealSection className="m-page pb-[calc(var(--hb-v)*1.5)]">
          <Container>
            <h2 className="m-small m-reveal-item text-center text-foreground" style={revealStep(0)}>
              Works beside the AI apps you already use
            </h2>
            <ul className="m-reveal-item mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-3 lg:grid-cols-6" style={revealStep(1)}>
              {[...WORKS_WITH, ...TOOLS].map((item) => (
                <li key={item.name} className="m-card flex h-[100px] flex-col items-center justify-center gap-2 px-2 text-center">
                  <span className="flex items-center gap-2 text-foreground">
                    {item.mark}
                    <span className="text-[15px] leading-none font-medium tracking-[-0.015em] whitespace-nowrap">{item.name}</span>
                  </span>
                  <span className="m-small text-[12px] text-muted-foreground">{item.note}</span>
                </li>
              ))}
            </ul>
          </Container>
        </RevealSection>

        {/* ---- Features ------------------------------------------------------ */}
        <div className="py-[calc(var(--hb-v)*1)]">
          <FeatureSection
            id="capture"
            title="Save the conversation, not just the link."
            body="On ChatGPT, Claude, Gemini or Perplexity, open Hubble for Chrome and choose Save to Hubble: the conversation on screen goes into the project you pick, with its link and where it came from. Save it again later and Hubble updates it instead of adding a copy. Already have a history? Import your ChatGPT or Claude export."
            link={extensionLink}
            stage={
              <Stage>
                <CaptureIllustration className="h-[360px]" />
              </Stage>
            }
          />
          <FeatureSection
            id="find"
            reverse
            title="Find it, whichever AI said it."
            body="Search every project at once: your conversations, notes, and the pages, PDFs and video transcripts Hubble read. A result opens at the turn of the conversation that matched — and always says which app it came from."
            stage={
              <Stage>
                <SearchIllustration className="h-[420px]" />
              </Stage>
            }
          />
          <FeatureSection
            id="reuse"
            layout="wide"
            title="Start your next chat where you left off."
            body="Choose what to bring — a note, two conversations, a reading — and Hubble writes it up for any AI app: your notes, earlier AI answers and sources kept apart, each quoted with where it came from, and disagreements left visible. You see exactly what the AI receives, then copy it, or let Hubble for Chrome type it into the message box. It never sends anything for you."
            link={<MoreLink href="/download">Download Hubble</MoreLink>}
            stage={
              <Stage>
                <ReuseIllustration className="h-[480px]" />
              </Stage>
            }
          />
        </div>

        {/* ---- Principles ---------------------------------------------------- */}
        <RevealSection className="m-section m-page">
          <Container>
            <h2 className="m-h2 m-reveal-item max-w-[810px] text-foreground" style={revealStep(0)}>
              Your knowledge, under your control.
            </h2>
            <div className="m-reveal-item mt-[calc(var(--hb-v)*2)] grid gap-x-10 gap-y-8 border-t border-border pt-8 lg:grid-cols-3" style={revealStep(1)}>
              {PRINCIPLES.map((principle) => (
                <article key={principle.title} className="flex flex-col">
                  <principle.icon className="size-4 text-muted-foreground" aria-hidden />
                  <h3 className="m-body mt-4 text-foreground">{principle.title}</h3>
                  <p className="m-body text-muted-foreground">{principle.body}</p>
                </article>
              ))}
            </div>
          </Container>
        </RevealSection>

        {/* ---- Changelog ----------------------------------------------------- */}
        <RevealSection id="changelog" className="m-section m-page scroll-mt-(--hb-header-h)">
          <Container>
            <h2 className="m-title m-reveal-item text-foreground" style={revealStep(0)}>
              Changelog
            </h2>
            <ul className="m-reveal-item mt-6 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-4" style={revealStep(1)}>
              {CHANGELOG.map((entry) => (
                <li key={entry.title} className="m-card px-[17.5px] pt-[15.9px] pb-5">
                  <p className="m-body text-muted-foreground">{entry.date}</p>
                  <p className="m-body text-foreground">{entry.title}</p>
                </li>
              ))}
            </ul>
          </Container>
        </RevealSection>

        {/* ---- Closing -------------------------------------------------------- */}
        <RevealSection className="m-page pt-[var(--hb-section-y)] pb-[calc(var(--hb-section-y)*2)]">
          <Container className="flex flex-col items-center text-center">
            <h2 className="m-cta m-reveal-item text-foreground" style={revealStep(0)}>
              Get Hubble for your computer.
            </h2>
            <div className="m-reveal-item mt-6 flex flex-wrap justify-center gap-2.5" style={revealStep(1)}>
              <DownloadCta release={release} />
              <Link href="/download" className={buttonVariants({ variant: "secondary", size: "hero" })}>
                All platforms
                <ArrowRight aria-hidden />
              </Link>
            </div>
            <ReleaseLine release={release} className="m-reveal-item mt-3" />
          </Container>
        </RevealSection>
      </main>

      <SiteFooter scheme={scheme} onScheme={setScheme} />
    </div>
  )
}

/** What Hubble does with each AI app, read from the provider registry so the row cannot claim more than Hubble does. */
const WORKS_WITH: { name: string; note: string; mark: ReactNode }[] = AI_PROVIDER_IDS.map((id) => {
  const provider = AI_PROVIDERS[id]
  const parts = [provider.capabilities.pageCapture.supported ? "Save from the page" : "", provider.capabilities.exportImport.supported ? "Import export" : ""].filter(Boolean)
  return { name: provider.name, note: parts.join(" · "), mark: <ProviderMark provider={id} size={16} /> }
})

const TOOLS: { name: string; note: string; mark: ReactNode }[] = [
  { name: "Desktop", note: "The Hubble app", mark: <Monitor className="size-4" aria-hidden /> },
  { name: "Chrome", note: "Companion extension", mark: <Globe className="size-4" aria-hidden /> },
]

const COMPANION: { title: string; body: string; icon: typeof Laptop }[] = [
  {
    title: "Save in Chrome",
    body: "On an AI app's page, or with tabs you want to keep, choose Save to Hubble in the extension.",
    icon: Globe,
  },
  {
    title: "Paired on this computer",
    body: "The extension talks only to the Hubble app on the same computer, once you approve it in the app. Nothing passes through a server.",
    icon: ShieldCheck,
  },
  {
    title: "Kept until Hubble is open",
    body: "If the app isn't running, the extension keeps what you saved and delivers it when Hubble starts.",
    icon: Monitor,
  },
]

const PRINCIPLES: { title: string; body: string; icon: typeof Laptop }[] = [
  {
    title: "On your computer",
    body: "Projects, conversations and notes are kept by the app on your computer and open without a network. Sign in only if you want projects synced between devices.",
    icon: Laptop,
  },
  {
    title: "Only what you choose",
    body: "Hubble saves a conversation when you ask, never in the background, and never signs in to your AI accounts. You see every word before it goes into another AI chat.",
    icon: Eye,
  },
  {
    title: "Honest about sources",
    body: "Every saved item keeps where it came from. AI answers are marked as AI answers, and saved text is quoted as material — never followed as instructions.",
    icon: ShieldCheck,
  },
]

// The project's own history, newest first.
const CHANGELOG = [
  { date: "Nov 19, 2026", title: "Hubble is a desktop app; Hubble for Chrome pairs with it and saves straight into it" },
  { date: "Oct 13, 2026", title: "Cross-AI memory: save conversations from ChatGPT, Claude, Gemini and Perplexity, search them, reuse them anywhere" },
  { date: "Oct 12, 2026", title: "ChatGPT, Claude and Gemini can read your projects through a connector" },
  { date: "Oct 6, 2026", title: "Projects: collect pages, PDFs and videos from Chrome" },
  { date: "Sep 26, 2026", title: "A new name, Hubble, and a calmer interface" },
]
