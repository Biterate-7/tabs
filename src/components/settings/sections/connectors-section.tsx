"use client"

import { useCallback, useEffect, useState } from "react"
import { Bot, Check, ChevronLeft, Minus, Plug } from "lucide-react"
import { Button } from "@/components/ui/button"
import { AgentIcon } from "@/components/agents/agent-icon"
import { AGENT_TONE_TEXT_CLASS } from "@/components/agents/agent-tone"
import { useAgentConnectors } from "@/hooks/use-agent-connectors"
import { loadAgentState } from "@/lib/agents/persistence"
import {
  CAPABILITY_KEYS,
  CAPABILITY_LABELS,
  CONNECTOR_STATUS_LABELS,
} from "@/lib/agents/connectors/types"
import {
  CONNECTOR_STATUS_VISUALS,
  visualStateForConnector,
} from "@/lib/agents/visual/states"
import { EMPTY_PROVIDER_USAGE, summarizeProviderUsage } from "@/lib/agents/connectors/usage"
import { cn } from "@/lib/utils"
import { SectionHeading, SectionStack } from "./section-ui"
import type { ConnectorManager, ConnectorView } from "@/lib/agents/connectors/manager"
import type { AgentProviderId, ConnectorStatusKind } from "@/lib/agents/connectors/types"
import type { ProviderUsage } from "@/lib/agents/connectors/usage"
import type { AgentState } from "@/lib/agents/types"

/**
 * Settings → AI Connectors.
 *
 * The command centre's front door: every provider TabDump can talk about,
 * what state each is in, what it is able to observe, and what it has actually
 * seen. Built from the settings surface's own primitives (SectionHeading,
 * SectionStack, Button) rather than a new design system, so it reads as part
 * of TabDump rather than as a developer console.
 *
 * Two rules shape everything below:
 *
 *   1. **Nothing is rendered that was not observed.** Every count comes from
 *      persisted agent state; every status comes from a live connector. There
 *      is no placeholder row, no demo agent and no animated "working" dot for
 *      a provider that has reported nothing.
 *   2. **The three not-working states are never collapsed.** Disconnected,
 *      needs-configuration and unavailable each say something different about
 *      what the user can do next, and showing them identically would send
 *      someone looking for a setting that does not exist.
 */

/**
 * Status presentation: a glyph and a tone, with the word taken from the
 * connector layer's shared table.
 *
 * A glyph *and* a word for every state, mirroring the agent panel's
 * convention: status must never be carried by colour alone, and a screen
 * reader must be able to read the state out rather than announce a dot. The
 * words are not redefined here, so this page and the workspace sidebar cannot
 * drift into describing the same connector differently.
 */
function statusVisual(kind: ConnectorStatusKind): { glyph: string; tone: string } {
  const visual = CONNECTOR_STATUS_VISUALS[kind]
  return { glyph: visual.glyph, tone: AGENT_TONE_TEXT_CLASS[visual.tone] }
}

function statusLabel(kind: ConnectorStatusKind): string {
  return CONNECTOR_STATUS_LABELS[kind]
}

/**
 * A snapshot of the agent domain, plus the clock it was taken at.
 *
 * Deliberately NOT `useAgentStore`. That hook writes state back on a debounce,
 * and settings opens over a workspace whose own store may be ingesting at that
 * moment — a second writer would periodically flatten runs observed while this
 * panel was open. Reading the persisted snapshot gives the same numbers and
 * cannot clobber anything.
 *
 * Refreshed by *subscribing* to the manager rather than by an effect that
 * re-reads on every render: a connector status change is the only moment these
 * numbers can move while the panel is open, and taking the clock at the same
 * instant is what keeps every relative time on the page consistent with every
 * other (and keeps the render pure).
 */
type AgentSnapshot = { state: AgentState | null; now: number }

function readSnapshot(): AgentSnapshot {
  if (typeof window === "undefined") return { state: null, now: 0 }
  return { state: loadAgentState().state, now: Date.now() }
}

function useAgentSnapshot(manager: ConnectorManager): AgentSnapshot {
  const [snapshot, setSnapshot] = useState<AgentSnapshot>(readSnapshot)

  useEffect(() => manager.watchStatus(() => setSnapshot(readSnapshot())), [manager])

  return snapshot
}

function relativeTime(timestamp: number | undefined, now: number): string | null {
  if (!timestamp) return null
  const seconds = Math.max(0, Math.round((now - timestamp) / 1000))
  if (seconds < 5) return "just now"
  if (seconds < 60) return `${seconds} sec ago`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} min ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return `${hours} hr ago`
  return `${Math.round(hours / 24)} days ago`
}

