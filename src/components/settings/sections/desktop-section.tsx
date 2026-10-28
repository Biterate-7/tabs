"use client"

import { useCallback, useEffect, useState, type ReactNode } from "react"
import { ArrowUpRight, Download, Loader2, RefreshCw } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { Button, buttonVariants } from "@/components/ui/button"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { checkForDesktopUpdate, probeDownload, type DownloadProbe, type UpdateCheck } from "@/lib/desktop/install"
import {
  DESKTOP_BUILDS,
  DESKTOP_OS_LABEL,
  DESKTOP_REQUIREMENTS,
  RELEASES_PAGE_URL,
  currentVisitorOs,
  downloadHref,
  formatInstallerSize,
  parseDesktopOs,
  releasePageUrl,
  statusLabel,
  windowsInstallerName,
  type VisitorOs,
} from "@/lib/desktop/release"
import { installedDesktopApp, type DesktopAppInfo } from "@/lib/platform"
import { FieldRow, GroupLabel, SectionHeading, SectionStack } from "./section-ui"

/*
 * Settings → Desktop app.
 *
 * One pane, two runtimes, decided by `useIsDesktop` (the Tauri IPC marker,
 * src/lib/platform/detect.ts — never the user agent):
 *
 *   - Hubble Web offers the real installer: the published build in
 *     src/lib/desktop/release.ts, through the measured /api/download endpoint
 *     that redirects to the GitHub Release asset. The endpoint is probed
 *     first, so a missing release or an unreachable server is said here
 *     instead of being discovered on an error page.
 *   - Hubble Desktop reports what the running binary says about itself
 *     (`app_info`), and checks the deployed site for a newer published build.
 *     Updating is manual — there is no auto-updater — so the pane says so and
 *     links the new installer rather than claiming to install it.
 */

const EXTERNAL = { target: "_blank", rel: "noreferrer" } as const

export function DesktopSection() {
  return useIsDesktop() ? <InstalledDesktop /> : <GetDesktop />
}

// ------------------------------------------------------------ Hubble Web

/** Windows is the only OS with an installer format the release workflow produces (release.ts `downloadUrl`). */
const INSTALLER_OS = "windows" as const

function GetDesktop() {
  // Unknown until mounted: the server has no browser to ask.
  const [visitor, setVisitor] = useState<VisitorOs>("unknown")
  const [probe, setProbe] = useState<DownloadProbe | "checking">("checking")
  const [started, setStarted] = useState(false)

  const build = DESKTOP_BUILDS[INSTALLER_OS]
  const href = downloadHref(INSTALLER_OS)
  const published = build.status === "published" && href !== null

  const check = useCallback(() => {
    if (!href) return
    setProbe("checking")
    void probeDownload(href).then(setProbe)
  }, [href])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setVisitor(currentVisitorOs())
    check()
  }, [check])

  const version = build.status === "published" ? build.version : null
  const installer = version ? windowsInstallerName(version) : null
  const size = build.status === "published" ? formatInstallerSize(build.bytes) : null
  const otherOs = visitor === "macos" || visitor === "linux" ? visitor : null

  return (
    <div>
      <SectionHeading title="Desktop app" description="Hubble as an app on your computer, with its own projects kept there." />
      <SectionStack className="mb-3">
        <FieldRow label="This install" description="You're using Hubble Web, in your browser.">
          <Badge variant="default">Web</Badge>
        </FieldRow>

        {otherOs && (
          <FieldRow label={`Hubble for ${DESKTOP_OS_LABEL[otherOs]}`} description="There's no installer for this computer yet.">
            <span className="text-meta text-tertiary">{statusLabel(otherOs)}</span>
          </FieldRow>
        )}

        {visitor === "mobile" ? (
          <FieldRow label="Hubble Desktop" description="Hubble Desktop runs on a computer. Open Settings there to download it.">
            <span />
          </FieldRow>
        ) : published && version ? (
          <FieldRow
            label={`Hubble Desktop for ${DESKTOP_OS_LABEL[INSTALLER_OS]}`}
            description={[`Version ${version}`, DESKTOP_REQUIREMENTS[INSTALLER_OS], size].filter(Boolean).join(" · ")}
          >
            {probe === "unavailable" ? (
              <Button type="button" size="sm" disabled>
                <Download /> Download for {DESKTOP_OS_LABEL[INSTALLER_OS]}
              </Button>
            ) : (
              <a
                href={href!}
                onClick={() => setStarted(true)}
                className={buttonVariants({ size: "sm", variant: otherOs ? "outline" : "default" })}
              >
                <Download /> Download for {DESKTOP_OS_LABEL[INSTALLER_OS]}
              </a>
            )}
          </FieldRow>
        ) : (
          <FieldRow label="Hubble Desktop" description="No installer has been published yet.">
            <span className="text-meta text-tertiary">{statusLabel(INSTALLER_OS)}</span>
          </FieldRow>
        )}

        <FieldRow label="All releases" description="Every version, with its notes and checksum, on GitHub.">
          <a href={version ? releasePageUrl(version) : RELEASES_PAGE_URL} {...EXTERNAL} className={buttonVariants({ size: "sm", variant: "outline" })}>
            Releases <ArrowUpRight />
          </a>
        </FieldRow>
      </SectionStack>

      {published && visitor !== "mobile" && (
        <DownloadStatus probe={probe} started={started} installer={installer} onRetry={check} />
      )}

      {published && installer && visitor !== "mobile" && (
        <>
          <GroupLabel className="mt-6">After downloading</GroupLabel>
          <SectionStack>
            {[
              `Open ${installer} from your browser's downloads.`,
              "Follow the installer. It installs Hubble for your Windows account only, so it doesn't need administrator rights.",
              "Open Hubble from the Start menu. Settings → Desktop app there shows the version you installed.",
              "Hubble Desktop keeps its own projects. To bring this browser's along, export them in Settings → Data here, then use Import projects in the app's Settings → Projects.",
            ].map((step, i) => (
              <div key={i} className="flex gap-3 px-4 py-2.5 text-body text-muted-foreground">
                <span className="w-4 shrink-0 text-meta leading-5 text-tertiary tabular-nums">{i + 1}</span>
                <span>{step}</span>
              </div>
            ))}
          </SectionStack>
        </>
      )}
    </div>
  )
}

