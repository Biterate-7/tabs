"use client"

import { useEffect, useRef, useState } from "react"
import { Check, ChevronLeft, Copy, Minus, RotateCw } from "lucide-react"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { AgentIcon } from "@/components/agents/agent-icon"
import { PERMISSION_SCOPE_LABEL, RUNTIME_ERROR_PRESENTATION } from "@/lib/agents/command-centre/presentation"
import { PLATFORM_FEATURE_LABEL, PLATFORM_PROVIDERS, platformProvider } from "@/lib/agents/platform/catalog"
import {
  APPROVABLE_SCOPES,
  CONNECTION_PHASE_LABEL,
  defaultApprovedScopes,
  signInKind,
  stepFor,
} from "@/lib/agents/platform/lifecycle"
import { cn } from "@/lib/utils"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { AgentPermissionScope } from "@/lib/agents/control/permissions"
import type { ConnectStep } from "@/lib/agents/platform/lifecycle"

/**
 * Connect Agent (Phase J): choose → detect → sign in → approve → connected.
 *
 * ## One flow for every provider
 *
 * The steps are the same whether the agent is Claude over its SDK, Gemini,
 * Codex or Grok over ACP, or a custom MCP client. What each step *says* comes
 * from the provider's catalogue entry and from the runtime's own reports; the
 * dialog has no provider branch.
 *
 * ## Where each step's answer comes from
 *
 *   - **Detect** — the runtime's `detect_providers`: a PATH walk on the user's
 *     machine that runs nothing and returns no path. The install command is
 *     shown for the user to run. Hubble never runs it.
 *   - **Sign in** — the agent's *own* sign-in. The agent is asked whether it
 *     is signed in as soon as this step shows, and what it answers is what the
 *     step says (Phase J.2): signed in, sign-in required, or could not be
 *     verified. For an ACP agent the sign-in buttons are the methods it
 *     advertised, started through `authenticate_provider` with a method id and
 *     nothing else; the agent opens its provider's page itself. For Claude on
 *     the web, the user's own key in Settings; in the desktop app, Claude
 *     Code's own login. For an MCP client, a token issued in Settings. No
 *     credential is ever typed into this dialog.
 *   - **Approve** — what the user lets the agent do. Changing files and running
 *     commands are off by default, and even on, each use still asks.
 *
 * The step shown is derived from the connection phase, so reopening the
 * dialog for a half-connected agent lands where it actually is.
 */
