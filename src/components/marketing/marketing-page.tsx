"use client"

import { useMemo, type ReactNode } from "react"
import { Globe, KeyRound, Laptop, MessagesSquare, Monitor, ShieldCheck } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import { CLAUDE_SESSION, GEMINI_SESSION } from "./demo/data"
import { DemoApp } from "./demo/demo-app"
import { DemoFrame } from "./demo/demo-frame"
import { HubbleDemoProvider } from "./demo/demo-provider"
import type { DemoInit } from "./demo/demo-state"
import { DemoThemeStyle } from "./demo/demo-theme"
import { RevealSection, revealStep } from "./reveal"
import {
  Container,
  FeatureSection,
  HeroActions,
  MoreLink,
  SiteFooter,
  SiteHeader,
  Stage,
  WhenNear,
  useMarketingScheme,
  type PrimaryAction,
  type Scheme,
} from "./site"

export type MarketingPageProps = {
  /** Opens the in-page install guide when the extension is a download. */
  onInstallExtension: () => void
  /** Enters the app. */
  onPasteTabs: () => void
}

const ROOT_ID = "hubble-marketing"

/** Window heights, per breakpoint, shared by each window and the space it holds before it mounts. */
const HERO_HEIGHT = "h-[600px] md:h-[640px] lg:h-[720px]"
const WINDOW_HEIGHT = "h-[560px] md:h-[600px] xl:h-[640px]"

/**
 * Hubble's public page: the product, presented as the product.
 *
 * The reference's composition — one sentence over one very large window, a
 * row of what it works with, then sections that each pair two sentences with
 * a screen — with one difference that matters: every screen is a live Hubble.
 * Each window is the app's own interface (see demo/), running on its own
 * isolated, deterministic demo state. Nothing on the page connects to an
 * agent, a runtime, the visitor's browser or their saved Hubble data.
 *
 * Nothing is claimed that the product does not do. The integration row reads
 * the connector catalog; Codex is shown as connecting without sessions,
 * because that is what it does; the changelog is the project's own history.
 */
