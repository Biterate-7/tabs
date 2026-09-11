"use client"

import Link from "next/link"
import type { CSSProperties, ReactNode } from "react"
import { ArrowRight } from "lucide-react"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { DEMO_TABS, DEMO_UNIQUE_TABS, DEMO_SECTIONS, HERO_TAB_COUNT } from "./data"
import { ExtensionDemo } from "./extension-demo"
import { HeroDumpDemo, HERO_RESULT } from "./hero-dump-demo"
import { HistoryDemo } from "./history-demo"
import { DuplicateDemo, ReasoningDemo } from "./intelligence-demo"
import { MarketingNav } from "./nav"
import {
  Container,
  DemoCaption,
  Eyebrow,
  MButton,
  Reveal,
  Section,
  SplitSection,
  Stat,
  mButtonClass,
} from "./primitives"
import { SearchDemo } from "./search-demo"
import { SpatialDemo } from "./spatial-demo"
import { StructureDemo } from "./structure-demo"
import { WorkspaceDemo } from "./workspace-demo"

/**
 * TabDump's public landing page.
 *
 * The organizing principle, borrowed from the best product pages and not from
 * any one of them: the page does not describe the product, it runs it. Every
 * section is a statement followed by a piece of TabDump you can actually
 * touch, built from the same corpus of fictional tabs so the whole page reads
 * as one continuous session being dumped, organized, searched and recovered.
 *
 * Two things it deliberately does not do. It never mounts app state — no
 * workspace store, no persistence, no auth — so a visitor's real data cannot
 * be touched by anything here. And it takes its two calls to action as props
 * rather than reaching for the onboarding module itself, so the same page can
 * be the first-run experience inside the app shell and a standalone public
 * route without behaving differently in either.
 */

export type MarketingPageProps = {
  /** Primary CTA. Not called when the Chrome Web Store listing is configured — that renders as a real link. */
  onInstallExtension: () => void
  /** Secondary CTA: skip the extension and paste URLs by hand. */
  onPasteTabs: () => void
}

/* -------------------------------------------------------------------------
 * Hero
 * ---------------------------------------------------------------------- */

