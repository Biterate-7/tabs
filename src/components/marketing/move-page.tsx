"use client"

import { useEffect, useState } from "react"
import { Download } from "lucide-react"
import { Button } from "@/components/ui/button"
import { saveTextFile } from "@/lib/platform"
import { exportBrowserProjects, findBrowserProjects, type BrowserProjects } from "@/lib/web-migration/browser-data"
import type { ReleaseView } from "@/lib/desktop/artifacts"
import { AppThemeStyle } from "./app-theme"
import { DownloadCta, ReleaseLine } from "./download-cta"
import { CHROME_SECTION_HREF, Container, SiteFooter, SiteHeader, useMarketingScheme } from "./site"
import { getExtensionInstallInfo } from "@/lib/extension-config"

const ROOT_ID = "hubble-move"

type Saved = { state: "idle" } | { state: "busy" } | { state: "saved"; projects: number; textUnreadable: string[] } | { state: "failed" }

/**
 * `/move` — taking projects made with Hubble on the web to Hubble Desktop.
 *
 * Everything the web app stored is still in this browser; this page writes
 * it out as one Hubble export file per account (src/lib/web-migration),
 * which Hubble Desktop imports from Settings → Data. Nothing is uploaded,
 * and nothing in the browser is changed or deleted.
 */
export function MovePage({ release }: { release: ReleaseView | null }) {
  const install = getExtensionInstallInfo()
  const [scheme, setScheme] = useMarketingScheme(ROOT_ID)
  const [found, setFound] = useState<BrowserProjects[] | null>(null)
  const [saved, setSaved] = useState<Record<string, Saved>>({})

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFound(findBrowserProjects())
  }, [])

  async function save(entry: BrowserProjects, index: number) {
    const key = entry.namespace ?? "signed-out"
    setSaved((current) => ({ ...current, [key]: { state: "busy" } }))
    try {
      const result = await exportBrowserProjects(entry.namespace)
      const date = new Date().toISOString().slice(0, 10)
      const name = found && found.length > 1 ? `hubble-projects-${index + 1}-${date}.json` : `hubble-projects-${date}.json`
      const ok = await saveTextFile(name, result.text, "application/json;charset=utf-8")
      setSaved((current) => ({ ...current, [key]: ok ? { state: "saved", projects: result.projects, textUnreadable: result.textUnreadable } : { state: "idle" } }))
    } catch {
      setSaved((current) => ({ ...current, [key]: { state: "failed" } }))
    }
  }

  return (
    <div id={ROOT_ID} className="tabdump-marketing min-h-screen">
      <AppThemeStyle />
      <SiteHeader install={install.mode === "store" ? { label: "Hubble for Chrome", href: install.url } : { label: "Hubble for Chrome", href: CHROME_SECTION_HREF }} />
      <main>
        <section className="m-page pt-12 pb-[calc(var(--hb-v)*2)] sm:pt-(--hb-hero-top)">
          <Container>
            <p className="m-small text-muted-foreground">Moving to Hubble Desktop</p>
            <h1 className="m-hero mt-3 max-w-[720px] text-foreground">Bring your projects to the app.</h1>
            <p className="m-body mt-3 max-w-[620px] text-muted-foreground">
              Hubble is now a desktop app. The projects you made on this website are still saved in this browser — save them to a file here, then import that file in Hubble Desktop. Nothing is uploaded, and nothing here is deleted.
            </p>
          </Container>
        </section>

        <section aria-labelledby="move-steps" className="m-page pb-[calc(var(--hb-v)*2)]">
          <Container>
            <h2 id="move-steps" className="sr-only">
              Steps
            </h2>
            <ol className="grid gap-2.5 lg:grid-cols-3">
              <li className="m-card flex flex-col gap-3 px-[17.5px] pt-[15.9px] pb-5">
                <p className="m-body text-muted-foreground">1</p>
                <p className="m-body text-foreground">Install Hubble Desktop</p>
                <div>
                  <DownloadCta release={release} />
                </div>
                <ReleaseLine release={release} />
              </li>
              <li className="m-card flex flex-col gap-3 px-[17.5px] pt-[15.9px] pb-5" aria-live="polite">
                <p className="m-body text-muted-foreground">2</p>
                <p className="m-body text-foreground">Save your projects to a file</p>
                {found === null ? (
                  <p className="m-small text-muted-foreground">Looking in this browser…</p>
                ) : found.length === 0 ? (
                  <p className="m-small text-muted-foreground">
                    This browser has no Hubble projects. If you used Hubble in another browser or profile, open this page there.
                  </p>
                ) : (
                  <ul className="flex flex-col gap-3">
                    {found.map((entry, index) => {
                      const key = entry.namespace ?? "signed-out"
                      const status = saved[key] ?? { state: "idle" }
                      return (
                        <li key={key} className="flex flex-col gap-1.5">
                          <p className="m-small text-foreground">
                            {entry.namespace === null ? "Saved while signed out" : found.filter((other) => other.namespace !== null).length > 1 ? `Saved while signed in (account ${index})` : "Saved while signed in"}
                            {" · "}
                            {entry.projects === 1 ? "1 project" : `${entry.projects} projects`}, {entry.items === 1 ? "1 item" : `${entry.items} items`}
                          </p>
                          <div>
                            <Button type="button" size="sm" disabled={status.state === "busy"} onClick={() => void save(entry, index)}>
                              <Download aria-hidden /> {status.state === "busy" ? "Saving…" : "Save to a file"}
                            </Button>
                          </div>
                          {status.state === "saved" && (
                            <p role="status" className="m-small text-foreground">
                              Saved {status.projects === 1 ? "1 project" : `${status.projects} projects`} with their text.
                              {status.textUnreadable.length > 0 && ` The saved text of ${status.textUnreadable.join(", ")} couldn't be read; their links and notes are in the file.`}
                            </p>
                          )}
                          {status.state === "failed" && (
                            <p role="alert" className="m-small text-destructive">
                              Couldn&rsquo;t save the file. Nothing changed here — try again.
                            </p>
                          )}
                        </li>
                      )
                    })}
                  </ul>
                )}
              </li>
              <li className="m-card flex flex-col gap-3 px-[17.5px] pt-[15.9px] pb-5">
                <p className="m-body text-muted-foreground">3</p>
                <p className="m-body text-foreground">Import it in Hubble Desktop</p>
                <p className="m-small text-muted-foreground">
                  Open Hubble Desktop, go to <span className="text-foreground">Settings → Projects → Import projects…</span>, and choose the file. Your projects, links, notes and saved text open in the app.
                </p>
                <p className="m-small text-muted-foreground">
                  Signed in to sync? Sign in to Hubble Desktop with the same account too — synced projects follow you, and the file brings their text.
                </p>
              </li>
            </ol>
          </Container>
        </section>
      </main>
      <SiteFooter scheme={scheme} onScheme={setScheme} />
    </div>
  )
}
