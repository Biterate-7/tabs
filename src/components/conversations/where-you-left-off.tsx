"use client"

import { useEffect, useMemo } from "react"
import { Copy } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { logIntelligence } from "@/lib/conversations/intelligence/diagnostics"
import { reconstructContext, reconstructionText } from "@/lib/conversations/intelligence/reconstruct"
import { formatRelativeTime } from "@/lib/time-format"
import type { ConversationIndex, Evidence, Fact } from "@/lib/conversations/intelligence/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * "Where you left off": the projects, open work, decisions and topics Hubble
 * rebuilt from saved conversations and sources (lib/conversations/
 * intelligence/reconstruct.ts). Current work and earlier work are labelled
 * apart; every line opens the conversation it came from.
 */
export function WhereYouLeftOff({
  index,
  workspaces,
  now,
  workspaceName,
  onOpen,
}: {
  index: ConversationIndex
  workspaces: readonly Workspace[]
  now: number
  workspaceName: (id: string) => string
  onOpen: (recordId: string, evidence?: Evidence) => void
}) {
  const context = useMemo(() => reconstructContext(index, workspaces, now), [index, workspaces, now])
  useEffect(() => {
    logIntelligence({ level: "info", kind: "reconstruct", event: "built", data: { conversations: context.basis.analyzed, projects: context.basis.projects, open: context.tasks.length + context.questions.length } })
  }, [context])

  if (context.basis.analyzed === 0) return null
  const open = [...context.tasks.map((entry) => ({ ...entry, label: "Task" })), ...context.questions.map((entry) => ({ ...entry, label: "Question" }))].sort((a, b) => b.at - a.at).slice(0, 4)

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(reconstructionText(context, workspaceName))
      toast.success("Copied — paste it into your next AI chat.")
    } catch {
      toast.error("Couldn't copy here.")
    }
  }

  const factLine = (entry: { fact: Fact; current: boolean; at: number; stale?: boolean }, label?: string) => (
    <li key={entry.fact.id}>
      <button type="button" className="w-full rounded-md px-2 py-1.5 text-left hover:bg-surface-hover" onClick={() => onOpen(entry.fact.recordId, entry.fact.evidence[0])}>
        <span className="line-clamp-2 text-body-sm text-foreground">{entry.fact.text}</span>
        <span className="block text-meta text-tertiary">
          {label ? `${label} · ` : ""}
          {formatRelativeTime(entry.at, now)}
          {entry.stale ? " · needs a look" : entry.current ? "" : " · earlier"}
        </span>
      </button>
    </li>
  )

  return (
    <section aria-label="Where you left off">
      <div className="mb-2 flex items-baseline justify-between gap-3">
        <h2 className="text-eyebrow text-tertiary">Where you left off</h2>
        <Button type="button" variant="ghost" size="sm" onClick={() => void copy()}>
          <Copy /> Copy for an AI chat
        </Button>
      </div>
      <div className="grid grid-cols-1 gap-4 md:grid-cols-3">
        <div>
          <h3 className="mb-1 text-meta text-tertiary">Projects</h3>
          <ul className="flex flex-col">
            {context.projects.slice(0, 3).map((project) => (
              <li key={project.workspaceId} className="px-2 py-1.5">
                <span className="block truncate text-body-sm text-foreground">{project.name}</span>
                <span className="block text-meta text-tertiary">
                  {project.current ? `active ${formatRelativeTime(project.at, now)}` : `earlier · ${formatRelativeTime(project.at, now)}`}
                  {project.openTasks + project.openQuestions > 0 ? ` · ${project.openTasks + project.openQuestions} open` : ""}
                </span>
              </li>
            ))}
          </ul>
          {context.topics.length > 0 && (
            <p className="mt-2 px-2 text-meta text-tertiary">
              Recent topics: <span className="text-muted-foreground">{context.topics.slice(0, 6).map((topic) => topic.label).join(", ")}</span>
            </p>
          )}
        </div>
        <div>
          <h3 className="mb-1 text-meta text-tertiary">Still open</h3>
          {open.length === 0 ? <p className="px-2 text-body-sm text-muted-foreground">Nothing left open in your conversations.</p> : <ul className="flex flex-col">{open.map((entry) => factLine(entry, entry.label))}</ul>}
        </div>
        <div>
          <h3 className="mb-1 text-meta text-tertiary">Decided</h3>
          {context.decisions.length === 0 ? <p className="px-2 text-body-sm text-muted-foreground">No decisions found yet.</p> : <ul className="flex flex-col">{context.decisions.slice(0, 3).map((entry) => factLine(entry))}</ul>}
        </div>
      </div>
    </section>
  )
}
