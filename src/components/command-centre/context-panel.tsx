"use client"

import { Button } from "@/components/ui/button"
import { SessionPackFacts, WorkingContextDetails } from "./working-context-control"
import { WorkspaceBrief } from "./workspace-brief"
import { WORKSPACE_LINK_DETAIL, changeAccessLabel } from "@/lib/agents/command-centre/working-context"
import { describeStep } from "@/lib/agents/command-centre/workspace-activity"
import { cn } from "@/lib/utils"
import type { SessionPackProps, WorkingContextActions } from "./working-context-control"
import type { WorkspaceBriefView } from "@/lib/workspace/brief"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { WorkingContextView, WorkspaceLink } from "@/lib/agents/command-centre/working-context"
import type { RuntimeSessionView } from "@/lib/agents/runtime/protocol"

/**
 * What the agent can see, what it changed, and what this machine can do.
 *
 * ## The questions it answers, in order
 *
 * Which workspace is it working in, and on which project? What has it been
 * doing? What is it pointed at? What did it change? Each answer comes
 * from the runtime (the session's workspace, its focus, what it may do) or
 * from what the Command Centre itself applied — never from what was merely
 * selected — and every name is Hubble's live one.
 *
 * With no session open, it answers for the session you would start: the
 * workspace you came from, and anything you brought with you.
 */

function Section({ title, children, action }: { title: string; children: React.ReactNode; action?: React.ReactNode }) {
  return (
    /* `last:` drops the rule under the final section. */
    <section aria-label={title} className="border-b border-subtle px-4 py-3 last:border-b-0">
      <div className="flex min-h-6 items-center justify-between gap-2">
        <h3 className="text-eyebrow text-muted-foreground">{title}</h3>
        {action}
      </div>
      <div className="mt-1">{children}</div>
    </section>
  )
}

/** A label/value line. The panel's only repeated unit — no cards. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-body-sm text-muted-foreground">{label}</span>
      <span className="min-w-0 truncate text-body-sm text-foreground">{value}</span>
    </div>
  )
}

export function ContextPanel({
  session,
  workspaceName,
  link,
  context,
  delivered,
  agentName = "The agent",
  busy = false,
  changes = [],
  onViewChange,
  projectName,
  activity,
  brief,
  onSaveBrief,
  pack,
  packState,
  packChange,
  onSendUpdate,
  project,
  ...actions
}: {
  session: RuntimeSessionView | null
  /** The session's workspace — or, with no session, the one a new session would start in. */
  workspaceName?: string
  link: WorkspaceLink
  /** What the agent is pointed at, described from live Hubble state. `null`: it has no Hubble context. */
  context: WorkingContextView | null
  delivered?: boolean
  agentName?: string
  busy?: boolean
  /** What agents changed in this session's workspace, oldest first. */
  changes?: readonly AppliedWorkspaceChange[]
  onViewChange?: (change: AppliedWorkspaceChange) => void
  projectName?: string
  /** The session's activity timeline, rendered by the caller (components/agents/agent-activity-timeline.tsx). */
  activity?: React.ReactNode
  /** The workspace's brief (Hubble 1.5), from live state. Absent: no workspace to describe. */
  brief?: WorkspaceBriefView
  onSaveBrief?: (brief: { description: string; focus: string }) => void
  /** The workspace's project (Hubble 1.6), rendered by the caller (./workspace-project.tsx). Absent: the session's project name only. */
  project?: React.ReactNode
} & WorkingContextActions & SessionPackProps) {
  const change = changeAccessLabel(link)
  const recent = [...changes].reverse().slice(0, 5)

  return (
    <aside
      aria-label="Session context"
      /*
        Hidden below `xl`, not merely narrowed: the command centre is four
        columns wide once the app rail is counted, and below ~1280px this
        panel pushed the conversation too narrow to read. The header's toggle
        brings it back wherever it fits.
      */
      className="hidden h-full min-h-0 w-72 shrink-0 flex-col overflow-y-auto border-l border-subtle bg-sidebar xl:flex"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-border px-4">
        <h2 className="text-h2 text-foreground">Context</h2>
      </div>

      <Section title="Working in">
        {workspaceName && link.kind !== "none" && link.kind !== "workspace-missing" ? (
          <>
            {brief ? (
              <WorkspaceBrief view={brief} {...(onSaveBrief ? { onSave: onSaveBrief } : {})} />
            ) : (
              <p className="truncate text-body-sm text-foreground">{workspaceName}</p>
            )}
            <p className="mt-1 text-body-sm text-tertiary">
              {session ? WORKSPACE_LINK_DETAIL[link.kind] : "A new session starts here and stays here."}
            </p>
            {session && <p className="mt-1 text-body-sm text-muted-foreground">{change.text}</p>}
          </>
        ) : (
          <p className="text-body-sm text-tertiary">{WORKSPACE_LINK_DETAIL[link.kind]}</p>
        )}
      </Section>

      {/*
        The project is the anchor (Stage 3): what the agent works on, right
        under where — before what it has been doing.
      */}
      <Section title="Project">
        {project ? (
          project
        ) : projectName ? (
          <Row label="Authorized" value={projectName} />
        ) : (
          <p className="text-body-sm text-tertiary">No project. The agent can read Hubble context but cannot reach files.</p>
        )}
      </Section>

      {/*
        What the agent has been doing, second only to where: the question a
        person glancing at a working session asks first.
      */}
      {session && activity && <Section title="Activity">{activity}</Section>}

      {(context || pack) && (
        <Section title="Context">
          <div className="flex flex-col gap-2.5">
            {context && (
              <WorkingContextDetails
                view={context}
                link={link}
                agentName={agentName}
                {...(delivered !== undefined && !packState ? { delivered } : {})}
                busy={busy}
                eyebrow={false}
                {...actions}
              />
            )}
            <SessionPackFacts
              pack={pack ?? null}
              {...(packState ? { packState } : {})}
              {...(packChange ? { packChange } : {})}
              {...(onSendUpdate ? { onSendUpdate } : {})}
              agentName={agentName}
              busy={busy}
              withWorkspace={!brief}
              withSelection={!context}
            />
          </div>
        </Section>
      )}

      {session && recent.length > 0 && (
        <Section title="Changes">
          <ul className="flex flex-col gap-1">
            {recent.map((entry) => (
              <li key={entry.id} className="flex items-baseline justify-between gap-2">
                <span className={cn("min-w-0 text-body-sm", entry.undone ? "text-tertiary line-through" : "text-muted-foreground")}>
                  {entry.ok ? entry.steps.map(describeStep).join(" · ") || "Workspace updated" : "Not applied — nothing changed"}
                </span>
                {entry.ok && !entry.undone && onViewChange && (
                  <Button type="button" size="xs" variant="ghost" onClick={() => onViewChange(entry)}>
                    View
                  </Button>
                )}
              </li>
            ))}
          </ul>
        </Section>
      )}
    </aside>
  )
}
