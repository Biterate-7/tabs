"use client"

import { useState, type ReactNode } from "react"
import { Download } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { EXTENSION_INSTALL_STEPS } from "@/components/extension-install-guide"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { ARCH_LABEL, FORMAT_LABEL, artifactHref, artifactsFor, type DesktopArtifact, type ReleaseView } from "@/lib/desktop/artifacts"
import { DESKTOP_OSES, DESKTOP_OS_LABEL, formatInstallerSize, type DesktopOs } from "@/lib/desktop/release"
import { EXTENSION_DOWNLOAD_URL, getExtensionInstallInfo } from "@/lib/extension-config"
import { cn } from "@/lib/utils"
import { AppThemeStyle } from "./app-theme"
import { DownloadCta, ReleaseLine, SYSTEM_REQUIREMENTS, availablePlatforms, useVisitorOs } from "./download-cta"
import { CHROME_SECTION_HREF, Container, MoreLink, SiteFooter, SiteHeader, useMarketingScheme, type PrimaryAction } from "./site"

const ROOT_ID = "hubble-download"

/** How to install each OS's build — shown only for an OS that has one. */
const INSTALL_STEPS: Record<DesktopOs, ReactNode[]> = {
  windows: [
    "Run the installer you downloaded. It installs for you only, so it needs no administrator rights.",
    "Hubble opens when it finishes, and is in the Start menu after that.",
    <>
      The installer isn&rsquo;t code-signed yet, so Windows may show a SmartScreen notice. Before you run it, you can check that its SHA-256 matches the one listed on this page.
    </>,
  ],
  macos: [
    "Open the .dmg you downloaded and drag Hubble to Applications.",
    "Open Hubble from Applications.",
    "This build isn't notarized by Apple yet, so macOS asks you to confirm the first time it opens.",
  ],
  linux: [
    <>
      AppImage: make it executable (<code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">chmod +x Hubble_*.AppImage</code>), then run it.
    </>,
    <>
      .deb: install it with <code className="rounded bg-muted px-1 py-0.5 text-[0.85em]">sudo apt install ./Hubble_*.deb</code>, then open Hubble from your app menu.
    </>,
  ],
}

/**
 * `/download` — Hubble Desktop, and how to get it.
 *
 * Every installer offered is a file on the latest published GitHub Release
 * (src/lib/desktop/release-source.ts, read strictly by artifacts.ts); an OS
 * with no installer there says so and offers nothing. Each link goes through
 * /api/download, which counts the download and redirects to that file — the
 * raw release URL is never in the page. The visitor's OS picks which build
 * is offered first, after hydration.
 *
 * The page is part of the desktop app's static export too. Opened there, it
 * says the visitor already has Hubble Desktop instead of offering it.
 */
export function DownloadPage({ release }: { release: ReleaseView | null }) {
  const install = getExtensionInstallInfo()
  const [scheme, setScheme] = useMarketingScheme(ROOT_ID)
  const inDesktopApp = useIsDesktop()
  const visitor = useVisitorOs()
  const [started, setStarted] = useState(false)
  const platforms = availablePlatforms(release)
  const installAction: PrimaryAction = install.mode === "store" ? { label: "Hubble for Chrome", href: install.url } : { label: "Hubble for Chrome", href: CHROME_SECTION_HREF }

  return (
    <div id={ROOT_ID} className="tabdump-marketing min-h-screen">
      <AppThemeStyle />
      <SiteHeader install={installAction} />

      <main>
        {/* ---- Hero -------------------------------------------------------- */}
        <section className="m-page pt-12 pb-[calc(var(--hb-v)*2)] sm:pt-(--hb-hero-top)">
          <Container className="flex flex-col items-center text-center">
            <p className="m-small text-muted-foreground">Download</p>
            <h1 className="m-hero mt-3 max-w-[720px] text-foreground">Hubble for your computer.</h1>
            <p className="m-body mt-4 max-w-[560px] text-muted-foreground">
              The Hubble app keeps your projects, AI conversations and notes on your computer. Add Hubble for Chrome to save from your browser.
            </p>
            <div className="mt-8 flex w-full flex-col items-center">
              {inDesktopApp ? (
                <p role="status" className="m-body text-foreground">
                  You&rsquo;re using Hubble Desktop.
                </p>
              ) : (
                <>
                  <DownloadCta release={release} onStart={() => setStarted(true)} />
                  <ReleaseLine release={release} className="mt-3" />
                  {started && (
                    <p role="status" className="m-small mt-2 text-foreground">
                      Your download has started. When it finishes, open it —{" "}
                      <a href="#install" className="m-link">
                        how to install
                      </a>
                      .
                    </p>
                  )}
                </>
              )}
            </div>
          </Container>
        </section>

        {/* ---- Platforms ----------------------------------------------------- */}
        {!inDesktopApp && (
          <section id="platforms" aria-labelledby="platforms-title" className="m-page scroll-mt-(--hb-header-h) pb-[calc(var(--hb-v)*2)]">
            <Container>
              <h2 id="platforms-title" className="m-title text-foreground">
                All platforms
              </h2>
              <ul className="mt-6 grid gap-2.5 lg:grid-cols-3">
                {DESKTOP_OSES.map((os) => {
                  const artifacts = artifactsFor(release, os)
                  return (
                    <li key={os} className={cn("m-card flex flex-col gap-3 px-[17.5px] py-4", os === visitor && "ring-1 ring-border")}>
                      <div>
                        <p className="m-body text-foreground">{DESKTOP_OS_LABEL[os]}</p>
                        <p className="m-small text-muted-foreground">{artifacts.length > 0 ? SYSTEM_REQUIREMENTS[os] : "Not available yet"}</p>
                      </div>
                      {artifacts.length > 0 && (
                        <ul className="flex flex-col gap-2">
                          {artifacts.map((artifact) => (
                            <ArtifactRow key={artifact.name} artifact={artifact} release={release} onStart={() => setStarted(true)} />
                          ))}
                        </ul>
                      )}
                    </li>
                  )
                })}
              </ul>
            </Container>
          </section>
        )}

        {/* ---- Release notes ------------------------------------------------- */}
        {release && (
          <section id="release" aria-labelledby="release-title" className="m-section m-page scroll-mt-(--hb-header-h)">
            <Container>
              <h2 id="release-title" className="m-title text-foreground">
                What&rsquo;s in {release.version}
              </h2>
              <p className="m-small mt-1 text-muted-foreground">
                {release.publishedAt ? `Released ${new Date(release.publishedAt).toLocaleDateString("en-US", { year: "numeric", month: "long", day: "numeric", timeZone: "UTC" })}` : `Version ${release.version}`}
              </p>
              <div className="m-card mt-6 max-w-[760px] px-[17.5px] py-4">
                <ReleaseNotes notes={release.notes} />
                <div className="mt-4">
                  <MoreLink href={release.pageUrl} external>
                    Release on GitHub
                  </MoreLink>
                </div>
              </div>
            </Container>
          </section>
        )}

        {/* ---- Install ------------------------------------------------------- */}
        {platforms.length > 0 && (
          <section id="install" aria-labelledby="install-title" className="m-section m-page scroll-mt-(--hb-header-h)">
            <Container>
              <h2 id="install-title" className="m-title text-foreground">
                Install
              </h2>
              <div className="mt-6 grid gap-2.5 lg:grid-cols-3">
                {platforms.map((os) => (
                  <article key={os} className="m-card px-[17.5px] pt-[15.9px] pb-5">
                    <h3 className="m-body text-foreground">{DESKTOP_OS_LABEL[os]}</h3>
                    <ol className="mt-2 flex list-decimal flex-col gap-1.5 pl-5">
                      {INSTALL_STEPS[os].map((step, index) => (
                        <li key={index} className="m-small text-muted-foreground">
                          {step}
                        </li>
                      ))}
                    </ol>
                  </article>
                ))}
              </div>
            </Container>
          </section>
        )}

        {/* ---- Hubble for Chrome --------------------------------------------- */}
        <section id="chrome" aria-labelledby="chrome-title" className="m-section m-page scroll-mt-(--hb-header-h)">
          <Container>
            <h2 id="chrome-title" className="m-title text-foreground">
              Hubble for Chrome
            </h2>
            <p className="m-body mt-2 max-w-[640px] text-muted-foreground">
              The companion extension. It saves conversations from ChatGPT, Claude, Gemini and Perplexity, and the tabs you choose, into Hubble Desktop — and brings what you saved back into your next AI chat.
            </p>
            <div className="mt-6 grid gap-2.5 lg:grid-cols-2">
              <article className="m-card px-[17.5px] pt-[15.9px] pb-5">
                <h3 className="m-body text-foreground">Install it</h3>
                {install.mode === "store" ? (
                  <div className="mt-3">
                    <a href={install.url} target="_blank" rel="noopener noreferrer" className={buttonVariants({ variant: "secondary", size: "hero" })}>
                      Add to Chrome
                    </a>
                  </div>
                ) : (
                  <>
                    <div className="mt-3">
                      <a href={EXTENSION_DOWNLOAD_URL} download className={buttonVariants({ variant: "secondary", size: "hero" })}>
                        <Download aria-hidden />
                        Download Hubble for Chrome
                      </a>
                    </div>
                    <ol className="mt-4 flex list-decimal flex-col gap-1.5 pl-5">
                      {EXTENSION_INSTALL_STEPS.slice(1).map((step, index) => (
                        <li key={index} className="m-small text-muted-foreground">
                          {step}
                        </li>
                      ))}
                    </ol>
                  </>
                )}
              </article>
              <article id="how-they-connect" className="m-card scroll-mt-(--hb-header-h) px-[17.5px] pt-[15.9px] pb-5">
                <h3 className="m-body text-foreground">How they connect</h3>
                <p className="m-small mt-2 text-muted-foreground" aria-label="Hubble for Chrome, then a paired connection on this computer, then Hubble Desktop, then your projects">
                  Hubble for Chrome → paired connection on this computer → Hubble Desktop → your projects
                </p>
                <ul className="mt-3 flex list-disc flex-col gap-1.5 pl-5">
                  <li className="m-small text-muted-foreground">The first time, the extension asks to connect and Hubble Desktop shows the same code. Approve it in the app; you can disconnect it any time in Settings.</li>
                  <li className="m-small text-muted-foreground">They talk over a private connection on your own computer that web pages can&rsquo;t use. Nothing goes through a server.</li>
                  <li className="m-small text-muted-foreground">Hubble Desktop works without the extension. Without the app, the extension keeps what you save and delivers it the next time Hubble is open.</li>
                </ul>
              </article>
            </div>
          </Container>
        </section>

        {/* ---- From the web app ---------------------------------------------- */}
        <section aria-labelledby="from-web" className="m-section m-page">
          <Container>
            <h2 id="from-web" className="m-title text-foreground">
              Used Hubble on the web?
            </h2>
            <p className="m-body mt-2 max-w-[640px] text-muted-foreground">Your projects are still saved in that browser. Move them into the app in a minute.</p>
            <div className="mt-4">
              <MoreLink href="/move">Move your projects to Hubble Desktop</MoreLink>
            </div>
          </Container>
        </section>
      </main>

      <SiteFooter scheme={scheme} onScheme={setScheme} />
    </div>
  )
}

function ArtifactRow({ artifact, release, onStart }: { artifact: DesktopArtifact; release: ReleaseView | null; onStart: () => void }) {
  const size = formatInstallerSize(artifact.bytes)
  return (
    <li className="flex flex-col gap-0.5">
      <a href={artifactHref(artifact, release)} onClick={onStart} className="m-link m-small inline-flex items-center gap-1">
        {FORMAT_LABEL[artifact.format]}
        {artifact.os !== "windows" || artifact.arch !== "x64" ? ` · ${ARCH_LABEL[artifact.arch]}` : ""}
      </a>
      <span className="m-small text-muted-foreground">{[artifact.name, size].filter(Boolean).join(" · ")}</span>
      {artifact.sha256 && (
        <span className="m-small break-all font-mono text-[11px] text-muted-foreground" title="SHA-256">
          SHA-256 {artifact.sha256}
        </span>
      )}
    </li>
  )
}

/**
 * Release notes as written on the GitHub release, shown as text: paragraphs
 * and "- " bullets, Markdown emphasis and links left as their plain words.
 * Never parsed as HTML.
 */
export function ReleaseNotes({ notes }: { notes: string }) {
  const lines = notes
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !/^#{1,6}\s*$/.test(line))
  if (lines.length === 0) return <p className="m-small text-muted-foreground">No notes for this release.</p>
  const plain = (text: string) => text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1").replace(/[*_`]+/g, "")
  const blocks: ReactNode[] = []
  let bullets: string[] = []
  const flush = () => {
    if (bullets.length === 0) return
    const items = bullets
    blocks.push(
      <ul key={`list-${blocks.length}`} className="flex list-disc flex-col gap-1 pl-5">
        {items.map((item, index) => (
          <li key={index} className="m-small text-muted-foreground">
            {plain(item)}
          </li>
        ))}
      </ul>
    )
    bullets = []
  }
  for (const line of lines) {
    const bullet = line.match(/^[-*]\s+(.*)$/)
    if (bullet) {
      bullets.push(bullet[1]!)
      continue
    }
    flush()
    const heading = line.match(/^#{1,6}\s+(.*)$/)
    blocks.push(
      heading ? (
        <p key={`h-${blocks.length}`} className="m-body text-foreground">
          {plain(heading[1]!)}
        </p>
      ) : (
        <p key={`p-${blocks.length}`} className="m-small text-muted-foreground">
          {plain(line)}
        </p>
      )
    )
  }
  flush()
  return <div className="flex flex-col gap-2">{blocks}</div>
}
