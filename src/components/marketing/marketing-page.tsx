"use client"

import Link from "next/link"
import type { CSSProperties, ReactNode } from "react"
import { ArrowRight } from "lucide-react"
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
  DemoFavicon,
  DemoStage,
  MButton,
  Reveal,
  Section,
  SectionLede,
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

      {/* The copy block is deliberately compact — headline, one sentence, two
          buttons, out of the way in about 280px. The demo below it is the
          hero; the words are its caption. A tall wall of display type before
          the product is the tell of a page whose product shot cannot carry
          the fold on its own. */}
      <Container className="relative">
        <div className="flex flex-col items-start pt-11 pb-7 sm:pt-14 sm:pb-8">
          <Reveal order={0}>
            <h1 className="m-display max-w-[24ch] text-foreground">
              Turn a browser full of tabs into a workspace you can think in.
            </h1>
          </Reveal>

          <Reveal order={1}>
            {/* 54ch, not 46: at the narrower measure this broke as "Dump them
                into TabDump / once", splitting the product name from its verb
                across a line. */}
            <p className="m-sub mt-3.5 max-w-[54ch]">
              {HERO_TAB_COUNT} open tabs is not a filing system. Dump them into TabDump once and get sections, search,
              and a space worth coming back to.
            </p>
          </Reveal>

          <Reveal order={2}>
            <div className="mt-6 flex flex-wrap items-center gap-2.5">
              {storeUrl ? (
                <a href={storeUrl} target="_blank" rel="noopener noreferrer" className={mButtonClass("primary")}>
                  Add to Chrome
                  <ArrowRight />
                </a>
              ) : (
                <MButton onClick={onInstallExtension}>
                  Add to Chrome
                  <ArrowRight />
                </MButton>
              )}
              <MButton variant="secondary" onClick={onPasteTabs}>
                Paste tabs instead
              </MButton>
              <span className="ml-1 text-body-sm text-tertiary">Free while in beta · works offline</span>
            </div>
          </Reveal>
        </div>
      </Container>

      <Container className="relative pb-14 sm:pb-20">
        <Reveal order={1}>
          <DemoStage>
            <HeroDumpDemo />
          </DemoStage>
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
                <DemoFavicon domain={t.domain} size={13} />
                <span className="max-w-[16ch] truncate text-[0.6875rem] text-tertiary">{t.title}</span>
              </span>
            ))
          )}
        </div>
      </div>

      <Container>
        <div className="mt-10 grid gap-8 md:grid-cols-[minmax(0,1.1fr)_minmax(0,0.9fr)] md:items-end">
          <Reveal order={0}>
            <p className="m-headline max-w-2xl text-foreground">
              Everything you find in a day ends up in the same place: a strip too small to read.
            </p>
          </Reveal>
          <Reveal order={1}>
            {/* Labels kept to a single line each and parallel in shape. The
                middle one used to run to two lines while its neighbours ran to
                one, which made a row of three figures read as ragged. */}
            <div className="grid grid-cols-3 gap-6">
              <Stat value={HERO_TAB_COUNT} label="tabs in one window" />
              <Stat value={HERO_RESULT.duplicates} label="are the same page" />
              <Stat value="0" label="you can find again" />
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
  heading,
  lead,
  caption,
  children,
}: {
  id?: string
  heading: string
  lead: string
  caption?: string
  children: ReactNode
}) {
  return (
    <Section id={id}>
      <Container>
        <SectionLede heading={heading} lead={lead} />
        <Reveal order={1} className="mt-8">
          <DemoStage>{children}</DemoStage>
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
      {/* Scroll reveals rest at opacity 0 and are only ever switched on by an
          IntersectionObserver. On `/welcome` — which server-renders this whole
          page — that would otherwise hand a reader without scripting a
          complete document they cannot see. The demos need JS to mean
          anything; the writing does not. */}
      <noscript>
        <style>{`.tabdump-marketing .m-reveal{opacity:1!important;transform:none!important}`}</style>
      </noscript>

      <MarketingNav
        primaryLabel="Add to Chrome"
        primaryHref={storeUrl}
        onPrimary={onInstallExtension}
        onSecondary={onPasteTabs}
      />

      <main>
        <Hero onInstallExtension={onInstallExtension} onPasteTabs={onPasteTabs} storeUrl={storeUrl} />

        <ProblemStrip />

        {/* --- Structure ---
            Copy from here on refers back to "that dump" and to the Thesis
            workspace by name. Every demo on this page runs on one corpus, and
            saying so out loud is what turns nine widgets into one session
            being followed from the browser all the way to recall. */}
        <SplitSection
          id="organize"
          heading={`That pile becomes ${DEMO_SECTIONS.length} clean sections.`}
          lead="TabDump reads what you actually had open — the paper, the problem set, the four GitHub tabs — and builds the hierarchy you would have built yourself, if you had the afternoon."
          aside="Open any branch. The counts are computed from the tabs underneath, not typed in."
        >
          <StructureDemo />
        </SplitSection>

        {/* --- Intelligence --- */}
        <Section>
          <Container>
            <SectionLede
              heading="It does the filing, and it shows its work."
              lead="Every tab in that same dump carries a one-line note explaining where it went and why — so when TabDump gets something wrong, you can see it at a glance and move it in one drag."
            />

            <div className="mt-8 grid gap-5 lg:grid-cols-2">
              <Reveal order={1}>
                <DemoStage>
                  <ReasoningDemo />
                </DemoStage>
                <DemoCaption>Pick a tab to read its note.</DemoCaption>
              </Reveal>
              <Reveal order={2}>
                <DemoStage>
                  <DuplicateDemo />
                </DemoStage>
                <DemoCaption>
                  {HERO_RESULT.duplicates} repeats in that dump, folded into the pages they duplicate.
                </DemoCaption>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* --- Spatial --- */}
        <WideSection
          id="spatial"
          heading="Those sections are places, not folders."
          lead="The same Thesis workspace, laid out in space. Put a tab where you will look for it and TabDump keeps it there — still showing you what it belongs with."
          caption="Drag a tab from one section into another — its colour, both counts and the line below all follow."
        >
          <SpatialDemo />
        </WideSection>

        {/* --- Search --- */}
        <SplitSection
          id="recall"
          heading="Weeks later, ask for it by name."
          lead="Search that same workspace across titles, domains and sections at once. It narrows around what matched instead of throwing away the context around it."
          aside="This one is real — type anything, including something with no results."
          reverse
        >
          <SearchDemo />
        </SplitSection>

        {/* --- Workspaces --- */}
        <SplitSection
          // Not "And Thesis is only one of your rooms." — in the narrow copy
          // column a 1024 viewport gives, that balanced to "And Thesis is
          // only / one of your rooms.", stranding "only" from the "one" it
          // belongs to. This wording keeps the pair together at every width.
          heading="Thesis is only one of your rooms."
          lead="Thesis reading does not belong in the same space as the work you are shipping. Each workspace keeps its own tabs, sections and layout."
          aside="Switch between them on the left."
        >
          <WorkspaceDemo />
        </SplitSection>

        {/* --- History --- */}
        <SplitSection
          heading="Even the session you never saved."
          lead="TabDump can read back through your browsing history, find the pages that actually mattered in a stretch of time, and bring them back as a workspace."
          aside="Nothing was open. Nothing was bookmarked. It comes back anyway."
          reverse
        >
          <HistoryDemo />
        </SplitSection>

        {/* --- Extension --- */}
        <WideSection
          id="dump"
          heading="And it starts with one click."
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
              <Reveal order={1}>
                {/* The line break is the composition here, so balancing is
                    turned off: left on, it re-breaks the second sentence and
                    strands "find." on a line of its own. */}
                <p className="m-display text-foreground [text-wrap:wrap]">
                  Stop managing tabs.
                  <br />
                  Start keeping what you find.
                </p>
              </Reveal>
              <Reveal order={2}>
                <p className="m-sub mx-auto mt-5 max-w-[52ch]">
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
              <h2 className="m-headline mx-auto max-w-[22ch] text-foreground">
                You already have the tabs. Give them somewhere to go.
              </h2>
            </Reveal>
            <Reveal order={1}>
              <div className="mt-7 flex flex-wrap items-center justify-center gap-2.5">
                {storeUrl ? (
                  <a href={storeUrl} target="_blank" rel="noopener noreferrer" className={mButtonClass("primary")}>
                    Add to Chrome
                    <ArrowRight />
                  </a>
                ) : (
                  <MButton onClick={onInstallExtension}>
                    Add to Chrome
                    <ArrowRight />
                  </MButton>
                )}
                <MButton variant="secondary" onClick={onPasteTabs}>
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
              <p className="m-label">Product</p>
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
              <p className="m-label">Legal</p>
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