/** One line of real numbers, or nothing. Never "0 runs · 0 artifacts" for a provider that has done nothing. */
function usageLine(usage: ProviderUsage): string | null {
  const parts: string[] = []
  if (usage.activeRuns > 0) parts.push(`${usage.activeRuns} active ${usage.activeRuns === 1 ? "run" : "runs"}`)
  if (usage.artifacts > 0) parts.push(`${usage.artifacts} ${usage.artifacts === 1 ? "file" : "files"}`)
  if (parts.length === 0 && usage.totalRuns > 0) {
    parts.push(`${usage.totalRuns} ${usage.totalRuns === 1 ? "run" : "runs"} recorded`)
  }
  return parts.length > 0 ? parts.join(" · ") : null
}

function StatusDot({ kind }: { kind: ConnectorStatusKind }) {
  const visual = statusVisual(kind)
  return (
    <span className={cn("text-body-sm leading-none", visual.tone)} aria-hidden>
      {visual.glyph}
    </span>
  )
}

function ConnectorRow({
  view,
  usage,
  onOpen,
}: {
  view: ConnectorView
  usage: ProviderUsage
  onOpen: (provider: AgentProviderId) => void
}) {
  const visual = statusVisual(view.status.kind)
  const line = usageLine(usage)

  return (
    <button
      type="button"
      onClick={() => onOpen(view.descriptor.provider)}
      // The accessible name carries the state in words, so the row never
      // depends on the glyph or its colour being perceived.
      aria-label={`${view.descriptor.displayName} — ${statusLabel(view.status.kind)}`}
      className="flex w-full items-start gap-3 rounded-lg border border-subtle p-3 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) hover:border-border hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
    >
      {/* The provider's own mark, in the state its connector is actually in.
          It identifies who this row is about; the glyph beside the status word
          below says what state it is in. Two marks rather than one because
          they answer different questions, and the status must never be
          carried by the identity's colour. */}
      <span className="mt-0.5">
        <AgentIcon
          connector={view.descriptor.provider}
          state={visualStateForConnector(view.status.kind)}
          size="md"
        />
      </span>

      <span className="min-w-0 flex-1">
        <span className="block text-body-sm font-medium text-foreground">
          {view.descriptor.displayName}
        </span>
        <span className={cn("mt-0.5 block text-meta", visual.tone)}>
          <StatusDot kind={view.status.kind} /> {statusLabel(view.status.kind)}
        </span>
        {line && <span className="mt-0.5 block text-meta text-tertiary">{line}</span>}
      </span>

      <span className="shrink-0 self-center text-meta text-tertiary">
        {view.status.kind === "connected" ? "Manage" : "Connect"}
      </span>
    </button>
  )
}

/**
 * The pre-connection explanation.
 *
 * Shown before anything is connected, and it is not boilerplate: the two
 * lists below are the literal security boundary of the whole feature, and a
 * user agreeing to be observed deserves to see it in the product rather than
 * only in the architecture docs. Every line is true of the implementation —
 * the connector contract has no member that could execute, prompt or control
 * anything.
 */
function ConnectPrompt({
  view,
  busy,
  onConnect,
}: {
  view: ConnectorView
  busy: boolean
  onConnect: () => void
}) {
  return (
    <div className="rounded-lg border border-subtle p-4">
      <p className="text-body-sm text-foreground">
        TabDump can observe {view.descriptor.displayName} activity and show it in your workspace.
      </p>

      <div className="mt-3 grid gap-3 sm:grid-cols-2">
        <div>
          <p className="text-meta font-medium text-foreground">TabDump will not</p>
          <ul className="mt-1 space-y-0.5">
            {["Run commands", "Send prompts", "Modify your files", "Control the agent"].map((item) => (
              <li key={item} className="flex items-center gap-1.5 text-meta text-tertiary">
                <Minus className="size-3 shrink-0" aria-hidden />
                {item}
              </li>
            ))}
          </ul>
        </div>

        <div>
          <p className="text-meta font-medium text-foreground">TabDump can</p>
          <ul className="mt-1 space-y-0.5">
            {["Observe runs", "Observe activity", "Show files worked on", "Link work to workspaces"].map(
              (item) => (
                <li key={item} className="flex items-center gap-1.5 text-meta text-muted-foreground">
                  <Check className="size-3 shrink-0" aria-hidden />
                  {item}
                </li>
              )
            )}
          </ul>
        </div>
      </div>

      <div className="mt-4">
        <Button type="button" size="sm" onClick={onConnect} disabled={busy}>
          {busy ? "Connecting…" : "Connect"}
        </Button>
      </div>
    </div>
  )
}

