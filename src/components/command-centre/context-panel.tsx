"use client"

import { AlertTriangle, RefreshCw, Sparkles } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import {
  describeDelta,
  describeOmissionReason,
  summarizeSnapshot,
} from "@/lib/agents/command-centre/context-selection"
import { PROVIDER_CONNECTION_LABEL, PROVIDER_CONNECTION_TONE } from "@/lib/agents/command-centre/presentation"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { cn } from "@/lib/utils"
import type { ContextDelta } from "@/lib/agents/command-centre/context-selection"
import type { AgentContextSnapshot } from "@/lib/agents/context/types"
import type { RuntimeSessionView, RuntimeStatus } from "@/lib/agents/runtime/protocol"

/**
 * What the agent can actually see, and what this machine can actually do.
 *
 * ## The distinction this panel exists to make
 *
 * Scoped context is a core product principle, and the way it fails is not by
 * leaking — it is by the user *believing* the agent has less, or more, than it
 * does. So this panel reports the attached **snapshot**, never the selection:
 * every count comes from items the resolver actually admitted at capture time.
 * A workspace that was ticked and then dropped for a limit appears under
 * "Not included", with the resolver's own reason.
 *
 * When nothing is attached it says so plainly. It never implies the agent can
 * see the rest of TabDump.
 *
 * ## Why refresh is a button
 *
 * Phase E's snapshots are immutable by design, and refresh mints a second one
 * rather than mutating the first. That is what makes "+2 tabs · -1 collection"
 * a comparison instead of a guess — and it is why nothing here re-resolves on
 * its own. A context that silently grew would send the agent data the user
 * never attached.
 */

function Section({
  title,
  children,
  action,
}: {
  title: string
  children: React.ReactNode
  action?: React.ReactNode
}) {
  return (
    <section className="border-b border-subtle px-3 py-2.5">
      <div className="flex items-center justify-between gap-2">
        <h3 className="text-eyebrow text-tertiary">{title}</h3>
        {action}
      </div>
      <div className="mt-1.5">{children}</div>
    </section>
  )
}

/** A label/value line. The panel's only repeated unit — no cards. */
function Row({ label, value }: { label: string; value: string }) {
  return (
    <div className="flex items-baseline justify-between gap-3 py-0.5">
      <span className="shrink-0 text-label text-tertiary">{label}</span>
      <span className="min-w-0 truncate text-meta text-muted-foreground">{value}</span>
    </div>
  )
}

export function ContextPanel({
  session,
  snapshot,
  delta,
  projectName,
  runtimeStatus,
  onRefreshContext,
  onEditContext,
  refreshing,
}: {
  session: RuntimeSessionView | null
  /** The snapshot attached to this session, or `null` when none is. */
  snapshot: AgentContextSnapshot | null
  delta: readonly ContextDelta[]
  projectName?: string
  runtimeStatus: RuntimeStatus | null
  onRefreshContext: () => void
  onEditContext: () => void
  refreshing: boolean
}) {
  const summary = snapshot ? summarizeSnapshot(snapshot) : []
  const deltaText = describeDelta(delta)

  return (
    <aside
      aria-label="Session context"
      className="flex h-full min-h-0 w-72 shrink-0 flex-col overflow-y-auto border-l border-subtle"
    >
      <div className="flex h-12 shrink-0 items-center border-b border-subtle px-3">
        <h2 className="text-eyebrow text-tertiary">Context</h2>
      </div>

      <Section title="Project">
        {projectName ? (
          <Row label="Authorized" value={projectName} />
        ) : (
          <p className="text-body-sm text-tertiary">
            No project. The agent can read attached context but cannot reach files.
          </p>
        )}
      </Section>

      <Section
        title="Attached"
        action={
          <div className="flex items-center gap-1">
            <Button type="button" size="xs" variant="ghost" onClick={onEditContext}>
              Edit
            </Button>
            {snapshot && (
              <Button
                type="button"
                size="xs"
                variant="ghost"
                onClick={onRefreshContext}
                disabled={refreshing}
                aria-label="Refresh context"
              >
                <RefreshCw className={cn(refreshing && "animate-spin")} />
              </Button>
            )}
          </div>
        }
      >
        {!snapshot ? (
          <p className="text-body-sm text-tertiary">
            Nothing attached. The agent sees only what you send it.
          </p>
        ) : (
          <>
            {summary.map((row) => (
              <Row
                key={row.sourceType}
                label={row.label}
                value={row.detail ?? String(row.count)}
              />
            ))}
            <p className="mt-1.5 text-meta text-tertiary">
              Captured {new Date(snapshot.capturedAt).toLocaleTimeString()}
            </p>
            {deltaText && (
              <p className="mt-1 text-meta text-accent-text">Context updated · {deltaText}</p>
            )}
          </>
        )}
      </Section>

      {/*
        What the user asked for and did not get.

        The resolver already recorded every one of these with a reason; not
        showing them would leave the user believing the agent can see more than
        it can, which is the exact misunderstanding this panel exists to
        prevent.
      */}
      {snapshot && snapshot.omissions.length > 0 && (
        <Section title="Not included">
          {snapshot.omissions.map((omission) => (
            <div
              key={`${omission.sourceType}:${omission.reason}`}
              className="flex items-baseline gap-1.5 py-0.5"
            >
              <AlertTriangle aria-hidden className="size-3 shrink-0 translate-y-0.5 text-warning" />
              <span className="min-w-0 flex-1 text-label text-muted-foreground">
                {omission.count} {omission.sourceType.replace(/_/g, " ")} ·{" "}
                <span className="text-tertiary">{describeOmissionReason(omission.reason)}</span>
              </span>
            </div>
          ))}
        </Section>
      )}

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
        Providers, as the runtime reports them.

        Three independent facts per row — available, connected, capable — and
        no attempt to collapse them into one. A provider that is present but
        has declared no `create_session` says "Cannot start sessions yet"
        rather than being silently absent.
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
              <span
                className={cn(
                  "shrink-0 text-label",
                  AGENT_TONE_TEXT_CLASS[PROVIDER_CONNECTION_TONE[provider.connection]]
                )}
              >
                {PROVIDER_CONNECTION_LABEL[provider.connection]}
              </span>
            </div>
          ))
        )}
      </Section>

      {!snapshot && session && (
        <div className="px-3 py-3">
          <Button type="button" size="sm" variant="outline" className="w-full" onClick={onEditContext}>
            <Sparkles />
            Attach TabDump context
          </Button>
        </div>
      )}
    </aside>
  )
}
