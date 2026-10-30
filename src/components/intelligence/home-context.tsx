"use client"

import { useMemo, useState } from "react"
import { toast } from "sonner"
import { useContextSettingsView, useContextState } from "@/hooks/use-context-intelligence"
import { createId } from "@/lib/id"
import { dismissSuggestion } from "@/lib/intelligence/decisions"
import { writeContext } from "@/lib/intelligence/persistence"
import { dismissResume, makeCheckpoint, recommendResume, upsertCheckpoint } from "@/lib/intelligence/resume"
import { tabsNotYetOpen } from "@/lib/intelligence/restore"
import { recordProjectEvent } from "@/lib/projects/activity"
import { subjectName } from "@/lib/product/subjects"
import { createSession } from "@/lib/sessions/model"
import { writeSessions } from "@/lib/sessions/persistence"
import { createTimestamp } from "@/lib/timestamps"
import { ContextOnboardingDialog, ContextSetupCard } from "./context-onboarding"
import { ResumePrompt } from "./resume-prompt"
import { SuggestionList } from "./suggestion-card"
import { SuggestionReviewDialog } from "./suggestion-review-dialog"
import type { DismissReason } from "@/lib/intelligence/decisions"
import type { SuggestionEdits } from "@/lib/intelligence/proposal"
import type { Suggestion } from "@/lib/intelligence/types"
import type { ProjectPulse } from "@/lib/product/continuity"
import type { LaunchRequest } from "@/components/sessions/use-session-launch"
import type { RestoreOutcome } from "@/lib/sessions/restore"
import type { Workspace } from "@/lib/workspace/types"

/**
 * What the shell hands Home for context intelligence. Absent in Hubble
 * Desktop (it can't reach Hubble for Chrome) — Home then shows none of it.
 */
export type HomeContextProps = {
  connected: boolean
  /** Saves a confirmed suggestion through the project pipeline. Resolves once it is stored (or refused). */
  onAccept: (suggestion: Suggestion, edits: SuggestionEdits) => Promise<boolean>
  onOpenSettings: () => void
}

const DEFER_MS = 14 * 24 * 60 * 60 * 1000
const MAX_REOPEN = 30

