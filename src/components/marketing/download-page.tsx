"use client"

import { useEffect, useState } from "react"
import { useRouter } from "next/navigation"
import { ArrowRight, Download } from "lucide-react"
import { AgentIcon } from "@/components/agents/agent-icon"
import { offeredAuthMethods } from "@/lib/agents/platform/authentication"
import { buttonVariants } from "@/components/ui/button"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import {
  DESKTOP_OS_LABEL,
  currentVisitorOs,
  desktopOffer,
  downloadHref,
  statusLabel,
  type DesktopOs,
  type VisitorOs,
} from "@/lib/desktop/release"
import { getExtensionInstallInfo } from "@/lib/extension-config"
import { dismissOnboarding } from "@/lib/onboarding"
import { cn } from "@/lib/utils"
import { Container, MoreLink, SiteFooter, SiteHeader, useMarketingScheme, type PrimaryAction } from "./site"

const ROOT_ID = "hubble-download"
const OSES: readonly DesktopOs[] = ["windows", "macos", "linux"]

/**
 * The agents Hubble Desktop brings in: every catalogue agent the desktop app
 * starts on the visitor's machine. Read from the catalogue, so the page can
 * never name one the app does not run — an MCP client connects to Hubble
 * rather than being run by it, and the desktop app runs no MCP server.
 */
const LOCAL_AGENTS = PLATFORM_PROVIDERS.filter((spec) => spec.transport !== "mcp" && spec.surfaces.includes("desktop"))

/**
 * "Codex with your ChatGPT account, …": each local agent's own account
 * sign-in on the desktop, from the catalogue. Two examples are enough.
 */
const SIGN_IN_EXAMPLES = LOCAL_AGENTS.flatMap((spec) => {
  const account = offeredAuthMethods(spec, "desktop").find(({ method }) => method.kind === "account" && method.owner === "runtime")
  return account ? [`${spec.displayName} with your ${account.method.label}`] : []
}).slice(0, 2)

const STEPS = [
  { title: "Install Hubble", body: "Run the Hubble installer." },
  { title: "Open Hubble", body: "Like any other app on your computer." },
  { title: "Connect your agents", body: "Open the Command Centre and choose Connect agent." },
  {
    title: "Sign in to each agent",
    body: SIGN_IN_EXAMPLES.length ? `With its own account — ${SIGN_IN_EXAMPLES.join(", ")}.` : "With its own account.",
  },
  { title: "Start working", body: "Attach a workspace and start a session." },
] as const

/**
 * `/download` — Hubble Desktop, and how to get it.
 *
 * Says only what is true of this commit: the download action is a real
 * GitHub Release asset or it is absent (lib/desktop/release.ts). Every
 * download link goes through /api/download, which counts the download and
 * redirects to that asset; the raw release URL is never in the page. The
 * visitor's OS picks which build is offered first, after hydration; every OS
 * is listed with its real status whatever it is.
 *
 * The page is part of the desktop app's static export too. Opened there, it
 * says the visitor already has Hubble Desktop instead of offering it.
 */
