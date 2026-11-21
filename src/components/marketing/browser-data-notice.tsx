"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { findBrowserProjects } from "@/lib/web-migration/browser-data"
import { Container } from "./site"

/**
 * For someone who used Hubble on the web: their projects are still in this
 * browser, and here is how to take them to Hubble Desktop.
 *
 * Read after hydration, from this origin's own storage, and never shown
 * inside the desktop app. Shows nothing at all to a first-time visitor.
 */
export function BrowserDataNotice() {
  const inDesktopApp = useIsDesktop()
  const [projects, setProjects] = useState(0)
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setProjects(findBrowserProjects().reduce((sum, entry) => sum + entry.projects, 0))
  }, [])
  if (inDesktopApp || projects === 0) return null
  return (
    <div role="region" aria-label="Your projects in this browser" className="m-page border-b border-border bg-card">
      <Container className="flex flex-wrap items-center justify-between gap-x-6 gap-y-2 py-3">
        <p className="m-small text-foreground">
          Hubble is now a desktop app. Your {projects === 1 ? "project is" : `${projects} projects are`} still saved in this browser.
        </p>
        <Link href="/move" className="m-link m-small inline-flex items-center gap-1">
          Move {projects === 1 ? "it" : "them"} to Hubble Desktop <span aria-hidden>→</span>
        </Link>
      </Container>
    </div>
  )
}
