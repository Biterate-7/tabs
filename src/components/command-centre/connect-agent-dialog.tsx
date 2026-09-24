"use client"

import { useState } from "react"
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
import { PLATFORM_PROVIDERS, platformProvider } from "@/lib/agents/platform/catalog"
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
 *     shown for the user to run. TabDump never runs it.
 *   - **Sign in** — the agent's *own* sign-in. For an ACP agent, the methods
 *     it advertised, started through `authenticate_provider` with a method id
 *     and nothing else; the agent opens its provider's page itself. For Claude,
 *     the user's own key in Settings. For an MCP client, a token issued in
 *     Settings. No credential is ever typed into this dialog.
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
  /** Settings → AI connectors, where provider keys and MCP tokens live. */
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
  const derived: ConnectStep = !chosen || !phase ? "choose" : stepFor(phase)
  const step = ((): ConnectStep => {
    if (advanced && order(advanced) > order(derived) && derived !== "detect") return advanced
    // An agent that only reveals its sign-in state when a session starts is
    // "reached" rather than "signed in" — so the sign-in methods stay on
    // screen until the user says they are done with them.
    if (
      derived === "approve" &&
      signIn === "native" &&
      !advanced &&
      connection?.authentication === "unknown"
    ) {
      return "sign_in"
    }
    return derived
  })()

  function reset(next: AgentProviderId | null) {
    setChosen(next)
    setAdvanced(null)
    setScopes(null)
    setCopied(false)
  }

  const busy = chosen !== null && platform.pending === chosen
  const error = chosen ? platform.errors[chosen] : undefined
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
              : "Bring an AI agent into TabDump. It works in projects you authorize, with the workspace context you choose, and asks before it changes anything."}
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
                    <span className="shrink-0 text-label text-tertiary">{CONNECTION_PHASE_LABEL[entryPhase]}</span>
                  </button>
                </li>
              )
            })}
          </ul>
        )}

        {spec && step === "detect" && (
          <section aria-label="Detect" className="flex flex-col gap-2">
            <p className="text-body-sm text-foreground">{CONNECTION_PHASE_LABEL[phase!]}</p>
            <p className="text-body-sm text-muted-foreground">
              {phase === "runtime_unavailable"
                ? spec.transport === "acp"
                  ? `${spec.displayName} runs on your own machine. Open TabDump from a local runtime to connect it.`
                  : "Agents cannot run in this TabDump."
                : phase === "not_installed"
                  ? `${spec.displayName} is not installed on this machine.`
                  : phase === "needs_adapter"
                    ? `${spec.displayName} is installed, but the program TabDump drives it through is not.`
                    : phase === "error"
                      ? "TabDump could not reach this agent."
                      : "TabDump has not checked this machine yet."}
            </p>
            {spec.installCommand && (phase === "not_installed" || phase === "needs_adapter") && (
              <div className="flex items-center gap-2 rounded-md border border-subtle bg-surface px-2.5 py-1.5">
                {/* Shown to copy. TabDump does not install software. */}
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
                {detection.signIn === "signed_in" ? " · signed in" : ""}
              </p>
            )}
            <p className="text-body-sm text-muted-foreground">
              {signIn === "native" && spec.signIn.kind !== "native"
                ? (spec.nativeSignInSummary ?? spec.signIn.summary)
                : spec.signIn.summary}
            </p>

            {signIn === "native" && (
              <>
                {!connection ? (
                  <Button type="button" size="sm" className="self-start" disabled={busy} onClick={() => void platform.connect(spec.provider)}>
                    {busy ? "Reaching the agent…" : `Reach ${spec.displayName}`}
                  </Button>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    <p className="text-body-sm text-foreground">
                      {connection.authentication === "authenticated"
                        ? "Signed in."
                        : connection.authentication === "required"
                          ? "Sign-in required."
                          : "Reached. If you have not signed in on this machine yet, sign in now."}
                    </p>
                    {connection.authMethods.length > 0 && connection.authentication !== "authenticated" && (
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
                            {method.name}
                          </Button>
                        ))}
                      </div>
                    )}
                    <p className="text-meta text-tertiary">
                      Sign-in happens in {spec.displayName}&apos;s own window or browser page. TabDump never sees
                      your password or token.
                    </p>
                  </div>
                )}
              </>
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
                        {(scope === "write_project" || scope === "run_commands") && (
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
                  "Run a shell command through TabDump",
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
          <section aria-label="Connected" className="flex items-center gap-2.5">
            <AgentIcon connector={spec.provider} size="md" />
            <p className="text-body-sm text-foreground">
              {spec.displayName} is connected.{" "}
              <span className="text-muted-foreground">
                {spec.chat
                  ? "Start a session to work with it."
                  : "Point it at TabDump's MCP server with the token from Settings."}
              </span>
            </p>
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

          {spec && step === "detect" && (
            <Button type="button" variant="outline" onClick={() => void platform.detect()}>
              <RotateCw />
              Check again
            </Button>
          )}

          {spec && step === "sign_in" && (
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

          {spec && step === "done" && spec.chat && onStartSession && (
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
      return connection !== undefined && connection.connection === "connected" && connection.authentication !== "required"
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

function order(step: ConnectStep): number {
  return ["choose", "detect", "sign_in", "approve", "done"].indexOf(step)
}