export function DownloadPage() {
  const router = useRouter()
  const install = getExtensionInstallInfo()
  const [scheme, setScheme] = useMarketingScheme(ROOT_ID)
  const inDesktopApp = useIsDesktop()
  // Unknown on the server and during hydration; the browser's own answer after.
  const [visitor, setVisitor] = useState<VisitorOs>("unknown")
  const [started, setStarted] = useState(false)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitor(currentVisitorOs())
  }, [])

  function enterApp() {
    // As on /welcome: recorded first, so `/` opens the app rather than the landing page.
    dismissOnboarding()
    router.push("/")
  }

  // The Chrome extension's guide lives on the landing page; from here, a store link or that page.
  const installAction: PrimaryAction =
    install.mode === "store" ? { label: "Hubble for Chrome", href: install.url } : { label: "Hubble for Chrome", onClick: () => router.push("/welcome#workspaces") }

  return (
    <div id={ROOT_ID} className="tabdump-marketing min-h-screen">
      <SiteHeader install={installAction} onOpenApp={enterApp} linkBase="/welcome" showDesktopLink={false} />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-12 pb-[calc(var(--hb-v)*2)] sm:pt-(--hb-hero-top)">
          <Container className="flex flex-col items-center text-center">
            <p className="m-small text-muted-foreground">Hubble Desktop</p>
            <h1 className="m-hero mt-3 max-w-[720px] text-foreground">
              Your workspace, connected to the agents already running on your computer.
            </h1>
            <p className="m-body mt-4 max-w-[520px] text-muted-foreground">Bring your local AI agents into Hubble.</p>
            <div className="mt-8 flex w-full flex-col items-center">
              {inDesktopApp ? (
                <p role="status" className="m-body text-foreground">
                  You&rsquo;re using Hubble Desktop.
                </p>
              ) : (
                <DownloadAction visitor={visitor} started={started} onStart={() => setStarted(true)} onOpenApp={enterApp} />
              )}
            </div>
          </Container>
        </section>

        {/* ---- Platforms ----------------------------------------------------- */}
        {!inDesktopApp && (
          <section aria-labelledby="platforms" className="m-page pb-[calc(var(--hb-v)*2)]">
            <Container>
              <h2 id="platforms" className="sr-only">
                Platforms
              </h2>
              <ul className="mx-auto grid max-w-[720px] gap-2.5 sm:grid-cols-3">
                {OSES.map((os) => {
                  const href = downloadHref(os)
                  return (
                    <li key={os} className={cn("m-card flex flex-col gap-1 px-[17.5px] py-4", os === visitor && "ring-1 ring-border")}>
                      <span className="m-body text-foreground">{DESKTOP_OS_LABEL[os]}</span>
                      {href ? (
                        <a href={href} className="m-link m-small inline-flex items-center gap-1" onClick={() => setStarted(true)}>
                          Download · {statusLabel(os)}
                        </a>
                      ) : (
                        <span className="m-small text-muted-foreground">{statusLabel(os)}</span>
                      )}
                    </li>
                  )
                })}
              </ul>
            </Container>
          </section>
        )}

        {/* ---- Works with ---------------------------------------------------- */}
        <section aria-labelledby="local-agents" className="m-section m-page">
          <Container>
            <h2 id="local-agents" className="m-small text-center text-foreground">
              Works with your local agents
            </h2>
            <ul className="mx-auto mt-6 grid max-w-[720px] grid-cols-2 gap-2.5 sm:grid-cols-4">
              {LOCAL_AGENTS.map((spec) => (
                <li key={spec.provider} className="m-card flex h-[100px] flex-col items-center justify-center gap-2 px-2 text-center">
                  <span className="flex items-center gap-2 text-foreground">
                    <AgentIcon connector={spec.provider} size="sm" />
                    <span className="text-[15px] leading-none font-medium tracking-[-0.015em] whitespace-nowrap">{spec.displayName}</span>
                  </span>
                  <span className="m-small text-[12px] text-muted-foreground">{spec.vendor}</span>
                </li>
              ))}
            </ul>
            <p className="m-body mx-auto mt-8 max-w-[560px] text-center text-muted-foreground">
              Hubble Desktop lets agents run on your computer, while Hubble gives them the workspace and context they need to
              work with you. Every change they make still waits for your approval.
            </p>
          </Container>
        </section>

        {/* ---- Web and Desktop ----------------------------------------------- */}
        <section aria-labelledby="web-and-desktop" className="m-section m-page">
          <Container>
            <h2 id="web-and-desktop" className="m-title text-foreground">
              Web or Desktop
            </h2>
            <div className="mt-6 grid gap-2.5 md:grid-cols-2">
              <article className="m-card flex flex-col px-[17.5px] pt-[15.9px] pb-5">
                <h3 className="m-body text-foreground">Hubble Web</h3>
                <p className="m-body text-muted-foreground">Use Hubble directly in your browser. Nothing to install.</p>
                <div className="mt-4">
                  <MoreLink onClick={enterApp}>Open Hubble</MoreLink>
                </div>
              </article>
              <article className="m-card flex flex-col px-[17.5px] pt-[15.9px] pb-5">
                <h3 className="m-body text-foreground">Hubble Desktop</h3>
                <p className="m-body text-muted-foreground">
                  Bring your local AI agents into Hubble. Local agents run on your computer, so Hubble Desktop is required to
                  connect them.
                </p>
                <p className="m-small mt-3 text-muted-foreground">
                  Hubble Desktop keeps its own workspaces on your computer, separate from your browser.
                </p>
              </article>
            </div>
          </Container>
        </section>

        {/* ---- Getting started ----------------------------------------------- */}
        <section id="next-steps" aria-labelledby="getting-started" className="m-section m-page scroll-mt-(--hb-header-h)">
          <Container>
            <h2 id="getting-started" className="m-title text-foreground">
              {started ? "Next steps" : "Getting started"}
            </h2>
            <ol className="mt-6 grid gap-2.5 sm:grid-cols-2 lg:grid-cols-5">
              {STEPS.map((step, index) => (
                <li key={step.title} className="m-card px-[17.5px] pt-[15.9px] pb-5">
                  <p className="m-body text-muted-foreground">{index + 1}</p>
                  <p className="m-body text-foreground">{step.title}</p>
                  <p className="m-small mt-1 text-muted-foreground">{step.body}</p>
                </li>
              ))}
            </ol>
            <p className="m-small mt-6 max-w-[640px] text-muted-foreground">
              Nothing carries over from this website: each agent signs in on your computer, through its own sign-in.
            </p>
          </Container>
        </section>
      </main>

      <SiteFooter scheme={scheme} onScheme={setScheme} linkBase="/welcome" />
    </div>
  )
}

/** The page's one primary action, for the visitor's OS — a real installer, or the honest reason there is none. */
function DownloadAction({
  visitor,
  started,
  onStart,
  onOpenApp,
}: {
  visitor: VisitorOs
  started: boolean
  onStart: () => void
  onOpenApp: () => void
}) {
  const offer = desktopOffer(visitor)

  if (offer.kind === "download") {
    return (
      <>
        <a href={offer.href} onClick={onStart} className={buttonVariants({ size: "hero" })}>
          <Download aria-hidden />
          {offer.label}
        </a>
        <p className="m-small mt-3 text-muted-foreground">
          {offer.requirements} · Version {offer.version}
        </p>
        {started && (
          <p role="status" className="m-small mt-2 text-foreground">
            Your download has started. When it finishes, open the installer —{" "}
            <a href="#next-steps" className="m-link">
              next steps
            </a>
            .
          </p>
        )}
      </>
    )
  }

  return (
    <>
      <p className="m-title text-foreground">{offer.label}</p>
      {/* "Coming soon" / "Not available" for an OS with no build; the full sentence for an unpublished one. */}
      <p role="status" className="m-body mt-1 text-muted-foreground">
        {offer.kind === "unavailable" && offer.os !== "windows" ? statusLabel(offer.os) : offer.reason}
      </p>
      <div className="mt-6">
        <button type="button" onClick={onOpenApp} className={buttonVariants({ variant: "secondary", size: "hero" })}>
          Use Hubble in your browser
          <ArrowRight aria-hidden />
        </button>
      </div>
    </>
  )
}
