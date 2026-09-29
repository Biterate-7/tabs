"use client"

import { useCallback, useId, useState } from "react"
import { Button } from "@/components/ui/button"
import { AgentIcon } from "@/components/agents/agent-icon"
import { useAgentPlatform } from "@/hooks/use-agent-platform"
import { hasUsableMcpToken, useMcpTokens } from "@/hooks/use-mcp-tokens"
import { useNow } from "@/hooks/use-now"
import {
  activeAuthMethod,
  authIntro,
  offeredAuthMethods,
  signInShape,
  unavailableAuthMethods,
} from "@/lib/agents/platform/authentication"
import { PLATFORM_PROVIDERS, platformProvider } from "@/lib/agents/platform/catalog"
import { CONNECTION_PHASE_LABEL } from "@/lib/agents/platform/lifecycle"
import { agentConnectorSurface } from "@/lib/platform"
import { cn } from "@/lib/utils"
import { SectionStack } from "./section-ui"
import type { AgentRuntimeApi } from "@/hooks/use-agent-runtime"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import type { UseProviderConnections } from "@/hooks/use-provider-connections"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { PlatformProvider, PlatformSurface } from "@/lib/agents/platform/catalog"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"
import type { ProviderConnectionView, RuntimeProviderStatus } from "@/lib/agents/runtime/protocol"

/**
 * Settings → Agents → Connections (Agent Authentication & Runtime).
 *
 * One row per agent Hubble knows: where it stands and how it authenticates
 * here, with one button into the same Connect Agent flow the Command Centre
 * uses. Every word comes from the capability model and the runtime's own
 * report — the rows are the catalogue, not a list typed into this file — so
 * a new agent appears here by being added to the catalogue.
 *
 * "Authentication" names a method only when it is true: the one the runtime
 * reported in use, or the ones Hubble offers here ("Anthropic API key",
 * "Google account"). It never claims an account the runtime did not report,
 * and a provider with nothing offered here says so.
 */

/** The platform hook, wired for Settings: the same facts the Command Centre reads. */
export function useSettingsAgentPlatform(
  runtime: AgentRuntimeApi,
  connections: UseProviderConnections
): { platform: UseAgentPlatform; surface: PlatformSurface } {
  const [surface] = useState(() => agentConnectorSurface())
  const now = useNow()
  const mcpTokens = useMcpTokens({ enabled: surface === "web" })
  const mcpTokenIssued = hasUsableMcpToken(mcpTokens.state, now)

  const providerKeyConnected = useCallback(
    (provider: AgentProviderId): boolean | undefined => {
      const spec = platformProvider(provider)
      if (!spec || signInShape(spec, surface) !== "provider-key") return undefined
      if (connections.loading || connections.failure) return undefined
      return connections.forProvider(provider)?.status === "connected"
    },
    [connections, surface]
  )

  const platform = useAgentPlatform({
    client: runtime.client,
    status: runtime.status,
    providerKeyConnected,
    surface,
    ...(mcpTokenIssued !== undefined ? { mcpTokenIssued } : {}),
  })
  return { platform, surface }
}

export function AgentConnectionsPanel({
  platform,
  surface,
  onOpen,
}: {
  platform: UseAgentPlatform
  surface: PlatformSurface
  onOpen: (provider: AgentProviderId) => void
}) {
  return (
    <section aria-label="Agent connections" className="mb-6">
      <p className="mb-2 text-label text-muted-foreground">Connections</p>
      <SectionStack>
        {PLATFORM_PROVIDERS.map((spec) => {
          const phase = platform.phaseOf(spec.provider)
          const sessions = platform.sessionsFor(spec.provider)
          return (
            <ConnectionRow
              key={spec.provider}
              spec={spec}
              phase={phase}
              {...(spec.chat && !sessions.available ? { sessionsUnavailable: sessions.reason } : {})}
              authLine={authenticationLine(spec, surface, platform.statusOf(spec.provider), phase)}
              onOpen={() => onOpen(spec.provider)}
            />
          )
        })}
      </SectionStack>
      <p className="mt-2 text-meta text-tertiary">
        Use your existing account where the provider supports it. Each agent keeps its own sign-in; Hubble never sees
        your password or token.
      </p>
    </section>
  )
}

/**
 * A connector page's authentication block: how this agent authenticates
 * here, what is in use, what is not available and why, and the way in.
 * Replaces the old "Connect Anthropic API" card with the same answer for
 * every provider.
 */