export function ConnectAgentDialog({
  open,
  onOpenChange,
  platform,
  initialProvider,
  onOpenSettings,
  onStartSession,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  platform: UseAgentPlatform
  initialProvider?: AgentProviderId | null
  /** Settings → Agents, where provider keys and MCP tokens live. */
  onOpenSettings?: () => void
  onStartSession?: (provider: AgentProviderId) => void
}) {
  const [chosen, setChosen] = useState<AgentProviderId | null>(initialProvider ?? null)
  /** A step the user moved to by hand, when the facts allow it. */
  const [advanced, setAdvanced] = useState<ConnectStep | null>(null)
  const [scopes, setScopes] = useState<AgentPermissionScope[] | null>(null)
  const [copied, setCopied] = useState(false)

  const spec = chosen ? platformProvider(chosen) : undefined
  const phase = chosen ? platform.phaseOf(chosen) : null
  const connection = chosen ? platform.connections[chosen] : undefined
  // How this agent signs in *here*: the runtime knows whether it can start
  // the agent's own login in this shell (Claude, in the desktop app).
  const signIn = spec ? signInKind(spec, chosen ? platform.statusOf(chosen) : undefined) : undefined
  /*
    An agent Hubble will not start sessions with (Codex today) is never taken
    past Sign in: there is nothing for the user to sign in to or approve, and
    asking them to would be asking for a login that buys nothing. The step
    shows what is true of it instead — installed, signed in or not — and why.
  */
  const sessionsBlocked = Boolean(spec?.chat && chosen && !platform.sessionsFor(chosen).available)
  const uncapped: ConnectStep = !chosen || !phase ? "choose" : stepFor(phase)
  const derived: ConnectStep = sessionsBlocked && order(uncapped) > order("sign_in") ? "sign_in" : uncapped
  const step: ConnectStep =
    !sessionsBlocked && advanced && order(advanced) > order(derived) && derived !== "detect" && derived !== "sign_in"
      ? advanced
      : derived

  function reset(next: AgentProviderId | null) {
    setChosen(next)
    setAdvanced(null)
    setScopes(null)
    setCopied(false)
  }

  const busy = chosen !== null && platform.pending === chosen
  const error = chosen ? platform.errors[chosen] : undefined
  const sentence = chosen ? platform.sentenceOf(chosen) : ""
  const sessions = chosen ? platform.sessionsFor(chosen) : undefined

  /*
    Reaching the Sign in step asks the agent where it stands — once per
    opening, never on a timer. The same runtime command as the "Check again"
    button, so the answer shown is always the agent's own.
  */
  const asked = useRef<string | null>(null)
  useEffect(() => {
    if (!open || !chosen || step !== "sign_in" || signIn !== "native") return
    if (connection || busy || asked.current === chosen) return
    asked.current = chosen
    void platform.connect(chosen)
  })
  const detection = chosen ? platform.detections?.find((entry) => entry.provider === chosen) : undefined
  const approvedScopes = scopes ?? (spec ? defaultApprovedScopes(spec) : [])

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) reset(initialProvider ?? null)
        onOpenChange(next)
      }}
    >
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>{spec ? `Connect ${spec.displayName}` : "Connect an agent"}</DialogTitle>
          <DialogDescription>
            {spec
              ? spec.pitch
              : "Bring an AI agent into Hubble. It works in projects you authorize, with the workspace context you choose, and asks before it changes anything."}
          </DialogDescription>
        </DialogHeader>

        {chosen && (
          <ol aria-label="Connection steps" className="flex items-center gap-1.5 text-label">
            {(["detect", "sign_in", "approve", "done"] as const).map((entry) => (
              <li
                key={entry}
                aria-current={entry === step ? "step" : undefined}
                className={cn(
                  "rounded-full px-2 py-0.5",
                  entry === step
                    ? "bg-surface-selected text-foreground"
                    : order(entry) < order(step)
                      ? "text-muted-foreground"
                      : "text-tertiary"
                )}
              >
                {STEP_LABEL[entry]}
              </li>
            ))}
          </ol>
        )}

        {step === "choose" && (
          <ul aria-label="Agents" className="flex flex-col gap-1">
            {PLATFORM_PROVIDERS.map((entry) => {
              const entryPhase = platform.phaseOf(entry.provider)
              const entryBlocked = entry.chat && !platform.sessionsFor(entry.provider).available
              return (
                <li key={entry.provider}>
                  <button
                    type="button"
                    onClick={() => reset(entry.provider)}
                    className="flex w-full items-center gap-2.5 rounded-md border border-subtle px-2.5 py-2 text-left transition-colors hover:bg-surface-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
                  >
                    <AgentIcon connector={entry.provider} size="sm" />
                    <span className="min-w-0 flex-1">
                      <span className="block text-body-sm text-foreground">{entry.displayName}</span>
                      <span className="block truncate text-meta text-tertiary">{entry.vendor}</span>
                    </span>
                    <span className="shrink-0 text-label text-tertiary">
                      {CONNECTION_PHASE_LABEL[entryPhase]}
                      {entryBlocked && entryPhase !== "not_installed" ? " · sessions unavailable" : ""}
                    </span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {spec && step === "detect" && (
          <section aria-label="Detect" className="flex flex-col gap-2">
            <p className="text-body-sm text-foreground">{CONNECTION_PHASE_LABEL[phase!]}</p>
            <p className="text-body-sm text-muted-foreground">{sentence}</p>
            {/* Before anyone installs it expecting a chat it will not get. */}
            {sessionsBlocked && sessions && !sessions.available && (
              <p role="note" className="text-body-sm text-warning">
                Sessions are unavailable. {sessions.reason}
              </p>
            )}
            {spec.installCommand && (phase === "not_installed" || phase === "needs_adapter") && (
              <div className="flex items-center gap-2 rounded-md border border-subtle bg-surface px-2.5 py-1.5">
                {/* Shown to copy. Hubble does not install software. */}
                <code className="min-w-0 flex-1 truncate font-mono text-meta text-foreground">
                  {spec.installCommand}
                </code>
                <Button
                  type="button"
                  size="xs"
                  variant="ghost"
                  aria-label="Copy install command"
                  onClick={() => {
                    void navigator.clipboard?.writeText(spec.installCommand!).then(() => setCopied(true))
                  }}
                >
                  {copied ? <Check /> : <Copy />}
                </Button>
              </div>
            )}
          </section>
        )}

        {spec && step === "sign_in" && (
          <section aria-label="Sign in" className="flex flex-col gap-2.5">
            {detection?.installed && (
              <p className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
                <Check className="size-3.5 text-success" aria-hidden />
                Installed on this machine
              </p>
            )}
            {/* Said before sign-in, so nobody signs in to an agent expecting a chat it will not get. */}
            {spec.chat && sessions && !sessions.available && (
              <p role="note" className="text-body-sm text-warning">
                Hubble will not start sessions with {spec.displayName}. {sessions.reason}
              </p>
            )}
            <p className="text-body-sm text-muted-foreground">
              {signIn === "native" && spec.signIn.kind !== "native"
                ? (spec.nativeSignInSummary ?? spec.signIn.summary)
                : spec.signIn.summary}
            </p>

            {spec.explainer && (
              <ul aria-label={`What connecting ${spec.displayName} means`} className="flex flex-col gap-1">
                {spec.explainer.map((line) => (
                  <li key={line} className="flex gap-1.5 text-meta text-muted-foreground">
                    <Minus className="mt-1 size-3 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            )}

            {signIn === "native" && (
              <div className="flex flex-col gap-1.5">
                {/* The agent's own answer, asked when this step appeared. */}
                <p role="status" className="text-body-sm text-foreground">
                  {busy
                    ? sentence
                    : connection?.authentication === "authenticated"
                      ? "Signed in."
                      : connection
                        ? sentence
                        : `Hubble has not asked ${spec.displayName} yet.`}
                </p>
                {!sessionsBlocked && connection && connection.authMethods.length > 0 && connection.authentication !== "authenticated" && (
                  <div className="flex flex-wrap gap-1.5">
                    {connection.authMethods.map((method) => (
                      <Button
                        key={method.id}
                        type="button"
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        title={method.description}
                        onClick={() => void platform.authenticate(spec.provider, method.id)}
                      >
                        {signInLabel(method.name)}
                      </Button>
                    ))}
                  </div>
                )}
                {connection?.authentication !== "authenticated" && (
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    className="self-start"
                    disabled={busy}
                    onClick={() => void platform.connect(spec.provider)}
                  >
                    <RotateCw />
                    Check again
                  </Button>
                )}
                {!sessionsBlocked && (
                  <p className="text-meta text-tertiary">
                    Sign-in happens in {spec.displayName}&apos;s own window or browser page. Hubble never sees
                    your password or token, and keeps none.
                  </p>
                )}
              </div>
            )}

            {signIn !== "native" && onOpenSettings && (
              <Button type="button" size="sm" variant="outline" className="self-start" onClick={onOpenSettings}>
                Open AI connectors
              </Button>
            )}
          </section>
        )}

        {spec && step === "approve" && (
          <section aria-label="Approve" className="flex flex-col gap-3">
            {spec.chat && sessions && !sessions.available ? (
              <p role="note" className="text-body-sm text-warning">
                {spec.displayName} can be connected and signed in, but Hubble will not start sessions with it.{" "}
                {sessions.reason}
              </p>
            ) : spec.explainer ? (
              <div>
                <p className="text-eyebrow text-tertiary">What you are connecting</p>
                <ul aria-label={`What connecting ${spec.displayName} means`} className="mt-1 flex flex-col gap-1">
                  {spec.explainer.map((line) => (
                    <li key={line} className="flex gap-1.5 text-meta text-muted-foreground">
                      <Minus className="mt-1 size-3 shrink-0" aria-hidden />
                      {line}
                    </li>
                  ))}
                </ul>
              </div>
            ) : (
              <div>
                <p className="text-eyebrow text-tertiary">Once connected</p>
                <ul className="mt-1 flex flex-col gap-0.5">
                  {spec.features.map((feature) => (
                    <li key={feature} className="flex items-center gap-1.5 text-meta text-muted-foreground">
                      <Check className="size-3 shrink-0 text-success" aria-hidden />
                      {PLATFORM_FEATURE_LABEL[feature]}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <fieldset>
              <legend className="text-eyebrow text-tertiary">{spec.displayName} may</legend>
              <ul className="mt-1.5 flex flex-col gap-1.5">
                {(spec.transport === "mcp"
                  ? APPROVABLE_SCOPES.filter((entry) => entry.scope === "read_workspace")
                  : APPROVABLE_SCOPES
                ).map(({ scope }) => {
                  const on = approvedScopes.includes(scope)
                  return (
                    <li key={scope}>
                      <label className="flex items-center gap-2 text-body-sm text-foreground">
                        <Checkbox
                          checked={on}
                          disabled={spec.transport === "mcp"}
                          onCheckedChange={(checked) =>
                            setScopes(
                              checked
                                ? [...approvedScopes, scope]
                                : approvedScopes.filter((candidate) => candidate !== scope)
                            )
                          }
                        />
                        {PERMISSION_SCOPE_LABEL[scope]}
                        {(scope === "write_project" || scope === "run_commands" || scope === "write_workspace") && (
                          <span className="text-meta text-tertiary">· asks every time</span>
                        )}
                      </label>
                    </li>
                  )
                })}
              </ul>
            </fieldset>
            <div>
              <p className="text-eyebrow text-tertiary">Never</p>
              <ul className="mt-1 flex flex-col gap-0.5">
                {[
                  "Run a shell command through Hubble",
                  "Work outside a project you authorized",
                  "Change a file or run a command without asking you",
                  "See your provider password, key or token",
                ].map((line) => (
                  <li key={line} className="flex items-center gap-1.5 text-meta text-tertiary">
                    <Minus className="size-3 shrink-0" aria-hidden />
                    {line}
                  </li>
                ))}
              </ul>
            </div>
          </section>
        )}

        {spec && step === "done" && (
          <section aria-label="Connected" className="flex flex-col gap-2">
            <div className="flex items-center gap-2.5">
              <AgentIcon connector={spec.provider} size="md" />
              <p className="text-body-sm text-foreground">
                {spec.displayName} is connected.{" "}
                <span className="text-muted-foreground">
                  {!spec.chat
                    ? "Point it at Hubble's MCP server with the token from Settings."
                    : sessions?.available
                      ? "Start a session to work with it."
                      : ""}
                </span>
              </p>
            </div>
            {spec.chat && sessions && !sessions.available && (
              <p role="note" className="text-body-sm text-warning">
                Sessions are not available. {sessions.reason}
              </p>
            )}
          </section>
        )}

        {error && (
          <p role="alert" className="text-body-sm text-destructive">
            {RUNTIME_ERROR_PRESENTATION[error].title}
          </p>
        )}

        <DialogFooter>
          {chosen && step !== "done" && (
            <Button type="button" variant="ghost" className="mr-auto" onClick={() => reset(null)}>
              <ChevronLeft />
              All agents
            </Button>
          )}

          {/* On every step for an agent already in the roster, so one that
              needs signing in again can still be let go of. */}
          {spec && step !== "done" && platform.identity(spec.provider) && (
            <Button type="button" variant="ghost" className="text-destructive" disabled={busy} onClick={() => void platform.disconnect(spec.provider).then(() => reset(null))}>
              Disconnect
            </Button>
          )}

          {spec && step === "detect" && (
            <Button type="button" variant="outline" onClick={() => void platform.detect()}>
              <RotateCw />
              Check again
            </Button>
          )}

          {spec && step === "sign_in" && !sessionsBlocked && (
            <Button
              type="button"
              disabled={!canLeaveSignIn()}
              onClick={() => setAdvanced("approve")}
            >
              Continue
            </Button>
          )}

          {spec && step === "approve" && (
            <Button
              type="button"
              onClick={() => {
                platform.approve(spec.provider, approvedScopes)
                setAdvanced(null)
              }}
            >
              Approve and connect
            </Button>
          )}

          {spec && step === "done" && (
            <Button
              type="button"
              variant="ghost"
              className="mr-auto text-destructive"
              disabled={busy}
              onClick={() => {
                // Ends this agent's sessions and forgets the approval. The
                // agent's own login is its own and stays where it is.
                void platform.disconnect(spec.provider).then(() => reset(null))
              }}
            >
              Disconnect
            </Button>
          )}

          {spec && step === "done" && spec.chat && sessions?.available && onStartSession && (
            <Button type="button" onClick={() => onStartSession(spec.provider)}>
              Start a session
            </Button>
          )}
          {step === "done" && (
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Done
            </Button>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )

  /** Whether sign-in has answered enough to move on. Each kind has its own proof. */
  function canLeaveSignIn(): boolean {
    if (!spec || phase === "sign_in_required") return false
    if (signIn === "native") {
      // The agent itself said it is signed in. "Could not verify" is not that.
      return connection !== undefined && connection.connection === "connected" && connection.authentication === "authenticated"
    }
    return true
  }
}

const STEP_LABEL: Record<Exclude<ConnectStep, "choose">, string> = {
  detect: "Detect",
  sign_in: "Sign in",
  approve: "Approve",
  done: "Connected",
}

/** A method the agent named "ChatGPT" reads as a button: "Sign in with ChatGPT". Its own verb is kept. */
function signInLabel(name: string): string {
  return /^(sign|log)\s?in\b/i.test(name) ? name : `Sign in with ${name}`
}

function order(step: ConnectStep): number {
  return ["choose", "detect", "sign_in", "approve", "done"].indexOf(step)
}