/** What happened with the download, under the button — the browser itself shows the transfer's progress. */
function DownloadStatus({
  probe,
  started,
  installer,
  onRetry,
}: {
  probe: DownloadProbe | "checking"
  started: boolean
  installer: string | null
  onRetry: () => void
}) {
  let body: ReactNode = null
  if (started && probe !== "unavailable") {
    body = (
      <span className="text-foreground">
        Downloading {installer ?? "the installer"}. Your browser shows its progress; when it finishes, follow the steps below.
      </span>
    )
  } else if (probe === "checking") {
    body = (
      <span className="inline-flex items-center gap-1.5">
        <Loader2 aria-hidden className="size-3.5 animate-spin" /> Checking the download…
      </span>
    )
  } else if (probe === "unavailable") {
    body = (
      <span>
        The installer isn&rsquo;t available from Hubble right now. Get it from the{" "}
        <a href={RELEASES_PAGE_URL} {...EXTERNAL} className="text-link underline-offset-4 hover:underline">
          releases page
        </a>{" "}
        instead.
      </span>
    )
  } else if (probe === "unreachable") {
    body = (
      <span className="inline-flex flex-wrap items-center gap-x-2 gap-y-1">
        Couldn&rsquo;t reach Hubble&rsquo;s download server. Check your connection, or use the releases page.
        <Button type="button" variant="ghost" size="xs" onClick={onRetry}>
          <RefreshCw /> Try again
        </Button>
      </span>
    )
  }
  return (
    <p role="status" aria-live="polite" className="min-h-5 px-1 text-body-sm text-muted-foreground">
      {body}
    </p>
  )
}

// -------------------------------------------------------- Hubble Desktop

type AppState = { kind: "loading" } | { kind: "ready"; info: DesktopAppInfo } | { kind: "failed"; message: string }