export function AgentAuthenticationCard({
  platform,
  surface,
  provider,
  onOpen,
}: {
  platform: UseAgentPlatform
  surface: PlatformSurface
  provider: AgentProviderId
  onOpen: () => void
}) {
  const spec = platformProvider(provider)
  if (!spec) return null
  const phase = platform.phaseOf(provider)
  const unavailable = unavailableAuthMethods(spec, surface)
  return (
    <div className="rounded-md border border-border bg-card px-4 py-3">
      <div className="flex items-center justify-between gap-2">
        <p className="text-body text-foreground">Authentication</p>
        <span className="flex items-center gap-1.5 text-meta text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", phaseTone(phase))} />
          {CONNECTION_PHASE_LABEL[phase]}
        </span>
      </div>
      <p className="mt-0.5 text-body-sm text-muted-foreground">{authIntro(spec, surface)}</p>
      <p className="mt-1 text-meta text-tertiary">
        <span className="text-muted-foreground">Method · </span>
        {authenticationLine(spec, surface, platform.statusOf(provider), phase)}
      </p>
      {unavailable.length > 0 && (
        <ul className="mt-2 flex flex-col gap-0.5">
          {unavailable.map(({ method, reason }) => (
            <li key={method.id} className="text-meta text-tertiary">
              <span className="text-muted-foreground">{method.label}</span> — {reason}
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <Button type="button" size="sm" variant={phase === "connected" ? "outline" : "default"} onClick={onOpen}>
          {phase === "connected" ? "Manage connection" : `Connect ${spec.displayName}`}
        </Button>
      </div>
    </div>
  )
}

function ConnectionRow({
  spec,
  phase,
  sessionsUnavailable,
  authLine,
  onOpen,
}: {
  spec: PlatformProvider
  phase: ConnectionPhase
  /**
   * Why Hubble will not start sessions with it (Codex), whatever its sign-in —
   * said on the row, not only in the dialog. Absent: sessions are possible.
   */
  sessionsUnavailable?: string
  authLine: string
  onOpen: () => void
}) {
  const nameId = useId()
  const stateId = useId()
  const label = CONNECTION_PHASE_LABEL[phase]
  return (
    <div className="flex items-start gap-3 px-4 py-3">
      <span className="mt-0.5">
        <AgentIcon connector={spec.provider} size="md" />
      </span>
      <div className="min-w-0 flex-1">
        <p id={nameId} className="text-body text-foreground">
          {spec.displayName}
        </p>
        <p id={stateId} className="mt-0.5 flex items-center gap-1.5 text-meta text-muted-foreground">
          <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", phaseTone(phase))} />
          {label}
          {sessionsUnavailable && phase !== "sessions_unavailable" && (
            <span className="text-tertiary">· Sessions unavailable</span>
          )}
        </p>
        <p className="mt-0.5 text-meta text-tertiary">
          <span className="text-muted-foreground">Authentication · </span>
          {authLine}
        </p>
        {/* Signed in is not usable: the exact reason, beside the sign-in it does not depend on. */}
        {sessionsUnavailable && (
          <p className="mt-0.5 text-meta text-tertiary">
            <span className="text-muted-foreground">Sessions · </span>
            {sessionsUnavailable}
          </p>
        )}
      </div>
      <Button
        type="button"
        size="sm"
        variant={phase === "connected" ? "ghost" : "outline"}
        className="shrink-0 self-center"
        // Which agent, and its state in words, for a screen reader — so the
        // button never depends on the row's dot or position.
        aria-describedby={`${nameId} ${stateId}`}
        onClick={onOpen}
      >
        {phase === "connected" ? "Manage" : sessionsUnavailable ? "Details" : "Connect"}
      </Button>
    </div>
  )
}

/**
 * How an agent authenticates here, in one line. The method in use when the
 * runtime said which; the runtime's own sign-in when it only said "signed
 * in"; otherwise what Hubble offers here — or that it offers nothing.
 */
export function authenticationLine(
  spec: PlatformProvider,
  surface: PlatformSurface,
  status: RuntimeProviderStatus | ProviderConnectionView | undefined,
  phase: ConnectionPhase
): string {
  const active = activeAuthMethod(spec, status)
  if (active && phase !== "auth_unsupported") return `${active.label} · in use`
  if (status?.authentication === "authenticated" && !status.authIssue && signInShape(spec, surface, status) === "native") {
    return `Signed in through ${spec.runtimeName}`
  }
  const offered = offeredAuthMethods(spec, surface).map((entry) => entry.method.label)
  if (offered.length === 0) return "Not supported through Hubble here"
  return offered.join(" or ")
}

function phaseTone(phase: ConnectionPhase): string {
  switch (phase) {
    case "connected":
    case "awaiting_approval":
      return "bg-success"
    // Signed in, not usable: never the colour of "ready".
    case "sessions_unavailable":
      return "bg-warning"
    case "error":
    case "timeout":
    case "auth_failed":
    case "auth_unsupported":
    case "connection_lost":
      return "bg-destructive"
    case "connecting":
    case "authenticating":
      return "bg-foreground motion-safe:animate-pulse"
    default:
      return "bg-tertiary"
  }
}
