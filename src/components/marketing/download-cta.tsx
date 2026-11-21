"use client"

import { useEffect, useState } from "react"
import Link from "next/link"
import { Download } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import { artifactHref, artifactsFor, primaryArtifact, type ReleaseView } from "@/lib/desktop/artifacts"
import { DESKTOP_OSES, DESKTOP_OS_LABEL, DOWNLOAD_PATH, currentVisitorOs, formatInstallerSize, type DesktopOs, type VisitorOs } from "@/lib/desktop/release"
import { cn } from "@/lib/utils"

/** What each OS's installer needs. Said only beside a build that exists. */
export const SYSTEM_REQUIREMENTS: Record<DesktopOs, string> = {
  windows: "Windows 10 or 11, 64-bit",
  macos: "macOS 11 Big Sur or later",
  linux: "64-bit Linux with WebKitGTK 4.1 (Ubuntu 22.04+, Debian 12+, Fedora 38+)",
}

/** The visitor's OS, after hydration ("unknown" on the server and during the first render, so markup matches). */
export function useVisitorOs(): VisitorOs {
  const [visitor, setVisitor] = useState<VisitorOs>("unknown")
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitor(currentVisitorOs())
  }, [])
  return visitor
}

/** The platforms the latest release has an installer for, in the site's order. */
export function availablePlatforms(release: ReleaseView | null): DesktopOs[] {
  return DESKTOP_OSES.filter((os) => artifactsFor(release, os).length > 0)
}

/**
 * The site's one primary action: download Hubble.
 *
 * For a visitor whose OS has an installer in the latest release, the button
 * downloads it (through the measured /api/download link). Anyone else — an
 * unknown OS, a phone, an OS with no build yet — goes to /download, where
 * every platform is listed with its real status. The button never names a
 * platform that has no published installer.
 */
export function DownloadCta({ release, className, onStart }: { release: ReleaseView | null; className?: string; onStart?: () => void }) {
  const visitor = useVisitorOs()
  const os = visitor === "mobile" || visitor === "unknown" ? null : visitor
  const artifact = os ? primaryArtifact(release, os) : null

  if (os && artifact) {
    return (
      <a href={artifactHref(artifact, release)} onClick={onStart} className={cn(buttonVariants({ size: "hero" }), className)}>
        <Download aria-hidden />
        Download for {DESKTOP_OS_LABEL[os]}
      </a>
    )
  }
  return (
    <Link href={DOWNLOAD_PATH} className={cn(buttonVariants({ size: "hero" }), className)}>
      <Download aria-hidden />
      Download Hubble
    </Link>
  )
}

/** "Version 0.2.0 · Windows 10 or 11, 64-bit · 31 MB" for the visitor's platform, or the platforms that have a build. */
export function ReleaseLine({ release, className }: { release: ReleaseView | null; className?: string }) {
  const visitor = useVisitorOs()
  if (!release) return <p className={cn("m-small text-muted-foreground", className)}>Hubble Desktop isn&rsquo;t available to download yet.</p>
  const os = visitor === "mobile" || visitor === "unknown" ? null : visitor
  const artifact = os ? primaryArtifact(release, os) : null
  const parts = artifact
    ? [`Version ${release.version}`, SYSTEM_REQUIREMENTS[artifact.os], formatInstallerSize(artifact.bytes)]
    : [`Version ${release.version}`, `For ${availablePlatforms(release).map((platform) => DESKTOP_OS_LABEL[platform]).join(", ")}`]
  return <p className={cn("m-small text-muted-foreground", className)}>{parts.filter(Boolean).join(" · ")}</p>
}
