"use client"

import { useMemo, type ReactNode } from "react"
import { Globe, KeyRound, Laptop, MessagesSquare, Monitor, ShieldCheck } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import { CLAUDE_SESSION, CODEX_AUTH_SESSION, GEMINI_SESSION } from "./demo/data"
import { DemoApp } from "./demo/demo-app"
import { DemoFrame } from "./demo/demo-frame"
import { HubbleDemoProvider } from "./demo/demo-provider"
import type { DemoInit } from "./demo/demo-state"
import { DemoThemeStyle } from "./demo/demo-theme"
import { RevealSection, revealStep } from "./reveal"
import { ProjectLoopDemo } from "./project-loop-demo"
import {
  Container,
  FeatureSection,
  HeroActions,
  MoreLink,
  SiteFooter,
  SiteHeader,
  Stage,
  WhenNear,
  useDesktopLink,
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
 * the connector catalog, and every agent it names runs sessions that ask
 * before acting; the changelog is the project's own history.
 */
export function MarketingPage({ onInstallExtension, onPasteTabs }: MarketingPageProps) {
  const install = getExtensionInstallInfo()
  const installAction: PrimaryAction =
    install.mode === "store"
      ? { label: "Hubble for Chrome", href: install.url }
      : { label: "Hubble for Chrome", onClick: onInstallExtension }
  const [scheme, setScheme] = useMarketingScheme(ROOT_ID)
  const demoScheme = useMemo(() => ({ value: scheme, set: setScheme }), [scheme, setScheme])
  // Hubble Desktop, closing the page — absent inside the desktop app itself.
  const desktopLink = useDesktopLink()

  return (
    <div id={ROOT_ID} className="tabdump-marketing min-h-screen">
      <DemoThemeStyle />
      <SiteHeader install={installAction} onOpenApp={onPasteTabs} />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-12 pb-[calc(var(--hb-v)*2)] sm:pt-(--hb-hero-top)">
          <Container>
            <h1 className="m-hero max-w-[640px] text-foreground">
              Your projects. Your context. Your agents.
            </h1>
            <p className="m-body mt-3 max-w-[600px] text-muted-foreground">
              Collect sources from Chrome into a project, then let Claude, Gemini, Codex or Grok work from the same context — and hand the work from one to another.
            </p>
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

        {/* ---- The loop: project → context → agent → work --------------------- */}
        <RevealSection id="how-it-works" className="m-page pb-[calc(var(--hb-v)*1.5)] scroll-mt-(--hb-header-h)">
          <Container>
            <h2 className="m-h2 m-reveal-item max-w-[810px] text-foreground" style={revealStep(0)}>
              Project → Context → Agent → Work.
            </h2>
            <p className="m-body m-reveal-item mt-3 max-w-[640px] text-muted-foreground" style={revealStep(1)}>
              The project is what lasts. Agents come and go; each one starts from the same sources, the same brief and the work done before it.
            </p>
            <div className="m-reveal-item mt-8" style={revealStep(2)}>
              <ProjectLoopDemo />
            </div>
          </Container>
        </RevealSection>

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
            title="Collect context from Chrome."
            body="Drag a link or the address bar into a project, or add the current tab with Hubble for Chrome. Hubble reads web pages and PDFs, keeps a video's details and any transcript you add, says plainly what it couldn't read, and won't add the same source twice. Whole windows of tabs still sort themselves into sections and collections."
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
            body="Give an agent a task on your project, with the research it needs attached. Approve the exact files it wants to change, see what Hubble measured, review the diff, run the project’s checks — and come back to it tomorrow, or hand it to another agent."
            link={<MoreLink onClick={onPasteTabs}>Open the Command Centre</MoreLink>}
            stage={
              <DemoWindow
                scheme={demoScheme}
                label="Interactive Hubble Command Centre: Codex asking to change two files in a sample project."
                init={{ view: "command-centre", sidebarCollapsed: true, selectedSessionId: CODEX_AUTH_SESSION, contextPanelOpen: false }}
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
            body="An agent is told what the project holds and reads its sources when it needs them — PDF pages, transcripts, articles — citing where each point came from. It sees only the project you're in and the sources you chose, and a source's text is always treated as material, never as instructions."
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
            title="Switch agents. Keep the project."
            body="Claude Code, Gemini CLI, Grok Build and Codex run sessions in Hubble, asking you before they change anything. Hand Claude's work to Gemini and it starts from the same project, the same sources and — if you choose — Claude's answer. Each agent runs on your own account or key."
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
              <HeroActions onOpenApp={onPasteTabs} exploreHref="#workspaces" secondary={desktopLink} />
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
    name: spec.shortName,
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
    body: "You see what an agent will use before it starts. Every change to a collection, every edit and every command waits for your approval.",
    icon: ShieldCheck,
  },
]

// The project's own history, newest first.
const CHANGELOG = [
  { date: "Oct 6, 2026", title: "Projects: collect sources from Chrome, and let any agent work from them" },
  { date: "Sep 26, 2026", title: "A new name, Hubble, and a calmer interface" },
  { date: "Sep 25, 2026", title: "Agents that reason about your workspace" },
  { date: "Sep 25, 2026", title: "Workspace plans you approve in one step" },
  { date: "Sep 24, 2026", title: "Gemini CLI, Codex and Grok Build" },
]
