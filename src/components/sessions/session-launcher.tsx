"use client"

import { useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { Input } from "@/components/ui/input"
import { Switch } from "@/components/ui/switch"
import { createId } from "@/lib/id"
import { createTimestamp } from "@/lib/timestamps"
import { buildLaunchPlan, countDuplicates, launchKey } from "@/lib/sessions/combine"
import { describeWriteError } from "@/lib/sessions/messages"
import { createSession } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import { MAX_SESSION_NAME_CHARS, MAX_SESSION_TABS } from "@/lib/sessions/types"
import { formatDate } from "@/lib/time-format"
import { SavedTabRow } from "./saved-tab-row"
import type { LaunchRequest } from "./use-session-launch"
import type { RestoreOutcome } from "@/lib/sessions/restore"
import type { TabSession } from "@/lib/sessions/types"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Start session: choose one or more saved sessions, untick the tabs you don't
 * want, and open the rest together in a new Chrome window — or keep the
 * combination as a session of its own.
 *
 * Works on the sessions as they were when it opened: what is on screen is
 * exactly what opens, and nothing here changes a saved session.
 */
export function SessionLauncher({
  open,
  onOpenChange,
  sessions,
  initialSessionIds,
  pending,
  onLaunch,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  sessions: readonly TabSession[]
  initialSessionIds: readonly string[]
  pending: boolean
  onLaunch: (request: LaunchRequest) => Promise<RestoreOutcome | undefined>
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="flex max-h-[calc(100dvh-2rem)] flex-col sm:max-w-lg">
        {open && (
          <LauncherBody
            sessions={sessions}
            initialSessionIds={initialSessionIds}
            pending={pending}
            onLaunch={onLaunch}
            onClose={() => onOpenChange(false)}
          />
        )}
      </DialogContent>
    </Dialog>
  )
}

function LauncherBody({
  sessions: live,
  initialSessionIds,
  pending,
  onLaunch,
  onClose,
}: {
  sessions: readonly TabSession[]
  initialSessionIds: readonly string[]
  pending: boolean
  onLaunch: (request: LaunchRequest) => Promise<RestoreOutcome | undefined>
  onClose: () => void
}) {
  // Frozen at opening: a session changed elsewhere meanwhile doesn't shift what you are choosing from.
  const [sessions] = useState(() => [...live])
  // In the order they were ticked: that order is the launch order.
  const [chosen, setChosen] = useState<string[]>(() => initialSessionIds.filter((id) => sessions.some((session) => session.id === id)))
  const [excluded, setExcluded] = useState<Set<string>>(() => new Set())
  const [dedupe, setDedupe] = useState(true)
  const [saving, setSaving] = useState(false)
  const [saveName, setSaveName] = useState("")
  const [saveError, setSaveError] = useState<string | null>(null)

  const plan = buildLaunchPlan(sessions, chosen, excluded, { dedupe })
  const duplicates = countDuplicates(sessions, chosen, excluded)
  const planned = new Set(plan.tabs.map((tab) => tab.key))
  const chosenSessions = chosen.flatMap((id) => sessions.find((session) => session.id === id) ?? [])
  const others = sessions.filter((session) => !chosen.includes(session.id))

  function toggleSession(id: string, on: boolean) {
    setChosen((current) => (on ? (current.includes(id) ? current : [...current, id]) : current.filter((entry) => entry !== id)))
  }

  function toggleTab(key: string, on: boolean) {
    setExcluded((current) => {
      const next = new Set(current)
      if (on) next.delete(key)
      else next.add(key)
      return next
    })
  }

  function toggleAll(session: TabSession, on: boolean) {
    setExcluded((current) => {
      const next = new Set(current)
      for (const tab of session.tabs) {
        const key = launchKey(session.id, tab.id)
        if (on) next.delete(key)
        else next.add(key)
      }
      return next
    })
  }

  async function handleLaunch() {
    const sessionIds = [...new Set(plan.tabs.map((tab) => tab.sessionId))]
    const outcome = await onLaunch({ tabs: plan.tabs.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })), sessionIds })
    if (outcome?.kind === "opened" && outcome.opened > 0) onClose()
  }

  function handleSave() {
    const name = saveName.trim() || `${chosenSessions.length === 1 ? chosenSessions[0].name : "Combined session"} — ${formatDate(createTimestamp(), createTimestamp())}`
    const result = writeSessions((state) =>
      createSession(state, { name, tabs: plan.tabs.map(({ url, title, favicon, pinned }) => ({ url, title, favicon, pinned })) }, { now: createTimestamp(), mintId: createId })
    )
    if (!result.ok) {
      setSaveError(describeWriteError(result.error))
      return
    }
    toast.success(`Saved “${result.value.name}”`, { description: plural(result.value.tabs.length, "tab", "tabs") })
    setSaving(false)
    setSaveName("")
    setSaveError(null)
  }

  return (
    <>
      <DialogHeader>
        <DialogTitle>Start session</DialogTitle>
        <DialogDescription>Choose sessions and tabs to open together. Your saved sessions don&apos;t change.</DialogDescription>
      </DialogHeader>

      <div className="-mx-1 mt-3 min-h-0 flex-1 overflow-y-auto px-1">
        {chosenSessions.map((session) => {
          const included = session.tabs.filter((tab) => !excluded.has(launchKey(session.id, tab.id))).length
          return (
            <section key={session.id} aria-label={session.name} className="mb-4">
              <div className="flex min-w-0 items-center gap-2 border-b border-subtle pb-1.5">
                <Checkbox checked onCheckedChange={() => toggleSession(session.id, false)} aria-label={`Leave out ${session.name}`} />
                <h3 className="min-w-0 flex-1 truncate text-h2 text-foreground">{session.name}</h3>
                <Button
                  type="button"
                  variant="ghost"
                  size="xs"
                  onClick={() => toggleAll(session, included < session.tabs.length)}
                  aria-label={included < session.tabs.length ? `Choose every tab in ${session.name}` : `Clear the tabs of ${session.name}`}
                >
                  {included}/{session.tabs.length}
                </Button>
              </div>
              <ul className="mt-1 flex flex-col">
                {session.tabs.map((tab) => {
                  const key = launchKey(session.id, tab.id)
                  return (
                    <li key={key}>
                      <SavedTabRow
                        tab={tab}
                        checked={!excluded.has(key)}
                        onCheckedChange={(on) => toggleTab(key, on)}
                        // Chosen but skipped: the same link is already earlier in the list.
                        // (Past the launch limit a tab is skipped for that reason instead, said below the list.)
                        {...(!excluded.has(key) && !planned.has(key) && dedupe && !plan.truncated ? { note: "Duplicate" } : {})}
                      />
                    </li>
                  )
                })}
              </ul>
            </section>
          )
        })}

        {others.length > 0 && (
          <section aria-label="Add another session">
            <h3 className="text-eyebrow text-tertiary">{chosenSessions.length === 0 ? "Choose sessions" : "Add another session"}</h3>
            <ul className="mt-1 flex flex-col">
              {others.map((session) => (
                <li key={session.id}>
                  <div className="flex min-w-0 items-center gap-2 rounded-xs px-1 py-1.5 hover:bg-surface-hover">
                    <Checkbox checked={false} onCheckedChange={(on) => toggleSession(session.id, on === true)} aria-label={`Add ${session.name}`} />
                    <div className="flex min-w-0 flex-1 cursor-pointer items-center gap-2" onClick={() => toggleSession(session.id, true)}>
                      <span className="min-w-0 flex-1 truncate text-body text-foreground">{session.name}</span>
                      <span className="shrink-0 text-meta text-tertiary">{plural(session.tabs.length, "tab", "tabs")}</span>
                    </div>
                  </div>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>

      <div className="mt-3 flex flex-col gap-2 border-t border-subtle pt-3">
        {(duplicates > 0 || !dedupe) && (
          <div className="flex items-center gap-2 text-body-sm text-muted-foreground">
            <Switch checked={dedupe} onCheckedChange={(on) => setDedupe(on === true)} aria-label="Skip duplicate links" />
            <span className="cursor-pointer" onClick={() => setDedupe(!dedupe)}>
              Skip duplicate links{duplicates > 0 ? ` (${duplicates})` : ""}
            </span>
          </div>
        )}
        <p className="text-meta text-tertiary" role="status">
          {plan.tabs.length === 0 ? "Nothing chosen yet." : `${plural(plan.tabs.length, "tab", "tabs")} · opens in a new Chrome window. Nothing is closed.`}
          {plan.truncated && ` Only the first ${MAX_SESSION_TABS} open at once.`}
        </p>
        {saving && (
          <div className="flex flex-col gap-1">
            <div className="flex gap-2">
              <Input
                autoFocus
                value={saveName}
                maxLength={MAX_SESSION_NAME_CHARS}
                onChange={(event) => setSaveName(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault()
                    handleSave()
                  }
                }}
                placeholder="Name for the new session"
                aria-label="Name for the new session"
                className="h-8 min-w-0 flex-1 text-body"
              />
              <Button type="button" variant="secondary" size="lg" onClick={handleSave}>
                Save
              </Button>
            </div>
            {saveError && (
              <p className="text-body-sm text-destructive" role="alert">
                {saveError}
              </p>
            )}
          </div>
        )}
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" size="lg" onClick={onClose}>
          Cancel
        </Button>
        {!saving && (
          <Button type="button" variant="secondary" size="lg" disabled={plan.tabs.length === 0} onClick={() => setSaving(true)}>
            Save as new session
          </Button>
        )}
        <Button type="button" size="lg" disabled={plan.tabs.length === 0 || pending} onClick={() => void handleLaunch()}>
          {pending ? "Opening…" : `Open ${plural(plan.tabs.length, "tab", "tabs")}`}
        </Button>
      </DialogFooter>
    </>
  )
}