function CapabilityList({ view }: { view: ConnectorView }) {
  const supported = CAPABILITY_KEYS.filter((key) => view.descriptor.capabilities[key])

  if (supported.length === 0) {
    return (
      <p className="text-meta text-tertiary">
        Nothing yet. TabDump lists a capability only once it can actually observe it.
      </p>
    )
  }

  return (
    <ul className="grid grid-cols-2 gap-x-4 gap-y-0.5">
      {CAPABILITY_KEYS.map((key) => {
        const on = view.descriptor.capabilities[key]
        return (
          <li
            key={key}
            className={cn(
              "flex items-center gap-1.5 text-meta",
              on ? "text-muted-foreground" : "text-tertiary"
            )}
          >
            {on ? (
              <Check className="size-3 shrink-0" aria-hidden />
            ) : (
              <Minus className="size-3 shrink-0" aria-hidden />
            )}
            <span>{CAPABILITY_LABELS[key]}</span>
            <span className="sr-only">{on ? "supported" : "not supported"}</span>
          </li>
        )
      })}
    </ul>
  )
}

function ConnectorDetail({
  view,
  usage,
  now,
  busy,
  onBack,
  onConnect,
  onDisconnect,
}: {
  view: ConnectorView
  usage: ProviderUsage
  now: number
  busy: boolean
  onBack: () => void
  onConnect: () => void
  onDisconnect: () => void
}) {
  const visual = statusVisual(view.status.kind)
  const lastObservation = relativeTime(view.status.lastObservationAt, now)
  const connected = view.status.kind === "connected"
  const live = connected || view.status.kind === "reconnecting" || view.status.kind === "connecting"

  return (
    <div>
      <button
        type="button"
        onClick={onBack}
        className="mb-4 flex items-center gap-1 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
      >
        <ChevronLeft className="size-3.5" aria-hidden />
        All connectors
      </button>

      <div className="mb-4 flex items-start gap-3">
        <AgentIcon
          connector={view.descriptor.provider}
          state={visualStateForConnector(view.status.kind)}
          size="lg"
        />
        <SectionHeading
          title={view.descriptor.displayName}
          description={view.descriptor.summary}
        />
      </div>

      <SectionStack>
        <div className="rounded-lg border border-subtle p-3">
          <div className="flex items-center gap-2">
            <StatusDot kind={view.status.kind} />
            <p className={cn("text-body-sm font-medium", visual.tone)}>{statusLabel(view.status.kind)}</p>
          </div>

          {view.status.detail && (
            <p className="mt-1.5 text-meta text-tertiary">{view.status.detail}</p>
          )}

          {/* The error is shown only when it is the current state. A stale
              failure kept for health purposes is not something to alarm
              someone with once the connector has recovered. */}
          {view.status.kind === "error" && view.status.lastError && (
            <p className="mt-1.5 text-meta text-destructive">{view.status.lastError.message}</p>
          )}

          {live && (
            <p className="mt-1.5 text-meta text-tertiary">
              Connection: {view.health.label}
            </p>
          )}
        </div>

        <div className="rounded-lg border border-subtle p-3">
          <p className="mb-2 text-body-sm font-medium text-foreground">Capabilities</p>
          <CapabilityList view={view} />
        </div>

        {connected && (
          <div className="rounded-lg border border-subtle p-3">
            <p className="mb-2 text-body-sm font-medium text-foreground">Activity</p>
            <p className="text-meta text-tertiary">
              {lastObservation
                ? `Last observation: ${lastObservation}`
                : "Nothing observed yet."}
            </p>
          </div>
        )}

        {usage.totalRuns > 0 && (
          <div className="rounded-lg border border-subtle p-3">
            <p className="mb-2 text-body-sm font-medium text-foreground">Usage</p>
            <dl className="grid grid-cols-2 gap-x-4 gap-y-0.5 text-meta">
              <div className="flex justify-between gap-2">
                <dt className="text-tertiary">Active runs</dt>
                <dd className="text-muted-foreground">{usage.activeRuns}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-tertiary">Completed runs</dt>
                <dd className="text-muted-foreground">{usage.completedRuns}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-tertiary">Files</dt>
                <dd className="text-muted-foreground">{usage.artifacts}</dd>
              </div>
              <div className="flex justify-between gap-2">
                <dt className="text-tertiary">Work items</dt>
                <dd className="text-muted-foreground">{usage.workItems}</dd>
              </div>
            </dl>
          </div>
        )}

        {!live && view.status.kind !== "unavailable" && view.status.kind !== "configuration_required" && (
          <ConnectPrompt view={view} busy={busy} onConnect={onConnect} />
        )}

        {(view.status.kind === "unavailable" || view.status.kind === "configuration_required") && (
          <div className="rounded-lg border border-subtle p-3">
            <p className="text-meta text-tertiary">
              {view.descriptor.requirement ??
                "This connector cannot observe anything in this environment."}
            </p>
            <div className="mt-3">
              <Button type="button" size="sm" variant="outline" onClick={onDisconnect}>
                Dismiss
              </Button>
            </div>
          </div>
        )}

        {live && (
          <div>
            <Button type="button" size="sm" variant="outline" onClick={onDisconnect}>
              Disconnect
            </Button>
          </div>
        )}
      </SectionStack>
    </div>
  )
}

