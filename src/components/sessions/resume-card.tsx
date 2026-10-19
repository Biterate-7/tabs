"use client"

import { ArrowRight, Play } from "lucide-react"
import { Button } from "@/components/ui/button"
import { useTabSessions } from "@/hooks/use-tab-sessions"
import { mostRecentSession } from "@/lib/sessions/model"
import { lastActivityLabel } from "@/lib/sessions/messages"
import { LaunchConfirmDialog, useSessionLaunch } from "./use-session-launch"

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

/**
 * Home's "Pick up where you left off": the session most recently saved,
 * edited or opened (lib/sessions/model.ts mostRecentSession — one rule), and
 * one button that reopens it in a new Chrome window.
 *
 * Renders nothing without a session: Home shows FirstSessionPrompt instead,
 * never an empty panel.
 */
export function ResumeSessionCard({
  now,
  onOpenSessions,
}: {
  now: number
  /** The Sessions page; `save` opens "Save current session" there. */
  onOpenSessions: (options?: { save?: boolean }) => void
}) {
  const { sessions } = useTabSessions()
  const launcher = useSessionLaunch()
  const latest = mostRecentSession(sessions)

  if (!latest) return null

  const when = lastActivityLabel(latest, now)

  return (
    <section aria-labelledby="home-resume" className="mb-8">
      <h2 id="home-resume" className="text-eyebrow text-tertiary">
        Pick up where you left off
      </h2>
      <div className="mt-2 flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2 rounded-md border border-subtle bg-card px-4 py-3">
        <div className="min-w-0 flex-1 basis-48">
          <p className="truncate text-h2 text-foreground">{latest.name}</p>
          <p className="truncate text-meta text-tertiary">{[plural(latest.tabs.length, "tab", "tabs"), when].filter(Boolean).join(" · ")}</p>
        </div>
        <div className="flex shrink-0 gap-2">
          <Button type="button" variant="ghost" size="lg" onClick={() => onOpenSessions()}>
            All sessions <ArrowRight />
          </Button>
          <Button
            type="button"
            size="lg"
            disabled={launcher.pending}
            onClick={() => void launcher.launch({ tabs: latest.tabs.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })), sessionIds: [latest.id] })}
            aria-label={`Resume ${latest.name}`}
            title="Opens its tabs in a new Chrome window"
          >
            <Play /> {launcher.pending ? "Opening…" : "Resume"}
          </Button>
        </div>
      </div>
      <LaunchConfirmDialog request={launcher.confirming} onConfirm={() => void launcher.confirm()} onCancel={launcher.cancel} />
    </section>
  )
}

/** With no saved session yet: one quiet line at the foot of Home offering to save the first. */
export function FirstSessionPrompt({ onOpenSessions }: { onOpenSessions: (options?: { save?: boolean }) => void }) {
  const { sessions } = useTabSessions()
  if (sessions.length > 0) return null
  return (
    <p className="mt-10 text-meta text-tertiary">
      Leaving for the day?{" "}
      <Button type="button" variant="link" size="xs" className="text-meta" onClick={() => onOpenSessions({ save: true })}>
        Save your open tabs as a session
      </Button>{" "}
      to pick them up later.
    </p>
  )
}
