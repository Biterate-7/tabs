"use client"

import { useEffect, useState, type FormEvent } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { readChromeTabs } from "@/lib/browser/read-tabs"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { EXTENSION_DOWNLOAD_URL, getExtensionInstallInfo } from "@/lib/extension-config"
import { createId } from "@/lib/id"
import { createTimestamp } from "@/lib/timestamps"
import { capturableWindows, suggestSessionName, tabsOfWindows } from "@/lib/sessions/capture"
import { describeWriteError } from "@/lib/sessions/messages"
import { createSession, replaceSessionTabs } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import { MAX_SESSION_NAME_CHARS, MAX_SESSION_TABS } from "@/lib/sessions/types"
import type { CapturableWindow } from "@/lib/sessions/capture"
import type { TabSession } from "@/lib/sessions/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

type ReadState =
  | { kind: "loading" }
  | { kind: "unavailable"; desktop: boolean }
  | { kind: "error"; message: string }
  | { kind: "ready"; windows: CapturableWindow[] }

/**
 * Reads the ordinary Chrome windows through Hubble for Chrome. Nothing is
 * read from a private window, and when the window list can't be read nothing
 * is read at all — there would be no telling private tabs apart.
 */
function useChromeWindows(attempt: number): ReadState {
  const [state, setState] = useState<ReadState>({ kind: "loading" })
  useEffect(() => {
    let alive = true
    // In Hubble Desktop this goes through the browser, where the person
    // approves sending their open tabs (readChromeTabs).
    void readChromeTabs().then((reading) => {
      if (!alive) return
      if (reading.ok && reading.windows) {
        setState({ kind: "ready", windows: capturableWindows(reading.tabs, reading.windows, reading.selfOrigin) })
      } else if (reading.ok) {
        setState({ kind: "error", message: "Couldn't check which Chrome windows are private, so nothing was read." })
      } else if (reading.reason === "unavailable") {
        setState({ kind: "unavailable", desktop: false })
      } else {
        setState({ kind: "error", message: reading.reason === "declined" ? "Nothing was sent from Chrome." : (reading.message ?? "Chrome didn't send your tabs.") })
      }
    })
    return () => {
      alive = false
    }
  }, [attempt])
  return state
}

/**
 * "Save current session": the tabs of the Chrome window you are in (or of
 * the windows you tick) as a named session. With `replacing`, the same read
 * replaces an existing session's tabs instead — "Update snapshot" — after
 * saying how many tabs go and come.
 */
export function SaveSessionDialog({
  open,
  onOpenChange,
  projects,
  replacing,
  onSaved,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  projects: readonly { id: string; name: string }[]
  /** Update this session's tabs instead of saving a new one. */
  replacing?: TabSession
  onSaved?: (session: TabSession) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        {/* Remounted per opening: every opening reads Chrome afresh. */}
        {open && <SaveSessionBody projects={projects} replacing={replacing} onDone={() => onOpenChange(false)} onSaved={onSaved} />}
      </DialogContent>
    </Dialog>
  )
}