/** The first-run invitation, the resume prompt and the suggestions, in that order of importance. */
export function useHomeContext({
  context,
  subjects,
  pulses,
  now,
  returningFrom,
  launcher,
  canOpenTabs,
  onOpenSubject,
}: {
  context: HomeContextProps | undefined
  subjects: readonly Workspace[]
  pulses: readonly ProjectPulse[]
  now: number
  returningFrom: number | undefined
  launcher: { launch: (request: LaunchRequest) => Promise<RestoreOutcome | undefined>; pending: boolean }
  canOpenTabs: boolean
  onOpenSubject: (id: string) => void
}) {
  const state = useContextState()
  const settings = useContextSettingsView()
  const [onboarding, setOnboarding] = useState(false)
  const [reviewing, setReviewing] = useState<Suggestion | null>(null)
  const [pendingId, setPendingId] = useState<string>()
  const [resuming, setResuming] = useState(false)
  const [showAll, setShowAll] = useState(false)

  const ready = settings.status === "ready" ? settings.value : undefined
  const deferred = state.onboardingDeferredAt !== undefined && now - state.onboardingDeferredAt < DEFER_MS
  const askSetup = Boolean(context?.connected && ready && !ready.settings.decidedAt && !deferred)

  const recommendation = useMemo(() => (context ? recommendResume({ pulses, state, now, ...(returningFrom !== undefined ? { returningFrom } : {}) }) : undefined), [context, pulses, state, now, returningFrom])
  const resumePulse = recommendation ? pulses.find((pulse) => pulse.workspace.id === recommendation.workspaceId) : undefined

  // What Resume can reopen: the project's saved session, else the pages last used for it that Hubble knows.
  const reopen = useMemo(() => {
    if (!resumePulse || !canOpenTabs) return undefined
    if (resumePulse.session) {
      return { tabs: resumePulse.session.tabs.map((tab) => ({ url: tab.url, ...(tab.pinned ? { pinned: true } : {}) })), sessionId: resumePulse.session.id, label: `the ${resumePulse.session.tabs.length === 1 ? "tab" : `${resumePulse.session.tabs.length} tabs`} from “${resumePulse.session.name}”` }
    }
    const keys = new Set(state.associations.filter((association) => association.workspaceId === resumePulse.workspace.id).map((association) => association.key))
    const pages = state.records.filter((record) => keys.has(record.key) && !record.open).sort((a, b) => b.lastSeenAt - a.lastSeenAt).slice(0, MAX_REOPEN)
    if (pages.length === 0) return undefined
    return { tabs: pages.map((record) => ({ url: record.url })), titles: pages.map((record) => record.title), label: `the ${pages.length === 1 ? "page" : `${pages.length} pages`} you used for it` }
  }, [resumePulse, canOpenTabs, state.associations, state.records])

  const projects = useMemo(() => subjects.map((workspace) => ({ id: workspace.id, name: subjectName(workspace) })), [subjects])
  const openCount = state.suggestions.filter((suggestion) => suggestion.status === "open").length

  async function accept(suggestion: Suggestion, edits: SuggestionEdits) {
    if (!context || pendingId) return
    setPendingId(suggestion.id)
    try {
      const done = await context.onAccept(suggestion, edits)
      if (done) setReviewing(null)
    } finally {
      setPendingId(undefined)
    }
  }

  function dismiss(suggestion: Suggestion, reason: DismissReason) {
    const written = writeContext((current) => dismissSuggestion(current, suggestion.id, reason, Date.now()))
    if (!written.ok) {
      toast.error("Couldn't save that", { description: "Your browser's storage refused it. Try again." })
      return
    }
    if (reason === "not-relevant") toast("Won't suggest these again", { description: "Remove them from Hubble's activity in Settings → Context." })
    else if (reason === "wrong-project") toast("Got it", { description: "Hubble won't suggest these for that project again." })
  }

  async function resume({ reopenTabs }: { reopenTabs: boolean }) {
    if (!recommendation || !resumePulse || resuming) return
    setResuming(true)
    const workspaceId = recommendation.workspaceId
    try {
      let reopened = 0
      if (reopenTabs && reopen) {
        const { tabs, alreadyOpen } = await tabsNotYetOpen(reopen.tabs)
        if (tabs.length === 0) {
          toast("Its tabs are already open", { description: alreadyOpen > 0 ? `All ${alreadyOpen} are open in Chrome.` : undefined })
        } else {
          let sessionIds = reopen.sessionId ? [reopen.sessionId] : []
          // No saved session yet: what is reopened becomes this project's session, through the Sessions store.
          if (!reopen.sessionId) {
            const created = writeSessions((current) =>
              createSession(current, { name: `${subjectName(resumePulse.workspace)} — resumed`, tabs: tabs.map((tab, index) => ({ url: tab.url, title: reopen.titles?.[index] ?? "" })), workspaceId }, { now: createTimestamp(), mintId: createId })
            )
            if (created.ok) sessionIds = [created.value.id]
          }
          const outcome = await launcher.launch({ tabs, sessionIds })
          if (outcome?.kind === "opened") reopened = outcome.opened
        }
      }
      const checkpointed = writeContext((current) => upsertCheckpoint(current, makeCheckpoint(resumePulse, Date.now())))
      if (!checkpointed.ok) toast.warning("Couldn't record where you left off", { description: "Resume may offer this project again." })
      recordProjectEvent({ workspaceId, kind: "project_resumed", ...(reopened > 0 ? { count: reopened } : {}) })
      onOpenSubject(workspaceId)
    } finally {
      setResuming(false)
    }
  }

  const records = state.records
  const top = (
    <>
      {askSetup && (
        <ContextSetupCard
          onSetUp={() => setOnboarding(true)}
          onLater={() => {
            writeContext((current) => ({ ...current, onboardingDeferredAt: Date.now() }))
          }}
        />
      )}
      {recommendation && resumePulse && (
        <ResumePrompt
          recommendation={recommendation}
          workspace={resumePulse.workspace}
          now={now}
          {...(reopen ? { reopen: { count: reopen.tabs.length, label: reopen.label } } : {})}
          pending={resuming || launcher.pending}
          onResume={(options) => void resume(options)}
          onDismiss={() => writeContext((current) => dismissResume(current, recommendation.workspaceId, Date.now()))}
        />
      )}
    </>
  )

  const suggestions =
    context && openCount > 0 ? (
      <section aria-labelledby="home-suggested" className="mt-8">
        <div className="flex items-center justify-between gap-2 border-b border-subtle pb-2">
          <h2 id="home-suggested" className="text-eyebrow text-tertiary">
            Suggested
          </h2>
          {openCount > 2 && (
            <button type="button" onClick={() => setShowAll((value) => !value)} className="text-meta text-tertiary outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60">
              {showAll ? "Show fewer" : `All ${openCount}`}
            </button>
          )}
        </div>
        <SuggestionList
          className="mt-3"
          suggestions={state.suggestions}
          records={records}
          workspaces={subjects}
          limit={showAll ? 8 : 2}
          {...(pendingId ? { pendingId } : {})}
          actions={{ accept: (suggestion, edits) => void accept(suggestion, edits), review: setReviewing, dismiss }}
        />
      </section>
    ) : null

  const dialogs = context ? (
    <>
      <ContextOnboardingDialog open={onboarding} onOpenChange={setOnboarding} />
      <SuggestionReviewDialog
        suggestion={reviewing}
        records={records}
        projects={projects}
        onOpenChange={(open) => !open && setReviewing(null)}
        onConfirm={(suggestion, edits) => void accept(suggestion, edits)}
      />
    </>
  ) : null

  return { top, suggestions, dialogs }
}