export function MarketingPage({ onInstallExtension, onPasteTabs }: MarketingPageProps) {
  const install = getExtensionInstallInfo()
  const installAction: PrimaryAction =
    install.mode === "store"
      ? { label: "Hubble for Chrome", href: install.url }
      : { label: "Hubble for Chrome", onClick: onInstallExtension }
  const [scheme, setScheme] = useMarketingScheme(ROOT_ID)
  const demoScheme = useMemo(() => ({ value: scheme, set: setScheme }), [scheme, setScheme])

  return (
    <div id={ROOT_ID} className="tabdump-marketing min-h-screen">
      <DemoThemeStyle />
      <SiteHeader install={installAction} onOpenApp={onPasteTabs} />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-12 pb-[calc(var(--hb-v)*2)] sm:pt-(--hb-hero-top)">
          <Container>
            <h1 className="m-hero max-w-[640px] text-foreground">
              Hubble turns your browser into structured context for your AI agents.
            </h1>
            <div className="mt-[22px]">
              <HeroActions onOpenApp={onPasteTabs} exploreHref="#workspaces" />
            </div>
            <div className="mt-12 sm:mt-14">
              <Stage className="m-bleed">
                <HubbleDemoProvider scheme={demoScheme}>
                  <DemoFrame
                    palette
                    label="Interactive Hubble demo with sample data. Use the sidebar to move between Workspace, Graph, the Command Centre and Settings."
                    className={HERO_HEIGHT}
                  >
                    <DemoApp compactRailBelow={1024} />
                  </DemoFrame>
                </HubbleDemoProvider>
              </Stage>
              <p className="m-small mt-3 text-muted-foreground">
                A live Hubble with sample data. Nothing you do here leaves this page.
                <span className="hidden sm:inline"> Press ⌘K or Ctrl K inside it for the command palette.</span>
              </p>
            </div>
          </Container>
        </section>

        {/* ---- Works with --------------------------------------------------- */}
        <RevealSection className="m-page pb-[calc(var(--hb-v)*1.5)]">
          <Container>
            <h2 className="m-small m-reveal-item text-center text-foreground" style={revealStep(0)}>
              Works with the agents and tools you already use
            </h2>
            <ul className="m-reveal-item mt-6 grid grid-cols-2 gap-2.5 sm:grid-cols-4 lg:grid-cols-8" style={revealStep(1)}>
              {INTEGRATIONS.map((item) => (
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
            id="workspaces"
            title="Your context, structured."
            body="Hubble for Chrome turns a window of tabs into a workspace — sorted into sections, gathered into collections, duplicates flagged. Search it, filter it, or select tabs and gather them into a collection."
            link={
              installAction.href ? (
                <MoreLink href={installAction.href} external>
                  Get Hubble for Chrome
                </MoreLink>
              ) : (
                <MoreLink onClick={onInstallExtension}>Get Hubble for Chrome</MoreLink>
              )
            }
            stage={<DemoWindow scheme={demoScheme} label="Interactive Hubble workspace with sample tabs, sections and collections." init={{ view: "workspace", sidebarCollapsed: true }} />}
          />
          <FeatureSection
            id="command-centre"
            layout="wide"
            title="Command your agents."
            body="Every session in one place: what you asked, the Hubble tools the agent called, and the one decision it is waiting on. Allow the collection Claude Code proposes, deny it, or send it a message."
            link={<MoreLink onClick={onPasteTabs}>Open the Command Centre</MoreLink>}
            stage={
              <DemoWindow
                scheme={demoScheme}
                label="Interactive Hubble Command Centre with sample agent sessions."
                init={{ view: "command-centre", sidebarCollapsed: true, selectedSessionId: CLAUDE_SESSION }}
              />
            }
          />
          <FeatureSection
            id="graph"
            reverse
            title="See your work spatially."
            body="The graph draws how your tabs relate — shared sites, sections, collections and dependencies — clustered by category. Search it, filter the connections, or focus on one tab and its neighbours."
            stage={<DemoWindow scheme={demoScheme} label="Interactive Hubble graph of sample tabs." init={{ view: "graph", sidebarCollapsed: true }} />}
          />
          <FeatureSection
            id="context"
            layout="wide"
            title="Give agents the right context."
            body="An agent sees only what you attach — workspaces, collections, tabs, related tabs — and the picker previews it with the same resolver that builds what the agent receives. Attach some, and the composer says what went."
            stage={
              <DemoWindow
                scheme={demoScheme}
                label="Interactive Hubble session with its context panel and context picker."
                init={{ view: "command-centre", sidebarCollapsed: true, selectedSessionId: CLAUDE_SESSION, contextPanelOpen: true }}
                showSessions={false}
              />
            }
          />
          <FeatureSection
            id="agents"
            title="One interface for your agents."
            body="Claude Code, Gemini CLI and Grok Build run sessions in Hubble. Codex connects, and any MCP agent can read your workspaces. Each one runs on your own account or key."
            link={<MoreLink onClick={onPasteTabs}>Connect an agent</MoreLink>}
            stage={
              <DemoWindow
                scheme={demoScheme}
                label="Interactive Hubble Command Centre showing the connected agents."
                init={{ view: "command-centre", sidebarCollapsed: true, selectedSessionId: GEMINI_SESSION, contextPanelOpen: false }}
              />
            }
          />
        </div>

        {/* ---- Principles ---------------------------------------------------- */}
        <RevealSection className="m-section m-page">
          <Container>
            <h2 className="m-h2 m-reveal-item max-w-[810px] text-foreground" style={revealStep(0)}>
              A calmer way to work with agents.
            </h2>
            <div
              className="m-reveal-item mt-[calc(var(--hb-v)*2)] grid gap-x-10 gap-y-8 border-t border-border pt-8 lg:grid-cols-3"
              style={revealStep(1)}
            >
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
              Try Hubble now.
            </h2>
            <div className="m-reveal-item mt-6" style={revealStep(1)}>
              <HeroActions onOpenApp={onPasteTabs} exploreHref="#workspaces" />
            </div>
          </Container>
        </RevealSection>
      </main>

      <SiteFooter scheme={scheme} onScheme={setScheme} />
    </div>
  )
}

/** A feature section's window: a whole Hubble on its own demo state, mounted as it nears the viewport. */
function DemoWindow({
  label,
  init,
  scheme,
  showSessions,
}: {
  label: string
  init: DemoInit
  scheme: { value: Scheme; set: (scheme: Scheme) => void }
  showSessions?: boolean
}) {
  return (
    <Stage>
      <WhenNear className={WINDOW_HEIGHT}>
        <HubbleDemoProvider init={init} scheme={scheme}>
          <DemoFrame palette label={label} className="h-full">
            <DemoApp {...(showSessions === false ? { showSessions: false } : {})} />
          </DemoFrame>
        </HubbleDemoProvider>
      </WhenNear>
    </Stage>
  )
}

/** Integrations, read from the connector catalog so the row cannot claim more than Hubble does. */
const INTEGRATIONS: { name: string; note: string; mark: ReactNode }[] = [
  ...PLATFORM_PROVIDERS.map((spec) => ({
    name: spec.provider === "custom" ? "MCP" : spec.displayName,
    note: !spec.chat ? "Reads over MCP" : spec.sessions.available ? "Sessions" : "Connects",
    mark: <AgentIcon connector={spec.provider} size="sm" />,
  })),
  { name: "Claude Desktop", note: "Reads over MCP", mark: <MessagesSquare className="size-4" aria-hidden /> },
  { name: "Chrome", note: "Hubble for Chrome", mark: <Globe className="size-4" aria-hidden /> },
  { name: "Desktop", note: "Hubble Desktop", mark: <Monitor className="size-4" aria-hidden /> },
]

const PRINCIPLES: { title: string; body: string; icon: typeof KeyRound }[] = [
  {
    title: "Local first",
    body: "Workspaces, tabs and agent history live on your device. Sign in only if you want them synced.",
    icon: Laptop,
  },
  {
    title: "Your keys, your accounts",
    body: "Agents run on your own provider account or key. Hubble never pools credentials between people.",
    icon: KeyRound,
  },
  {
    title: "Nothing changes without you",
    body: "Agents see only the context you attach. Every change to a collection, every edit and every command waits for your approval.",
    icon: ShieldCheck,
  },
]

// The project's own history, newest first.
const CHANGELOG = [
  { date: "Sep 26, 2026", title: "A new name, Hubble, and a calmer interface" },
  { date: "Sep 25, 2026", title: "Agents that reason about your workspace" },
  { date: "Sep 25, 2026", title: "Workspace plans you approve in one step" },
  { date: "Sep 24, 2026", title: "Gemini CLI, Codex and Grok Build" },
]