export function ConnectorsSection() {
  /**
   * The one mount that restores connections is the workspace, not this
   * panel: opening settings must not be the thing that starts observing a
   * user's machine.
   */
  const connectors = useAgentConnectors()
  const [openProvider, setOpenProvider] = useState<AgentProviderId | null>(null)
  const [busy, setBusy] = useState<AgentProviderId | null>(null)

  // The domain snapshot and the clock it was taken at, refreshed together
  // whenever a connector's state moves.
  const { state: agentState, now } = useAgentSnapshot(connectors.manager)

  const usageFor = useCallback(
    (provider: AgentProviderId): ProviderUsage =>
      agentState ? summarizeProviderUsage(agentState, provider) : EMPTY_PROVIDER_USAGE,
    [agentState]
  )

  const handleConnect = useCallback(
    async (provider: AgentProviderId) => {
      setBusy(provider)
      try {
        await connectors.connect(provider)
      } finally {
        setBusy(null)
      }
    },
    [connectors]
  )

  const open = openProvider ? connectors.view(openProvider) : undefined

  if (open) {
    return (
      <ConnectorDetail
        view={open}
        usage={usageFor(open.descriptor.provider)}
        now={now}
        busy={busy === open.descriptor.provider}
        onBack={() => setOpenProvider(null)}
        onConnect={() => void handleConnect(open.descriptor.provider)}
        onDisconnect={() => connectors.disconnect(open.descriptor.provider)}
      />
    )
  }

  const connected = connectors.connectors.filter((view) => view.status.kind === "connected")
  const others = connectors.connectors.filter((view) => view.status.kind !== "connected")

  return (
    <div>
      <SectionHeading
        title="AI connectors"
        description="Connect the AI agents you use and watch them work inside TabDump."
      />

      {connected.length === 0 && (
        <div className="mb-4 rounded-lg border border-subtle p-4">
          <div className="flex items-center gap-2">
            <Bot className="size-4 text-tertiary" aria-hidden />
            <p className="text-body-sm font-medium text-foreground">No agents connected yet</p>
          </div>
          <p className="mt-1 text-meta text-tertiary">
            Connect an agent below and its runs, activity and files appear in your workspace —
            observed only, never controlled.
          </p>
        </div>
      )}

      {connected.length > 0 && (
        <div className="mb-5">
          <p className="mb-2 text-eyebrow text-tertiary">Connected</p>
          <SectionStack>
            {connected.map((view) => (
              <ConnectorRow
                key={view.descriptor.provider}
                view={view}
                usage={usageFor(view.descriptor.provider)}
                onOpen={setOpenProvider}
              />
            ))}
          </SectionStack>
        </div>
      )}

      {others.length > 0 && (
        <div>
          <p className="mb-2 text-eyebrow text-tertiary">
            {connected.length > 0 ? "Other" : "Available"}
          </p>
          <SectionStack>
            {others.map((view) => (
              <ConnectorRow
                key={view.descriptor.provider}
                view={view}
                usage={usageFor(view.descriptor.provider)}
                onOpen={setOpenProvider}
              />
            ))}
          </SectionStack>
        </div>
      )}

      <p className="mt-5 flex items-start gap-1.5 text-meta text-tertiary">
        <Plug className="mt-0.5 size-3 shrink-0" aria-hidden />
        TabDump observes agents. It never runs commands, sends prompts, or changes your files.
      </p>
    </div>
  )
}