function SaveSessionBody({
  projects,
  replacing,
  onDone,
  onSaved,
}: {
  projects: readonly { id: string; name: string }[]
  replacing?: TabSession
  onDone: () => void
  onSaved?: (session: TabSession) => void
}) {
  const [attempt, setAttempt] = useState(0)
  const read = useChromeWindows(attempt)
  const [now] = useState(() => createTimestamp())
  const [projectId, setProjectId] = useState("")
  const projectName = projects.find((project) => project.id === projectId)?.name
  const [name, setName] = useState<string | null>(null)
  const [chosen, setChosen] = useState<Set<number> | null>(null)
  const [error, setError] = useState<string | null>(null)
  // The revision the person is replacing — a save made meanwhile elsewhere is not overwritten.
  const [expectedRevision] = useState(() => replacing?.revision ?? 0)

  const windows = read.kind === "ready" ? read.windows : []
  // The window you are in, until you choose otherwise.
  const selected = chosen ?? new Set(windows.slice(0, 1).map((win) => win.windowId))
  const { tabs, skipped } = tabsOfWindows(windows, selected)
  const tooMany = tabs.length > MAX_SESSION_TABS
  const suggested = suggestSessionName({ ...(projectName ? { projectName } : {}), now })
  const finalName = name ?? suggested

  function toggle(windowId: number, on: boolean) {
    const next = new Set(selected)
    if (on) next.add(windowId)
    else next.delete(windowId)
    setChosen(next)
  }

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (tabs.length === 0 || tooMany) return
    const ctx = { now: createTimestamp(), mintId: createId }
    const result = replacing
      ? writeSessions((state) => replaceSessionTabs(state, replacing.id, tabs, { ...ctx, expectedRevision }))
      : writeSessions((state) => createSession(state, { name: finalName, tabs, ...(projectId ? { workspaceId: projectId } : {}) }, ctx))
    if (!result.ok) {
      setError(describeWriteError(result.error))
      return
    }
    toast.success(replacing ? `Updated “${result.value.name}”` : `Saved “${result.value.name}”`, {
      description: `${plural(result.value.tabs.length, "tab", "tabs")}${skipped > 0 ? ` · ${plural(skipped, "browser page", "browser pages")} not saved` : ""}`,
    })
    onSaved?.(result.value)
    onDone()
  }

  const install = getExtensionInstallInfo()
  const desktop = useIsDesktop()

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>{replacing ? "Replace with open tabs" : "Save current session"}</DialogTitle>
        <DialogDescription>
          {replacing
            ? `“${replacing.name}” will hold the tabs open now instead of its ${plural(replacing.tabs.length, "saved tab", "saved tabs")}.`
            : "Keeps the tabs open in Chrome to reopen together later. Nothing is closed."}
        </DialogDescription>
      </DialogHeader>

      <div className="mt-4 flex flex-col gap-3">
        {read.kind === "loading" &&
          (desktop ? (
            <p role="status" className="text-body-sm text-muted-foreground">
              Waiting for Chrome. A Hubble page opened in your browser: press Send there to share the tabs you have open.
            </p>
          ) : (
            <p className="text-body-sm text-muted-foreground">Reading your Chrome tabs…</p>
          ))}

        {read.kind === "unavailable" &&
          (read.desktop ? (
            <p className="text-body-sm text-muted-foreground">Sessions are saved from Chrome. Open Hubble in Chrome, or use Save session in Hubble for Chrome.</p>
          ) : (
            <p className="text-body-sm text-muted-foreground">
              This needs{" "}
              {install.mode === "store" ? (
                <a className="text-link hover:underline" href={install.url} target="_blank" rel="noreferrer">
                  Hubble for Chrome
                </a>
              ) : (
                <a className="text-link hover:underline" href={EXTENSION_DOWNLOAD_URL} download>
                  Hubble for Chrome
                </a>
              )}
              , which reads your open tabs. Nothing was read.
            </p>
          ))}

        {read.kind === "error" && <p className="text-body-sm text-destructive">{read.message}</p>}

        {read.kind === "ready" && windows.length === 0 && (
          <p className="text-body-sm text-muted-foreground">No web pages are open in Chrome — only new tabs and browser pages, which can&apos;t be saved.</p>
        )}

        {read.kind === "ready" && windows.length > 0 && (
          <>
            {!replacing && (
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                Name
                <Input
                  autoFocus
                  value={finalName}
                  maxLength={MAX_SESSION_NAME_CHARS}
                  onChange={(event) => setName(event.target.value)}
                  onFocus={(event) => event.currentTarget.select()}
                  className="h-9 text-body"
                  aria-label="Session name"
                />
              </label>
            )}
            {!replacing && projects.length > 0 && (
              <label className="flex flex-col gap-1 text-meta text-muted-foreground">
                Project (optional)
                <select
                  aria-label="Project"
                  className="h-8 rounded-xs border border-border bg-background px-2 text-body-sm text-foreground"
                  value={projectId}
                  onChange={(event) => setProjectId(event.target.value)}
                >
                  <option value="">None</option>
                  {projects.map((project) => (
                    <option key={project.id} value={project.id}>
                      {project.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {windows.length > 1 && (
              <fieldset className="flex flex-col gap-1.5">
                <legend className="mb-1 text-meta text-muted-foreground">Windows</legend>
                {windows.map((win, index) => (
                  <div key={win.windowId} className="flex min-w-0 items-center gap-2 text-body-sm text-foreground">
                    <Checkbox
                      checked={selected.has(win.windowId)}
                      onCheckedChange={(on) => toggle(win.windowId, on === true)}
                      aria-label={`${win.focused ? "This window" : `Window ${index + 1}`}, ${plural(win.tabs.length, "tab", "tabs")}`}
                    />
                    <span className="min-w-0 flex-1 truncate">
                      {win.focused ? "This window" : `Window ${index + 1}`}
                      {win.label ? <span className="text-tertiary"> · {win.label}</span> : null}
                    </span>
                    <span className="shrink-0 text-meta text-tertiary">{plural(win.tabs.length, "tab", "tabs")}</span>
                  </div>
                ))}
              </fieldset>
            )}
            <p className="text-body-sm text-muted-foreground" role="status">
              {tabs.length === 0
                ? "Nothing to save in the chosen windows."
                : tooMany
                  ? `${tabs.length} tabs is more than one session holds (${MAX_SESSION_TABS}). Choose fewer windows.`
                  : replacing
                    ? `${plural(replacing.tabs.length, "saved tab", "saved tabs")} → ${plural(tabs.length, "open tab", "open tabs")}.`
                    : `${plural(tabs.length, "tab", "tabs")} will be saved.`}
              {skipped > 0 && ` ${plural(skipped, "browser page", "browser pages")} (like chrome:// or a new tab) can't be saved.`}
            </p>
          </>
        )}

        {error && (
          <p className="text-body-sm text-destructive" role="alert">
            {error}
          </p>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" size="lg" onClick={onDone}>
          Cancel
        </Button>
        {(read.kind === "error" || read.kind === "unavailable") && (
          <Button type="button" variant="secondary" size="lg" onClick={() => setAttempt((n) => n + 1)}>
            Try again
          </Button>
        )}
        {read.kind === "ready" && windows.length > 0 && (
          <Button type="submit" size="lg" disabled={tabs.length === 0 || tooMany || !finalName.trim()}>
            {replacing ? "Replace tabs" : "Save session"}
          </Button>
        )}
      </DialogFooter>
    </form>
  )
}
