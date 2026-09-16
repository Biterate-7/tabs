"use client"

import Link from "next/link"
import type { ReactNode } from "react"
import { ArrowRight } from "lucide-react"
import { getAgentRunSummary } from "@/lib/agents/intelligence/run-summary"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { AgentRunDemo } from "./agent-run-demo"
import { DEMO_AGENT_INDEX, DEMO_AGENT_STATE, DEMO_PROVIDERS, DEMO_RUN_ID } from "./agent-data"
import { ChaosDemo } from "./chaos-demo"
import { CommandCenterDemo } from "./command-center-demo"
import { DEMO_SECTIONS, DEMO_UNIQUE_TABS, HERO_TAB_COUNT } from "./data"
import { ExtensionDemo } from "./extension-demo"
import { ImpactDemo } from "./impact-demo"
import { MarketingNav } from "./nav"
import {
  Container,
  DemoCaption,
  DemoStage,
  MButton,
  Reveal,
  Section,
  SectionLede,
  SplitSection,
  Stat,
  mButtonClass,
} from "./primitives"
import { ProvidersDemo } from "./providers-demo"
import { SearchDemo } from "./search-demo"
import { SpatialDemo } from "./spatial-demo"
import { StructureDemo } from "./structure-demo"
import { TimelineDemo } from "./timeline-demo"
import { WorkPlanDemo } from "./work-plan-demo"

/**
 * TabDump's public landing page.
 *
 * ## What the page argues
 *
 * That a workspace is the right place to watch AI work happen. Tabs were the
 * first thing TabDump put in one; agent runs, the work they track and the files
 * they touch are the second, and the argument of the page is that they belong
 * in the same space — because they already share the same context.
 *
 * The organizing principle from the previous landing page is kept: the page
 * does not describe the product, it runs it. Every section is a statement
 * followed by a piece of TabDump you can touch, and all of them draw on one
 * corpus — one browsing session, one workspace, one agent run — so the page
 * reads as a continuous thing rather than as nine widgets.
 *
 * ## Three rules the copy is held to
 *
 *  1. **Observe, never command.** TabDump reads what an agent did. It does not
 *     start, steer, stop or instruct one, and no verb on this page suggests it
 *     does. The domain has no field for a prompt or a command; the page has no
 *     sentence implying there is.
 *  2. **One provider is supported.** Claude Code, read locally. The provider
 *     section shows what is planned as explicitly unbuilt rather than as a logo
 *     in a row.
 *  3. **Numbers are derived.** The counts beside the demos come from the
 *     product's own selectors over a fixture, not from prose. See agent-data.ts.
 *
 * It also never mounts app state — no workspace store, no persistence, no auth,
 * no agent observation — so nothing here can read or touch a visitor's data,
 * and every demo works identically for someone who has never installed
 * anything.
 */

export type MarketingPageProps = {
  /** Primary CTA. Not called when the Chrome Web Store listing is configured — that renders as a real link. */
  onInstallExtension: () => void
  /** Secondary CTA: skip the extension and go straight into the app. */
  onPasteTabs: () => void
}

/* -------------------------------------------------------------------------
 * Hero
 * ---------------------------------------------------------------------- */

