"use client"

import { useState, type FormEvent } from "react"
import { Layers, MoreHorizontal, PanelLeftOpen, Plus, Search } from "lucide-react"
import { toast } from "sonner"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { Button } from "@/components/ui/button"
import { Dialog, DialogContent, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { EmptyState } from "@/components/ui/empty-state"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { useTabSessions } from "@/hooks/use-tab-sessions"
import { createId } from "@/lib/id"
import { createTimestamp } from "@/lib/timestamps"
import { describeWriteError, lastActivityLabel } from "@/lib/sessions/messages"
import { deleteSession, duplicateSession, renameSession, sortByActivity } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import { MAX_SESSION_NAME_CHARS } from "@/lib/sessions/types"
import { SaveSessionDialog } from "./save-session-dialog"
import { SessionEditor } from "./session-editor"
import { SessionLauncher } from "./session-launcher"
import { LaunchConfirmDialog, useSessionLaunch } from "./use-session-launch"
import type { TabSession } from "@/lib/sessions/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/** Below this many sessions a search field is only clutter. */
const SEARCH_ABOVE = 8

type Dialogs =
  | { kind: "save" }
  | { kind: "replace"; session: TabSession }
  | { kind: "launch"; sessionIds: string[] }
  | { kind: "edit"; session: TabSession }
  | { kind: "rename"; session: TabSession }
  | { kind: "delete"; session: TabSession }
  | null

/**
 * Sessions: every saved set of Chrome tabs, most recently used first.
 *
 *     Sessions                         [Start session]  [+ Save current session]
 *
 *     History essay        12 tabs · Saved 2 hr ago · History HL     [Start] [⋯]
 *     Physics IA            8 tabs · Opened yesterday                [Start] [⋯]
 *
 * "Start" opens the launcher with that session chosen: inspect its tabs,
 * untick some, add another session, open them together in a new window.
 * ⋯ holds Edit tabs, Rename, Replace with open tabs, Duplicate and Delete.
 */
export function SessionsView({
  projects,
  now,
  openSaveOnMount,
  onOpenSidebar,
}: {
  /** The person's projects, for naming a session's project and choosing one when saving. */
  projects: readonly { id: string; name: string }[]
  now: number
  /** Open "Save current session" straight away (Home's first-session prompt). */
  openSaveOnMount?: boolean
  onOpenSidebar?: () => void
}) {
  const { sessions } = useTabSessions()
  const isDesktop = useIsDesktop()
  const [dialog, setDialog] = useState<Dialogs>(() => (openSaveOnMount ? { kind: "save" } : null))
  const [query, setQuery] = useState("")
  const launcher = useSessionLaunch()

  const projectName = new Map(projects.map((project) => [project.id, project.name]))
  const ordered = sortByActivity(sessions)
  const needle = query.trim().toLowerCase()
  const shown = needle
    ? ordered.filter((session) => session.name.toLowerCase().includes(needle) || (session.workspaceId && projectName.get(session.workspaceId)?.toLowerCase().includes(needle)))
    : ordered

  function duplicate(session: TabSession) {
    const result = writeSessions((state) => duplicateSession(state, session.id, { now: createTimestamp(), mintId: createId }))
    if (result.ok) toast.success(`Duplicated as “${result.value.name}”`)
    else toast.error(describeWriteError(result.error))
  }

  function remove(session: TabSession) {
    const result = writeSessions((state) => deleteSession(state, session.id))
    if (result.ok) toast.success(`Deleted “${session.name}”`)
    else toast.error(describeWriteError(result.error))
    setDialog(null)
  }

  async function confirmLaunch() {
    const outcome = await launcher.confirm()
    if (outcome?.kind === "opened" && outcome.opened > 0) setDialog(null)
  }

  return (
    <div className="min-h-screen" data-sessions>
      {onOpenSidebar && (
        <header className="flex h-12 items-center px-3 md:hidden">
          <IconButton aria-label="Open sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </IconButton>
        </header>
      )}
      <main className="mx-auto w-full max-w-3xl px-4 py-10 sm:px-8 sm:py-20">
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-3">
          <h1 className="text-statement text-foreground">Sessions</h1>
          {!isDesktop && (
            <div className="flex flex-wrap gap-2">
              {sessions.length > 1 && (
                <Button type="button" size="lg" variant="secondary" onClick={() => setDialog({ kind: "launch", sessionIds: [] })}>
                  Start session
                </Button>
              )}
              <Button type="button" size="lg" onClick={() => setDialog({ kind: "save" })}>
                <Plus /> Save current session
              </Button>
            </div>
          )}
        </div>
        <p className="mt-2 text-body text-muted-foreground">
          {isDesktop
            ? "Sessions save and reopen Chrome tabs, so they work in Hubble in Chrome."
            : "Save the tabs you have open, close them, and reopen them together later. Kept in this browser."}
        </p>

        {sessions.length > SEARCH_ABOVE && (
          <div className="relative mt-6">
            <Search aria-hidden className="pointer-events-none absolute top-1/2 left-2.5 size-3.5 -translate-y-1/2 text-tertiary" />
            <Input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Find a session" aria-label="Find a session" className="h-8 pl-8 text-body" />
          </div>
        )}

        {sessions.length === 0 ? (
          <EmptyState
            icon={Layers}
            title="No saved sessions"
            description={isDesktop ? "Save a session from Hubble in Chrome or from Hubble for Chrome." : "Save the tabs open in Chrome now to pick them up again later."}
            {...(isDesktop ? {} : { action: { label: "Save current session", onClick: () => setDialog({ kind: "save" }) } })}
          />
        ) : shown.length === 0 ? (
          <p className="mt-6 text-body text-muted-foreground">No session matches “{query.trim()}”.</p>
        ) : (
          <ul aria-label="Saved sessions" className="mt-6 flex flex-col gap-2">
            {shown.map((session) => {
              const project = session.workspaceId ? projectName.get(session.workspaceId) : undefined
              const meta = [plural(session.tabs.length, "tab", "tabs"), lastActivityLabel(session, now), project ?? ""].filter(Boolean)
              return (
                <li key={session.id} className="flex min-w-0 items-center gap-2 rounded-md border border-subtle bg-card px-3 py-3 sm:px-4">
                  <button
                    type="button"
                    disabled={isDesktop}
                    onClick={() => setDialog({ kind: "launch", sessionIds: [session.id] })}
                    className="min-w-0 flex-1 rounded-xs text-left outline-none focus-visible:ring-2 focus-visible:ring-ring/60 disabled:cursor-default"
                    aria-label={`See the tabs in ${session.name}`}
                  >
                    <span className="block truncate text-h2 text-foreground">{session.name}</span>
                    <span className="block truncate text-meta text-tertiary">{meta.join(" · ")}</span>
                  </button>
                  {!isDesktop && (
                    <Button type="button" size="default" onClick={() => setDialog({ kind: "launch", sessionIds: [session.id] })} aria-label={`Start ${session.name}`}>
                      Start
                    </Button>
                  )}
                  <DropdownMenu>
                    <DropdownMenuTrigger render={<Button type="button" size="icon-sm" variant="ghost" aria-label={`More actions for ${session.name}`} />}>
                      <MoreHorizontal />
                    </DropdownMenuTrigger>
                    <DropdownMenuContent align="end">
                      <DropdownMenuItem onClick={() => setDialog({ kind: "edit", session })}>Edit tabs</DropdownMenuItem>
                      <DropdownMenuItem onClick={() => setDialog({ kind: "rename", session })}>Rename</DropdownMenuItem>
                      {!isDesktop && <DropdownMenuItem onClick={() => setDialog({ kind: "replace", session })}>Replace with open tabs</DropdownMenuItem>}
                      <DropdownMenuItem onClick={() => duplicate(session)}>Duplicate</DropdownMenuItem>
                      <DropdownMenuSeparator />
                      <DropdownMenuItem variant="destructive" onClick={() => setDialog({ kind: "delete", session })}>
                        Delete
                      </DropdownMenuItem>
                    </DropdownMenuContent>
                  </DropdownMenu>
                </li>
              )
            })}
          </ul>
        )}
      </main>

      <SaveSessionDialog
        open={dialog?.kind === "save" || dialog?.kind === "replace"}
        onOpenChange={(open) => !open && setDialog(null)}
        projects={projects}
        {...(dialog?.kind === "replace" ? { replacing: dialog.session } : {})}
      />
      <SessionLauncher
        open={dialog?.kind === "launch"}
        onOpenChange={(open) => !open && setDialog(null)}
        sessions={ordered}
        initialSessionIds={dialog?.kind === "launch" ? dialog.sessionIds : []}
        pending={launcher.pending}
        onLaunch={launcher.launch}
      />
      <LaunchConfirmDialog request={launcher.confirming} onConfirm={() => void confirmLaunch()} onCancel={launcher.cancel} />
      <SessionEditor session={dialog?.kind === "edit" ? dialog.session : null} onClose={() => setDialog(null)} />
      <RenameSessionDialog session={dialog?.kind === "rename" ? dialog.session : null} onClose={() => setDialog(null)} />
      <AlertDialog open={dialog?.kind === "delete"} onOpenChange={(open) => !open && setDialog(null)}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete “{dialog?.kind === "delete" ? dialog.session.name : ""}”?</AlertDialogTitle>
            <AlertDialogDescription>
              Only the saved copy is removed. Tabs open in Chrome stay open. This can&apos;t be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction variant="destructive" onClick={() => dialog?.kind === "delete" && remove(dialog.session)}>
              Delete session
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  )
}

function RenameSessionDialog({ session, onClose }: { session: TabSession | null; onClose: () => void }) {
  return (
    <Dialog open={session !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="sm:max-w-md">{session && <RenameBody key={session.id} session={session} onClose={onClose} />}</DialogContent>
    </Dialog>
  )
}

function RenameBody({ session, onClose }: { session: TabSession; onClose: () => void }) {
  const [name, setName] = useState(session.name)
  const [error, setError] = useState<string | null>(null)

  function handleSubmit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim()) return
    // Only the name changes: the saved tabs and their times are untouched.
    const result = writeSessions((state) => renameSession(state, session.id, name))
    if (!result.ok) {
      setError(describeWriteError(result.error))
      return
    }
    onClose()
  }

  return (
    <form onSubmit={handleSubmit}>
      <DialogHeader>
        <DialogTitle>Rename session</DialogTitle>
      </DialogHeader>
      <Input
        autoFocus
        value={name}
        maxLength={MAX_SESSION_NAME_CHARS}
        onChange={(event) => setName(event.target.value)}
        onFocus={(event) => event.currentTarget.select()}
        className="mt-4 h-9 text-body"
        aria-label="Session name"
      />
      {error && (
        <p className="mt-2 text-body-sm text-destructive" role="alert">
          {error}
        </p>
      )}
      <DialogFooter>
        <Button type="button" variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
        <Button type="submit" size="lg" disabled={!name.trim() || name.trim() === session.name}>
          Rename
        </Button>
      </DialogFooter>
    </form>
  )
}
