"use client"

import { useEffect, useState, type ReactNode } from "react"
import { desktopDurableStore } from "@/lib/platform/desktop"
import { isDesktop } from "@/lib/platform/detect"
import { startDurableStorage } from "@/lib/platform/durable-storage"

/**
 * Hubble is a desktop app. Its frontend is a static bundle that only Hubble
 * Desktop loads (src/app/page.desktop.tsx exists only in the desktop build),
 * but a copy of that bundle opened in an ordinary browser would otherwise run
 * as a browser app — with no account, no extension link and no native
 * storage behind it. In a production build this says so and points to the
 * download instead.
 *
 * Development keeps the browser open on purpose: `npm run desktop:dev` serves
 * the same bundle on localhost, and the QA rigs drive it from Chrome.
 *
 * Decided after mount: the static export is prerendered without a webview,
 * so a render-time answer would disagree with hydration.
 *
 * In Hubble Desktop the app also waits for localStorage's durable copy to be
 * restored (lib/platform/durable-storage.ts), so it never reads the older
 * values a crash left behind.
 */
export function DesktopOnlyGate({ downloadUrl, children }: { downloadUrl: string; children: ReactNode }) {
  const [allowed, setAllowed] = useState<boolean | null>(null)

  useEffect(() => {
    let active = true
    if (isDesktop()) {
      void startDurableStorage(desktopDurableStore).then(() => {
        if (active) setAllowed(true)
      })
    } else {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- one read of the shell after mount (see above)
      setAllowed(process.env.NODE_ENV !== "production")
    }
    return () => {
      active = false
    }
  }, [])

  if (allowed === null) return null
  if (allowed) return <>{children}</>
  return (
    <main className="flex min-h-screen flex-1 flex-col items-center justify-center gap-4 bg-background px-6 text-center">
      <h1 className="text-title font-medium text-foreground">Hubble runs as a desktop app</h1>
      <p className="max-w-sm text-body text-muted-foreground">This page is part of Hubble Desktop and doesn&apos;t work in a browser. Install Hubble to use it.</p>
      <a className="text-body text-link hover:underline" href={downloadUrl}>
        Download Hubble
      </a>
    </main>
  )
}