function Hero({ onInstallExtension, onPasteTabs, storeUrl }: MarketingPageProps & { storeUrl?: string }) {
  return (
    <div id="top" className="relative overflow-hidden">
      <div aria-hidden className="m-grid pointer-events-none absolute inset-0 opacity-70" />
      <div
        aria-hidden
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 70% at 50% 0%, color-mix(in oklch, var(--primary), transparent 92%) 0%, transparent 62%), linear-gradient(180deg, var(--background) 0%, transparent 28%, transparent 72%, var(--background) 100%)",
        }}
      />

      {/* Compact on purpose — headline, one sentence, two buttons, out of the
          way in about 280px. The demo below is the hero; the words are its
          caption. A tall wall of display type before the product is the tell of
          a page whose product shot cannot carry the fold on its own. */}
      <Container className="relative">
        <div className="flex flex-col items-start pt-11 pb-7 sm:pt-14 sm:pb-8">
          <Reveal order={0}>
            <h1 className="m-display max-w-[22ch] text-foreground">
              Watch your AI agents work, in the workspace they work on.
            </h1>
          </Reveal>

          <Reveal order={1}>
            <p className="m-sub mt-3.5 max-w-[56ch]">
              TabDump turns a browser full of tabs into a workspace — and then shows the agent runs
              happening inside it: what each one is tracking, which files it touched, and which of
              your tabs it used to get there.
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
                Open TabDump
              </MButton>
              <span className="ml-1 text-body-sm text-tertiary">Free while in beta · works offline</span>
            </div>
          </Reveal>
        </div>
      </Container>

      <Container className="relative pb-14 sm:pb-20">
        <Reveal order={1}>
          <DemoStage>
            <CommandCenterDemo />
          </DemoStage>
          <DemoCaption>
            A workspace, an agent run, and everything it touched. Press Replay to watch it assemble.
          </DemoCaption>
        </Reveal>
      </Container>
    </div>
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

  // Derived here, once, and passed into the copy below — so a sentence on this
  // page cannot claim a count the product would compute differently.
  const summary = getAgentRunSummary(DEMO_AGENT_INDEX, DEMO_RUN_ID)
  const supportedCount = DEMO_PROVIDERS.filter((p) => p.status === "supported").length

  return (
    <div className="tabdump-marketing min-h-screen">
      {/* Scroll reveals rest at opacity 0 and are only ever switched on by an
          IntersectionObserver. On `/welcome` — which server-renders this whole
          page — that would otherwise hand a reader without scripting a complete
          document they cannot see. The demos need JS to mean anything; the
          writing does not. */}
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

        {/* --- The problem --- */}
        <Section>
          <Container>
            <div className="grid gap-8 lg:grid-cols-[minmax(0,1fr)_minmax(0,1.45fr)] lg:items-start">
              <div>
                <Reveal order={0}>
                  <h2 className="m-headline max-w-[20ch] text-foreground">
                    Your work is in two places, and neither of them can see the other.
                  </h2>
                </Reveal>
                <Reveal order={1}>
                  <p className="m-sub mt-4 max-w-[46ch]">
                    The context is in your browser. The work is in a terminal that scrolls away. When
                    an agent stops, there is nothing left to look at but a transcript — and nothing
                    anywhere that says which of your tabs it was working from.
                  </p>
                </Reveal>
                <Reveal order={2}>
                  <div className="mt-8 grid grid-cols-3 gap-6">
                    <Stat value={HERO_TAB_COUNT} label="tabs in one window" />
                    <Stat value="4" label="agent sessions open" />
                    <Stat value="0" label="places both are visible" />
                  </div>
                </Reveal>
              </div>
              <Reveal order={1} className="min-w-0">
                <DemoStage>
                  <ChaosDemo />
                </DemoStage>
                <DemoCaption>Switch between Before and After. Nothing is thrown away — it is placed.</DemoCaption>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* --- Agent runs --- */}
        <WideSection
          id="agents"
          heading="Your agents should not be black boxes."
          lead="TabDump reads the sessions already on your machine and represents each one as a run in the workspace it belongs to: what it is doing, whether it is still going, and what it has to show for itself."
          caption="Move the run between states. Every one of them is a state the product actually has."
        >
          <AgentRunDemo />
        </WideSection>

        {/* --- Work tracking --- */}
        <WideSection
          id="work"
          heading="Meaningful work, not a tool-call counter."
          lead="A run carries the plan it is working through. Progress is counted from items that actually finished — never from elapsed time, event volume, or how far a poll has read."
          caption="Click any item to cycle its state. The numbers on the right are computed by the product's own selectors, live."
        >
          <WorkPlanDemo />
        </WideSection>

        {/* --- Impact --- */}
        <WideSection
          id="impact"
          heading="Select a run. Watch the workspace answer."
          lead={`This run touched ${summary?.artifactCount ?? 0} files and used ${summary?.contextTabCount ?? 0} of your tabs as context. Selecting it lights up exactly those — and nothing it cannot prove it touched.`}
          caption="Switch between the two runs, or clear the selection. The highlight is computed by the same selector the spatial canvas uses."
        >
          <ImpactDemo />
        </WideSection>

        {/* --- Activity --- */}
        <SplitSection
          heading="And a log you can actually read."
          lead="Five kinds of entry, each a short line the adapter already made safe. There is no field in the model for a prompt, a command, or a tool result — which is why you will never find one here."
          aside="It records what happened, not how it was asked for."
          reverse
        >
          <TimelineDemo />
        </SplitSection>

        {/* --- The workspace underneath ---
            The agent layer sits on top of the tab product, and the page has to
            show the thing it sits on or the whole argument is unfounded. Two
            demos, kept brief: the pile becoming sections, and the sections
            becoming places. */}
        <SplitSection
          id="organize"
          heading={`The pile becomes ${DEMO_SECTIONS.length} clean sections.`}
          lead="TabDump reads what you actually had open — the paper, the problem set, the four GitHub tabs — and builds the hierarchy you would have built yourself, if you had the afternoon."
          aside="Open any branch. The counts are computed from the tabs underneath, not typed in."
        >
          <StructureDemo />
        </SplitSection>

        <WideSection
          id="spatial"
          heading="And those sections are places, not folders."
          lead="Put a tab where you will look for it and TabDump keeps it there. It is the same space an agent run appears in, which is the whole reason the two can be looked at together."
          caption="Drag a tab from one section into another — its colour, both counts and the line below all follow."
        >
          <SpatialDemo />
        </WideSection>

        <SplitSection
          id="recall"
          heading="Weeks later, ask for any of it by name."
          lead="Search the workspace across titles, domains and sections at once. It narrows around what matched instead of throwing away the context around it."
          aside="This one is real — type anything, including something with no results."
          reverse
        >
          <SearchDemo />
        </SplitSection>


        {/* --- Where the tabs come from ---
            The primary call to action is "Add to Chrome", so the page owes a
            reader one plain answer to what that installs. Kept short and placed
            late: it is the mechanism, not the argument. */}
        <WideSection
          id="dump"
          heading="All of it starts with one click."
          lead="The extension knows which tabs you have already dumped, so a second dump adds what is new instead of duplicating everything you own."
          caption="Click the TabDump button in the toolbar to run it."
        >
          <ExtensionDemo />
        </WideSection>

        {/* --- Providers --- */}
        <WideSection
          id="providers"
          heading="Built for more than one kind of agent. Reading exactly one, today."
          lead={`The model stores a provider as an opaque string and never interprets it, so a second agent is an adapter rather than a rewrite. ${supportedCount === 1 ? "One adapter exists" : `${supportedCount} adapters exist`} — and this page is not going to imply otherwise.`}
        >
          <ProvidersDemo />
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
                {/* The line break is the composition, so balancing is off: left
                    on, it re-breaks the second line and strands "see." */}
                <p className="m-display text-foreground [text-wrap:wrap]">
                  Stop reading transcripts.
                  <br />
                  Start seeing the work.
                </p>
              </Reveal>
              <Reveal order={2}>
                <p className="m-sub mx-auto mt-5 max-w-[54ch]">
                  A terminal shows you one session, for as long as you keep the window open. A
                  workspace shows you all of them, against the context they were working from, after
                  the window is closed.
                </p>
              </Reveal>
            </div>
          </Container>
        </Section>

        {/* --- Final CTA --- */}
        <Section className="text-center">
          <Container>
            <Reveal order={0}>
              <h2 className="m-headline mx-auto max-w-[24ch] text-foreground">
                Bring your tabs. The agents are already running.
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
                  Open TabDump
                </MButton>
              </div>
            </Reveal>
            <Reveal order={2}>
              <p className="mt-5 text-body-sm text-tertiary">
                {DEMO_UNIQUE_TABS.length} tabs and {DEMO_AGENT_STATE.runs.length} agent runs in the
                demos above. All of it fictional; the workspace is not.
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
              A spatial workspace for the tabs you keep and the agents working alongside them.
            </p>
          </div>

          <div className="grid grid-cols-2 gap-10 sm:gap-16">
            <nav aria-label="Product">
              <p className="m-label">Product</p>
              <ul className="mt-4 flex flex-col gap-2.5 text-body-sm">
                {[
                  { href: "#agents", label: "Agent runs" },
                  { href: "#work", label: "Work tracking" },
                  { href: "#impact", label: "Workspace impact" },
                  { href: "#spatial", label: "Spatial view" },
                ].map((link) => (
                  <li key={link.href}>
                    <a
                      href={link.href}
                      className="text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
                    >
                      {link.label}
                    </a>
                  </li>
                ))}
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
          <p>Every tab, file and agent run on this page is fictional. Yours are not.</p>
        </div>
      </Container>
    </footer>
  )
}
