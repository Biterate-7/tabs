"use client"

import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import { Button } from "@/components/ui/button"
import { WorkingContextDetails } from "./working-context-control"
import { providerRowState } from "@/lib/agents/command-centre/presentation"
import { WORKSPACE_LINK_DETAIL, changeAccessLabel } from "@/lib/agents/command-centre/working-context"
import { describeStep } from "@/lib/agents/command-centre/workspace-activity"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { cn } from "@/lib/utils"
import type { WorkingContextActions } from "./working-context-control"
import type { AppliedWorkspaceChange } from "@/lib/agents/command-centre/workspace-activity"
import type { WorkingContextView, WorkspaceLink } from "@/lib/agents/command-centre/working-context"
import type { RuntimeSessionView, RuntimeStatus } from "@/lib/agents/runtime/protocol"

/**
 * What the agent can see, what it changed, and what this machine can do.
 *
 * ## The questions it answers, in order
 *
 * Which workspace is it working in? What is it pointed at there? What did it
 * change? Then the project, the session and the agents. Each answer comes
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
  runtimeStatus,
  activity,
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
  runtimeStatus: RuntimeStatus | null
  /** The session's activity timeline, rendered by the caller (components/agents/agent-activity-timeline.tsx). */
  activity?: React.ReactNode
} & WorkingContextActions) {
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
            <p className="truncate text-body-sm text-foreground">{workspaceName}</p>
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
        What the agent has been doing, second only to where: the question a
        person glancing at a working session asks first.
      */}
      {session && activity && <Section title="Activity">{activity}</Section>}

      {context && (
        <Section title="Context">
          <WorkingContextDetails
            view={context}
            link={link}
            agentName={agentName}
            {...(delivered !== undefined ? { delivered } : {})}
            busy={busy}
            {...actions}
          />
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

      <Section title="Project">
        {projectName ? (
          <Row label="Authorized" value={projectName} />
        ) : (
          <p className="text-body-sm text-tertiary">No project. The agent can read Hubble context but cannot reach files.</p>
        )}
      </Section>

      <Section title="Session">
        {session ? (
          <>
            <Row label="Runs" value={String(session.runIds.length)} />
            <Row label="Events" value={String(session.latestSequence)} />
            <Row label="Resumable" value={session.resumable ? "Yes" : "No"} />
          </>
        ) : (
          <p className="text-body-sm text-tertiary">No session selected.</p>
        )}
      </Section>

      {/*
        Providers, as the runtime reports them: available, connected and
        capable are three facts, and none is collapsed into another.
      */}
      <Section title="Agents">
        {!runtimeStatus ? (
          <p className="text-body-sm text-tertiary">Runtime not reachable.</p>
        ) : runtimeStatus.providers.length === 0 ? (
          <p className="text-body-sm text-tertiary">No agent providers registered here.</p>
        ) : (
          runtimeStatus.providers.map((provider) => (
            <div key={provider.provider} className="flex items-baseline justify-between gap-3 py-0.5">
              <span className="min-w-0 truncate text-label text-muted-foreground">
                {agentVisualIdentity(provider.provider).displayName}
              </span>
              <span className={cn("shrink-0 text-label", AGENT_TONE_TEXT_CLASS[providerRowState(provider).tone])}>
                {providerRowState(provider).label}
              </span>
            </div>
          ))
        )}
      </Section>
    </aside>
  )
}
