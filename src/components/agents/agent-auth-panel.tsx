"use client"

import { useId, useState } from "react"
import { Check, ExternalLink, Info, RotateCw } from "lucide-react"
import { Button } from "@/components/ui/button"
import { ProviderConnectionCard } from "@/components/settings/sections/provider-connection-card"
import {
  activeAuthMethod,
  authIntro,
  externalAuthMethods,
  offeredAuthMethods,
  unavailableAuthMethods,
} from "@/lib/agents/platform/authentication"
import { CONNECTION_PHASE_LABEL, phaseRecovery, recoveryLabel } from "@/lib/agents/platform/lifecycle"
import { cn } from "@/lib/utils"
import type { UseProviderConnections } from "@/hooks/use-provider-connections"
import type { AgentAuthMethod, PlatformProvider, PlatformSurface } from "@/lib/agents/platform/catalog"
import type { ConnectionPhase } from "@/lib/agents/platform/lifecycle"
import type { ProviderConnectionView, RuntimeProviderStatus } from "@/lib/agents/runtime/protocol"

/**
 * How an agent authenticates, for any provider (Agent Authentication &
 * Runtime).
 *
 * ## Everything here comes from the capability model
 *
 * The methods are the catalogue's, filtered to what Hubble offers on this
 * surface and reconciled with what the agent itself advertised
 * (`offeredAuthMethods`); the state is the runtime's (`phase`, `status`).
 * There is no provider branch: Claude Code's Console sign-in, Gemini CLI's
 * Google sign-in, an Anthropic API key and a custom agent's Hubble token are
 * all rows of the same list, and a provider whose catalogue offers none reads
 * "Authentication through Hubble isn't currently supported".
 *
 * ## What it never shows
 *
 * Account details the runtime did not report. "Already authenticated" says
 * which *kind* of sign-in only when the runtime said so (`authKind`), and
 * never an email, organisation or plan — Hubble keeps none. No credential is
 * ever typed here except an API key, into the uncontrolled field of the
 * existing secure form, which posts it once to the credential route.
 */
export type AgentAuthPanelProps = {
  provider: PlatformProvider
  surface: PlatformSurface
  phase: ConnectionPhase
  /** The one sentence for the phase, from the lifecycle. */
  sentence: string
  /** The runtime's latest word on this provider — a connect/sign-in reply or its status. */
  status?: RuntimeProviderStatus | ProviderConnectionView
  /** Whether the agent has been asked yet on this surface (a connect reply exists). */
  asked: boolean
  busy: boolean
  /** Hubble will not start sessions with it — sign-in is shown, not offered. */
  sessionsBlocked?: boolean
  /** The user's own provider credentials, for a method whose key Hubble stores. */
  apiKeys?: UseProviderConnections
  /** Starts the agent's own sign-in for one method it advertised. */
  onSignIn: (runtimeMethodId: string) => void
  /** Asks the agent again. */
  onRetry: () => void
  /** Where a Hubble MCP token is issued. */
  onOpenSettings?: () => void
}