function InstalledDesktop() {
  const [app, setApp] = useState<AppState>({ kind: "loading" })
  const [update, setUpdate] = useState<UpdateCheck | "checking" | null>(null)

  const checkUpdates = useCallback((info: DesktopAppInfo) => {
    const os = parseDesktopOs(info.os)
    if (!os) {
      setUpdate({ kind: "failed", message: `Hubble doesn't publish builds for ${info.os}.` })
      return
    }
    setUpdate("checking")
    void checkForDesktopUpdate({ installed: info.version, os }).then(setUpdate)
  }, [])

  useEffect(() => {
    let live = true
    const pending = installedDesktopApp()
    if (!pending) return
    pending.then(
      (info) => {
        if (!live) return
        setApp({ kind: "ready", info })
        checkUpdates(info)
      },
      (error: unknown) => live && setApp({ kind: "failed", message: error instanceof Error ? error.message : String(error) })
    )
    return () => {
      live = false
    }
  }, [checkUpdates])

  const info = app.kind === "ready" ? app.info : null
  const os = info ? parseDesktopOs(info.os) : null

  return (
    <div>
      <SectionHeading title="Desktop app" />
      <SectionStack className="mb-6">
        <FieldRow label="This install" description="You're running Hubble Desktop.">
          <Badge variant="success">Desktop</Badge>
        </FieldRow>
        <FieldRow label="Version" description={info ? `${os ? DESKTOP_OS_LABEL[os] : info.os} · ${archLabel(info.arch)}` : undefined}>
          <span className="text-body text-foreground tabular-nums">
            {info ? info.version : app.kind === "loading" ? "…" : "Unknown"}
          </span>
        </FieldRow>
        <UpdateRow update={update} onCheck={info ? () => checkUpdates(info) : undefined} />
        <FieldRow label="Your data" description="Kept in the app's own profile on this computer, separate from any browser. Installing a newer version keeps it.">
          <span />
        </FieldRow>
      </SectionStack>

      <GroupLabel>Diagnostics</GroupLabel>
      <SectionStack>
        <FieldRow label="Runtime" description="Detected through the desktop app's native bridge.">
          <span className="text-meta text-tertiary">Tauri {info?.tauriVersion ?? ""}</span>
        </FieldRow>
        {info && (
          <FieldRow label="Build" description={info.debug ? "A development build, not one from Hubble's releases." : "A release build."}>
            <span className="text-meta text-tertiary">{info.debug ? "Development" : "Release"}</span>
          </FieldRow>
        )}
        {app.kind === "failed" && (
          <FieldRow label="Couldn't read this install" description={app.message}>
            <a href={RELEASES_PAGE_URL} {...EXTERNAL} className={buttonVariants({ size: "sm", variant: "outline" })}>
              Releases <ArrowUpRight />
            </a>
          </FieldRow>
        )}
      </SectionStack>
    </div>
  )
}

function UpdateRow({ update, onCheck }: { update: UpdateCheck | "checking" | null; onCheck?: () => void }) {
  const again = onCheck && (
    <Button type="button" variant="outline" size="sm" onClick={onCheck} disabled={update === "checking"}>
      {update === "checking" ? <Loader2 className="animate-spin" aria-hidden /> : <RefreshCw />} Check again
    </Button>
  )

  if (update === null || update === "checking") {
    return (
      <FieldRow label="Updates" description={update === "checking" ? "Checking for a newer version…" : undefined}>
        {again ?? <span />}
      </FieldRow>
    )
  }

  switch (update.kind) {
    case "available": {
      const size = formatInstallerSize(update.bytes)
      return (
        <FieldRow
          label={`Hubble ${update.latest} is available`}
          description={`Download the new installer and run it — it replaces ${update.installed} and keeps your projects.${size ? ` ${size}.` : ""}`}
        >
          <span className="flex items-center gap-2">
            <a href={update.releaseUrl} {...EXTERNAL} className={buttonVariants({ size: "sm", variant: "ghost" })}>
              What&rsquo;s new
            </a>
            <a href={update.downloadUrl} {...EXTERNAL} className={buttonVariants({ size: "sm" })}>
              <Download /> Download {update.latest}
            </a>
          </span>
        </FieldRow>
      )
    }
    case "current":
      return (
        <FieldRow label="Updates" description="You have the latest version. Updates are installed by downloading the new installer.">
          {again}
        </FieldRow>
      )
    case "ahead":
      return (
        <FieldRow label="Updates" description={`This build is newer than the latest release (${update.latest}).`}>
          {again}
        </FieldRow>
      )
    case "none":
      return (
        <FieldRow label="Updates" description="No installer is published for this computer's system yet.">
          {again}
        </FieldRow>
      )
    case "failed":
      return (
        <FieldRow label="Couldn't check for updates" description={update.message}>
          <span className="flex items-center gap-2">
            <a href={RELEASES_PAGE_URL} {...EXTERNAL} className={buttonVariants({ size: "sm", variant: "ghost" })}>
              Releases <ArrowUpRight />
            </a>
            {again}
          </span>
        </FieldRow>
      )
  }
}

function archLabel(arch: string): string {
  if (arch === "x86_64") return "64-bit"
  if (arch === "aarch64") return "ARM64"
  if (arch === "x86") return "32-bit"
  return arch
}