function Hero({ onInstallExtension, onPasteTabs, storeUrl }: MarketingPageProps & { storeUrl?: string }) {
  return (
    <div id="top" className="relative overflow-hidden">
      <div aria-hidden className="m-grid pointer-events-none absolute inset-0 opacity-70" />
      {/* A single soft wash behind the headline so the grid fades out toward
          the top of the fold. One gradient, no blobs. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 70% at 50% 0%, color-mix(in oklch, var(--primary), transparent 92%) 0%, transparent 62%), linear-gradient(180deg, var(--background) 0%, transparent 28%, transparent 72%, var(--background) 100%)",
        }}
      />

      <Container className="relative">
        <div className="flex flex-col items-start pt-16 pb-10 sm:pt-24 sm:pb-14">
          <Reveal order={0}>
            <span className="inline-flex items-center gap-2 rounded-full border border-subtle px-3 py-1 text-[0.6875rem] text-muted-foreground">
              <span aria-hidden className="size-1.5 rounded-full bg-accent-text" />
              Chrome extension · free while in beta
            </span>
          </Reveal>

          <Reveal order={1}>
            <h1 className="m-display mt-7 max-w-4xl text-foreground">
              Turn a browser full of tabs into a workspace you can think in.
            </h1>
          </Reveal>

          <Reveal order={2}>
            <p className="m-lead mt-6 max-w-xl">
              {HERO_TAB_COUNT} open tabs is not a filing system. Dump them into TabDump once and get sections, search,
              and a space worth coming back to.
            </p>
          </Reveal>

          <Reveal order={3}>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              {storeUrl ? (
                <a href={storeUrl} target="_blank" rel="noopener noreferrer" className={mButtonClass("primary", "lg")}>
                  Add to Chrome
                  <ArrowRight />
                </a>
              ) : (
                <MButton size="lg" onClick={onInstallExtension}>
                  Add to Chrome
                  <ArrowRight />
                </MButton>
              )}
              <MButton size="lg" variant="secondary" onClick={onPasteTabs}>
                Paste tabs instead
              </MButton>
            </div>
          </Reveal>

          <Reveal order={4}>
            <p className="mt-5 text-body-sm text-tertiary">
              Works offline. Your tabs stay in your browser until you say otherwise.
            </p>
          </Reveal>
        </div>
      </Container>

      <Container className="relative pb-16 sm:pb-24">
        <Reveal order={2}>
          <HeroDumpDemo />
        </Reveal>
      </Container>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * The problem, at a glance
 * ---------------------------------------------------------------------- */

/** Domains for the drifting strip. Doubled in the markup so the loop has no seam. */
const STRIP_DOMAINS = DEMO_TABS.map((t) => ({ id: t.id, domain: t.domain, title: t.title }))

function ProblemStrip() {
  return (
    // Not the shared `Section`: the marquee is flush to the hero above it and
    // supplies its own top rule, so this one needs bottom padding only.
    <section className="relative" style={{ paddingBottom: "var(--m-section-y)" }}>
      <div
        className="m-marquee relative flex overflow-hidden border-y border-subtle py-3"
        aria-hidden
        style={{ "--m-marquee-duration": "56s" } as CSSProperties}
      >
        {/* The track is rendered twice back to back and shifted by exactly
            half its width, so the loop point is invisible. */}
        <div className="m-marquee-track flex w-max shrink-0 gap-2 pr-2">
          {[0, 1].map((copy) =>
            STRIP_DOMAINS.map((t) => (
              <span
                key={`${copy}-${t.id}`}
                className="flex items-center gap-1.5 rounded-md border border-subtle bg-card/60 px-2 py-1.5"
              >
                <TabFavicon domain={t.domain} size={13} />
                <span className="max-w-[16ch] truncate text-[0.6875rem] text-tertiary">{t.title}</span>
              </span>
            ))
          )}
        </div>
      </div>

      <Container>
        <div className="mt-14 grid gap-10 md:grid-cols-[minmax(0,1.15fr)_minmax(0,0.85fr)] md:items-end">
          <Reveal order={0}>
            <p className="m-headline max-w-2xl text-foreground">
              Everything you find in a day ends up in the same place: a strip too small to read.
            </p>
          </Reveal>
          <Reveal order={1}>
            <div className="grid grid-cols-3 gap-6">
              <Stat value={HERO_TAB_COUNT} label="tabs in one window" />
              <Stat value={HERO_RESULT.duplicates} label="of them the same page twice" />
              <Stat value="0" label="of them you can find again" />
            </div>
          </Reveal>
        </div>
      </Container>
    </section>
  )
}

/* -------------------------------------------------------------------------
 * Full-width section: copy above, demo below
 * ---------------------------------------------------------------------- */

function WideSection({
  id,
  eyebrow,
  heading,
  lead,
  caption,
  children,
}: {
  id?: string
  eyebrow: string
  heading: string
  lead: string
  caption?: string
  children: ReactNode
}) {
  return (
    <Section id={id}>
      <Container>
        <div className="flex flex-col gap-x-16 gap-y-5 lg:flex-row lg:items-end lg:justify-between">
          <div className="max-w-2xl">
            <Reveal order={0}>
              <Eyebrow>{eyebrow}</Eyebrow>
            </Reveal>
            <Reveal order={1}>
              <h2 className="m-headline mt-5 text-foreground">{heading}</h2>
            </Reveal>
          </div>
          <Reveal order={2}>
            <p className="m-lead max-w-md lg:pb-1">{lead}</p>
          </Reveal>
        </div>

        <Reveal order={1} className="mt-12">
          {children}
          {caption && <DemoCaption>{caption}</DemoCaption>}
        </Reveal>
      </Container>
    </Section>
  )
}

/* -------------------------------------------------------------------------
 * Page
 * ---------------------------------------------------------------------- */

export function MarketingPage({ onInstallExtension, onPasteTabs }: MarketingPageProps) {
  const install = getExtensionInstallInfo()
  const storeUrl = install.mode === "store" ? install.url : undefined

  return (
    <div className="tabdump-marketing min-h-screen">
      <MarketingNav
        primaryLabel="Add to Chrome"
        primaryHref={storeUrl}
        onPrimary={onInstallExtension}
        onSecondary={onPasteTabs}
      />

      <main>
        <Hero onInstallExtension={onInstallExtension} onPasteTabs={onPasteTabs} storeUrl={storeUrl} />

        <ProblemStrip />

        {/* --- Structure --- */}
        <SplitSection
          id="organize"
          eyebrow="From chaos to structure"
          heading={`One long pile becomes ${DEMO_SECTIONS.length} clean sections.`}
          lead="TabDump reads what you actually had open — the paper, the problem set, the four GitHub tabs — and builds the hierarchy you would have built yourself, if you had the afternoon."
          aside="Open any branch. The counts are computed from the tabs underneath, not typed in."
        >
          <StructureDemo />
        </SplitSection>

        {/* --- Intelligence --- */}
        <Section>
          <Container>
            <div className="max-w-2xl">
              <Reveal order={0}>
                <Eyebrow>Intelligent organization</Eyebrow>
              </Reveal>
              <Reveal order={1}>
                <h2 className="m-headline mt-5 text-foreground">It does the filing, and it shows its work.</h2>
              </Reveal>
              <Reveal order={2}>
                <p className="m-lead mt-5">
                  Every organized tab carries a one-line note explaining where it went and why — so when TabDump gets
                  something wrong, you can see it at a glance and move it in one drag.
                </p>
              </Reveal>
            </div>

            <div className="mt-12 grid gap-6 lg:grid-cols-2">
              <Reveal order={0}>
                <ReasoningDemo />
                <DemoCaption>Pick a tab to read its note.</DemoCaption>
              </Reveal>
              <Reveal order={1}>
                <DuplicateDemo />
                <DemoCaption>
                  {HERO_RESULT.duplicates} repeats in this dump, folded into the pages they duplicate.
                </DemoCaption>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* --- Spatial --- */}
        <WideSection
          id="spatial"
          eyebrow="Spatial knowledge"
          heading="Tabs are objects. Not rows in a list."
          lead="Lay them out the way you think about them. TabDump keeps the arrangement, and keeps showing you what belongs with what."
          caption="Drag any tab. Hover one to light up everything it sits with. Arrow keys work too."
        >
          <SpatialDemo />
        </WideSection>

        {/* --- Search --- */}
        <SplitSection
          id="recall"
          eyebrow="Recall"
          heading="Ask for it. Everything else steps back."
          lead="Search runs across titles, domains and sections at once, and the workspace narrows around what matched instead of throwing away the context around it."
          aside="This one is real — type anything, including something with no results."
          reverse
        >
          <SearchDemo />
        </SplitSection>

        {/* --- Workspaces --- */}
        <SplitSection
          eyebrow="Workspaces"
          heading="A separate room for every part of your life."
          lead="Thesis reading does not belong in the same space as the work you are shipping. Each workspace keeps its own tabs, sections and layout."
          aside="Switch between them on the left."
        >
          <WorkspaceDemo />
        </SplitSection>

        {/* --- History --- */}
        <SplitSection
          eyebrow="History Dump"
          heading="The session you never meant to close."
          lead="TabDump can read back through your browsing history, find the pages that actually mattered in a stretch of time, and bring them back as a workspace."
          aside="Nothing was open. Nothing was bookmarked. It comes back anyway."
          reverse
        >
          <HistoryDemo />
        </SplitSection>

        {/* --- Extension --- */}
        <WideSection
          id="dump"
          eyebrow="The dump"
          heading="One click, from any window."
          lead="The extension knows which tabs you have already dumped, so a second dump adds what is new instead of duplicating everything you own."
          caption="Click the TabDump button in the toolbar to run it."
        >
          <ExtensionDemo />
        </WideSection>

        {/* --- The big idea --- */}
        <Section className="relative overflow-hidden">
          <div aria-hidden className="m-grid pointer-events-none absolute inset-0 opacity-60" />
          <div
            aria-hidden
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                "radial-gradient(80% 60% at 50% 50%, transparent 0%, var(--background) 78%), radial-gradient(60% 40% at 50% 40%, color-mix(in oklch, var(--primary), transparent 93%) 0%, transparent 70%)",
            }}
          />
          <Container className="relative">
            <div className="mx-auto max-w-5xl text-center">
              <Reveal order={0}>
                <Eyebrow className="text-center">The point</Eyebrow>
              </Reveal>
              <Reveal order={1}>
                {/* The line break is the composition here, so balancing is
                    turned off: left on, it re-breaks the second sentence and
                    strands "find." on a line of its own. */}
                <p className="m-display mt-6 text-foreground [text-wrap:wrap]">
                  Stop managing tabs.
                  <br />
                  Start keeping what you find.
                </p>
              </Reveal>
              <Reveal order={2}>
                <p className="m-lead mx-auto mt-7 max-w-xl">
                  A browser tab is the most fragile place to put something you care about. TabDump gives those pages
                  somewhere to live — organized, searchable, and still yours when the window closes.
                </p>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* --- Final CTA --- */}
        <Section className="text-center">
          <Container>
            <Reveal order={0}>
              <h2 className="m-headline mx-auto max-w-2xl text-foreground">
                You already have the tabs. Give them somewhere to go.
              </h2>
            </Reveal>
            <Reveal order={1}>
              <div className="mt-9 flex flex-wrap items-center justify-center gap-3">
                {storeUrl ? (
                  <a href={storeUrl} target="_blank" rel="noopener noreferrer" className={mButtonClass("primary", "lg")}>
                    Add to Chrome
                    <ArrowRight />
                  </a>
                ) : (
                  <MButton size="lg" onClick={onInstallExtension}>
                    Add to Chrome
                    <ArrowRight />
                  </MButton>
                )}
                <MButton size="lg" variant="secondary" onClick={onPasteTabs}>
                  Paste tabs instead
                </MButton>
              </div>
            </Reveal>
            <Reveal order={2}>
              <p className="mt-5 text-body-sm text-tertiary">
                {DEMO_UNIQUE_TABS.length} tabs in the demo above. Bring your own {HERO_TAB_COUNT}.
              </p>
            </Reveal>
          </Container>
        </Section>
      </main>

      <MarketingFooter onPasteTabs={onPasteTabs} />
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Footer
 * ---------------------------------------------------------------------- */

function MarketingFooter({ onPasteTabs }: { onPasteTabs: () => void }) {
  return (
    <footer className="border-t border-subtle">
      <Container>
        <div className="flex flex-col gap-10 py-12 sm:flex-row sm:justify-between">
          <div>
            <p className="text-[0.9375rem] font-medium tracking-[-0.01em] text-foreground">TabDump</p>
            <p className="mt-2 max-w-xs text-body-sm text-tertiary">
              A spatial home for everything you find on the way to what you were looking for.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:gap-16">
            <nav aria-label="Product">
              <p className="m-eyebrow">Product</p>
              <ul className="mt-4 flex flex-col gap-2.5 text-body-sm">
                <li>
                  <a href="#dump" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    The dump
                  </a>
                </li>
                <li>
                  <a href="#organize" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    Organization
                  </a>
                </li>
                <li>
                  <a href="#spatial" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    Spatial view
                  </a>
                </li>
                <li>
                  <button
                    type="button"
                    onClick={onPasteTabs}
                    className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none"
                  >
                    Open TabDump
                  </button>
                </li>
              </ul>
            </nav>

            <nav aria-label="Legal">
              <p className="m-eyebrow">Legal</p>
              <ul className="mt-4 flex flex-col gap-2.5 text-body-sm">
                <li>
                  <Link href="/privacy" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    Privacy Policy
                  </Link>
                </li>
                <li>
                  <Link href="/terms" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    Terms &amp; Conditions
                  </Link>
                </li>
                <li>
                  <Link href="/cookies" className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline">
                    Cookie Policy
                  </Link>
                </li>
              </ul>
            </nav>
          </div>
        </div>

        <div className="flex flex-col gap-2 border-t border-subtle py-6 text-body-sm text-tertiary sm:flex-row sm:justify-between">
          <p>© {new Date().getFullYear()} TabDump</p>
          <p>Every tab on this page is fictional. Yours are not.</p>
        </div>
      </Container>
    </footer>
  )
}