export function AgentAuthPanel({
  provider,
  surface,
  phase,
  sentence,
  status,
  asked,
  busy,
  sessionsBlocked = false,
  apiKeys,
  onSignIn,
  onRetry,
  onOpenSettings,
}: AgentAuthPanelProps) {
  const groupId = useId()
  const advertised = status && "authMethods" in status ? status.authMethods : undefined
  /** What Hubble offers here, from the catalogue alone. */
  const catalogued = offeredAuthMethods(provider, surface)
  /** Of those, what can be started now — reconciled with what the agent advertised. */
  const offered = offeredAuthMethods(provider, surface, advertised)
  const external = externalAuthMethods(provider, surface)
  const unavailable = unavailableAuthMethods(provider, surface)
  const active = activeAuthMethod(provider, status)

  const [chosenId, setChosenId] = useState<string | null>(null)
  const chosen =
    offered.find((entry) => entry.method.id === chosenId) ??
    offered.find((entry) => entry.method.id === active?.id) ??
    offered[0]

  const signedIn = status?.authentication === "authenticated" && !status.authIssue
  const runtimeOwned = catalogued.some((entry) => entry.method.owner === "runtime")
  const recovery = phaseRecovery(phase).filter(
    (action) => action === "retry" || action === "check_again" || action === "setup"
  )

  return (
    <section aria-label="Authentication" className="flex flex-col gap-3">
      <p className="text-body-sm text-muted-foreground">{authIntro(provider, surface)}</p>

      {/* Where it stands, in words, with the actions that move it on. Never a
          bare spinner: every transient phase here is bounded upstream. */}
      <div className="flex flex-col gap-1.5">
        <p role="status" className="flex items-center gap-1.5 text-body-sm text-foreground">
          <PhaseDot phase={phase} />
          <span className="sr-only">{CONNECTION_PHASE_LABEL[phase]}: </span>
          {/* Signed in but not usable says both halves, not "Already authenticated" alone. */}
          {signedIn && !busy && phase !== "sessions_unavailable" ? "Already authenticated" : sentence}
        </p>
        {recovery.length > 0 && !busy && (
          <div className="flex flex-wrap items-center gap-1.5">
            {recovery.map((action) =>
              action === "setup" ? (
                <a
                  key={action}
                  href={chosen?.method.docsUrl ?? provider.docsUrl}
                  target="_blank"
                  rel="noreferrer noopener"
                  className="inline-flex h-6 items-center gap-1 rounded-xs px-2 text-body-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                >
                  {recoveryLabel(phase, action)}
                  <ExternalLink className="size-3" aria-hidden />
                </a>
              ) : (
                <Button key={action} type="button" size="sm" variant="outline" onClick={onRetry}>
                  <RotateCw />
                  {recoveryLabel(phase, action)}
                </Button>
              )
            )}
          </div>
        )}
      </div>

      {signedIn && runtimeOwned && (
        <div className="rounded-md border border-subtle bg-surface px-3 py-2">
          <p className="flex items-center gap-1.5 text-body-sm text-foreground">
            <Check className="size-3.5 text-success" aria-hidden />
            {provider.runtimeName} is signed in locally
            {active ? <span className="text-muted-foreground"> · {active.label}</span> : null}
          </p>
          <p className="mt-0.5 text-meta text-muted-foreground">
            Account authentication is managed by {provider.runtimeName}. Hubble never sees or keeps the sign-in.
          </p>
        </div>
      )}

      {status?.authIssue === "method_not_permitted" && (
        <div role="note" className="rounded-md border border-warning/40 bg-surface px-3 py-2">
          <p className="text-body-sm text-foreground">
            {provider.runtimeName} is signed in{active ? ` with a ${active.label}` : ""}, which Hubble can&apos;t use.
          </p>
          {active && methodReason(provider, surface, active) && (
            <p className="mt-0.5 text-meta text-muted-foreground">{methodReason(provider, surface, active)}</p>
          )}
          {offered.length > 0 && (
            <p className="mt-0.5 text-meta text-muted-foreground">
              Sign in with {offered.map((entry) => entry.method.label).join(" or ")} to use it here. Hubble won&apos;t
              switch it for you.
            </p>
          )}
        </div>
      )}

      {catalogued.length === 0 ? (
        <p className="text-body-sm text-muted-foreground">
          Authentication through Hubble isn&apos;t currently supported for {provider.displayName}
          {surface === "desktop" ? " in the desktop app" : " here"}.
        </p>
      ) : offered.length === 0 ? (
        // Supported here, but the agent did not offer any sign-in Hubble can
        // start — or it is already signed in, which the block above says.
        !signedIn && (
          <p className="text-body-sm text-muted-foreground">
            {provider.runtimeName} did not offer a sign-in Hubble supports. Update {provider.runtimeName}, or sign in to
            it directly, then check again.
          </p>
        )
      ) : (
        <fieldset className="flex flex-col gap-1.5">
          <legend className="text-eyebrow text-tertiary">Authentication</legend>
          {offered.length > 1 && (
            <div role="radiogroup" aria-label="Authentication method" className="mt-1.5 flex flex-col gap-1">
              {offered.map((entry) => {
                const selected = entry.method.id === chosen?.method.id
                return (
                  <label
                    key={entry.method.id}
                    className={cn(
                      "flex cursor-default items-start gap-2 rounded-md border px-2.5 py-2 transition-colors duration-(--duration-fast) has-[:focus-visible]:ring-2 has-[:focus-visible]:ring-ring/50",
                      selected ? "border-border bg-surface-selected" : "border-subtle hover:bg-surface-hover"
                    )}
                  >
                    <input
                      type="radio"
                      name={groupId}
                      className="mt-1"
                      checked={selected}
                      onChange={() => setChosenId(entry.method.id)}
                    />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body-sm text-foreground">{entry.method.label}</span>
                      <span className="block text-meta text-tertiary">{ownerLine(provider, entry.method)}</span>
                    </span>
                  </label>
                )
              })}
            </div>
          )}

          {chosen && (
            <MethodBody
              provider={provider}
              method={chosen.method}
              runtimeMethodId={chosen.runtimeMethodId}
              runtimeMethodName={advertised?.find((entry) => entry.id === chosen.runtimeMethodId)?.name}
              single={offered.length === 1}
              phase={phase}
              asked={asked}
              busy={busy}
              signedIn={signedIn}
              sessionsBlocked={sessionsBlocked}
              apiKeys={apiKeys}
              onSignIn={onSignIn}
              onRetry={onRetry}
              onOpenSettings={onOpenSettings}
            />
          )}
        </fieldset>
      )}

      {external.length > 0 && (
        <ul aria-label="Set up in the agent itself" className="flex flex-col gap-1">
          {external.map((method) => (
            <li key={method.id} className="flex gap-1.5 text-meta text-muted-foreground">
              <Info className="mt-0.5 size-3 shrink-0" aria-hidden />
              <span>
                <span className="text-foreground">{method.label}</span> —{" "}
                {method.support.status === "external" ? method.support.setup : method.summary}
              </span>
            </li>
          ))}
        </ul>
      )}

      {unavailable.length > 0 && (
        <details className="group rounded-md border border-subtle px-3 py-2">
          <summary className="cursor-default text-meta text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/50">
            Not available in Hubble ({unavailable.length})
          </summary>
          <ul className="mt-1.5 flex flex-col gap-1.5">
            {unavailable.map(({ method, reason }) => (
              <li key={method.id} className="text-meta">
                <span className="text-foreground">{method.label}</span>
                <span className="text-muted-foreground"> — {reason}</span>
                {method.docsUrl && (
                  <a
                    href={method.docsUrl}
                    target="_blank"
                    rel="noreferrer noopener"
                    className="ml-1 inline-flex items-center gap-0.5 text-tertiary hover:text-foreground"
                  >
                    Learn more
                    <ExternalLink className="size-3" aria-hidden />
                  </a>
                )}
              </li>
            ))}
          </ul>
        </details>
      )}
    </section>
  )
}

/** Who holds a method's credential, in one line. */
function ownerLine(provider: PlatformProvider, method: AgentAuthMethod): string {
  switch (method.owner) {
    case "runtime":
      return `Sign in through ${provider.runtimeName}`
    case "hubble":
      return method.kind === "hubble_token" ? "Issued by Hubble, read-only" : "Stored encrypted by Hubble, for your sessions only"
    case "agent_config":
      return `Configured in ${provider.runtimeName}`
  }
}

function methodReason(provider: PlatformProvider, surface: PlatformSurface, method: AgentAuthMethod): string | undefined {
  return unavailableAuthMethods(provider, surface).find((entry) => entry.method.id === method.id)?.reason
}

function MethodBody({
  provider,
  method,
  runtimeMethodId,
  runtimeMethodName,
  single,
  phase,
  asked,
  busy,
  signedIn,
  sessionsBlocked,
  apiKeys,
  onSignIn,
  onRetry,
  onOpenSettings,
}: {
  provider: PlatformProvider
  method: AgentAuthMethod
  runtimeMethodId?: string
  runtimeMethodName?: string
  single: boolean
  phase: ConnectionPhase
  asked: boolean
  busy: boolean
  signedIn: boolean
  sessionsBlocked: boolean
  apiKeys?: UseProviderConnections
  onSignIn: (runtimeMethodId: string) => void
  onRetry: () => void
  onOpenSettings?: () => void
}) {
  if (method.owner === "hubble" && method.kind === "api_key") {
    const connectable = apiKeys?.connectableFor(provider.provider)
    if (!apiKeys) {
      return <p className="text-body-sm text-muted-foreground">{method.summary}</p>
    }
    return (
      <ProviderConnectionCard
        provider={provider.provider}
        providerName={provider.displayName}
        connection={apiKeys.forProvider(provider.provider)}
        input={connectable?.input}
        unavailable={apiKeys.unavailable}
        durable={apiKeys.durable}
        busy={apiKeys.busy}
        onConnect={apiKeys.connect}
        onRotate={apiKeys.rotate}
        onDisconnect={apiKeys.disconnect}
        title={method.label}
      />
    )
  }

  if (method.kind === "hubble_token") {
    return (
      <div className="flex flex-col gap-1.5">
        {single && <p className="text-body-sm text-foreground">{method.label}</p>}
        <p className="text-body-sm text-muted-foreground">{method.summary}</p>
        {onOpenSettings && (
          <Button type="button" size="sm" variant="outline" className="self-start" onClick={onOpenSettings}>
            Open AI connectors
          </Button>
        )}
      </div>
    )
  }

  // A sign-in the agent runs itself.
  return (
    <div className="flex flex-col gap-1.5">
      {single && <p className="text-body-sm text-foreground">{method.label}</p>}
      <p className="text-meta text-muted-foreground">{method.summary}</p>
      {!sessionsBlocked && !signedIn && (
        <div className="flex flex-wrap items-center gap-1.5">
          {runtimeMethodId ? (
            <Button
              type="button"
              size="sm"
              variant={phase === "auth_failed" ? "default" : "outline"}
              disabled={busy}
              onClick={() => onSignIn(runtimeMethodId)}
            >
              {phase === "auth_failed" ? "Try again" : signInLabel(runtimeMethodName ?? method.label)}
            </Button>
          ) : asked ? (
            // Asked, and it did not offer this method — said, not offered.
            <p className="text-meta text-tertiary">
              {provider.runtimeName} did not offer this sign-in. Update {provider.runtimeName}, then check again.
            </p>
          ) : (
            <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onRetry}>
              Check sign-in
            </Button>
          )}
        </div>
      )}
      {!sessionsBlocked && (
        <p className="text-meta text-tertiary">
          Sign-in happens in {provider.runtimeName}&apos;s own window or browser page. Hubble never sees your password or
          token, and keeps none.
        </p>
      )}
    </div>
  )
}

/** A method the agent named "Log in with Google" keeps its own verb; a bare name reads "Sign in with …". */
export function signInLabel(name: string): string {
  return /^(sign|log)\s?in\b/i.test(name) ? name : `Sign in with ${name}`
}

function PhaseDot({ phase }: { phase: ConnectionPhase }) {
  const tone =
    phase === "connected" || phase === "awaiting_approval"
      ? "bg-success"
      : phase === "sessions_unavailable"
        ? "bg-warning"
        : phase === "error" ||
          phase === "timeout" ||
          phase === "auth_failed" ||
          phase === "connection_lost" ||
          phase === "auth_unsupported"
        ? "bg-destructive"
        : phase === "connecting" || phase === "authenticating"
          ? "bg-foreground motion-safe:animate-pulse"
          : "bg-tertiary"
  return <span aria-hidden className={cn("size-1.5 shrink-0 rounded-full", tone)} />
}
