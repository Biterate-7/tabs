"use client"

import { useEffect, useRef, useState } from "react"
import { ArrowLeft, ArrowRight, CircleAlert, CircleCheck, CircleDot, LoaderCircle } from "lucide-react"
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
import { Select } from "@/components/ui/select"
import { Textarea } from "@/components/ui/textarea"
import { AgentIcon } from "@/components/agents/agent-icon"
import { RUNTIME_ERROR_PRESENTATION, runtimeErrorTitle } from "@/lib/agents/command-centre/presentation"
import { HANDOFF_LIMITS, focusLine, packSelectionLine, workspaceContextLine } from "@/lib/agents/handoff/handoff"
import { contextPackLine } from "@/lib/agents/context-pack/present"
import type { ContextPack } from "@/lib/agents/context-pack/pack"
import { agentDisplayName } from "@/lib/agents/visual/identity"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import { cn } from "@/lib/utils"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { HandoffInclude } from "@/lib/agents/handoff/handoff"
import type { RuntimeErrorCode, RuntimeHandoffPreview } from "@/lib/agents/runtime/protocol"
import type { HandoffStartResult, HandoffTransport } from "@/lib/agents/handoff/transport"

/**
 * "Continue with…" — handing one agent session's work to another agent,
 * explicitly, in the same workspace (Hubble 1.4).
 *
 *     Continue with…           Continue with Codex            Continue with Codex
 *     ● Codex                  Workspace  Development         ✓ Preparing handoff
 *     ○ Gemini  Not connected  ☑ Workspace context 8 tabs…    ◌ Starting Codex
 *              [Connect]       ☑ Previous result              ○ Sending context
 *                              Instruction [            ]
 *                              [Cancel]        [Continue]
 *
 * ## The person decides every step
 *
 * Which agent (from the connected-agent roster — an agent that is not
 * connected says so and goes through the existing Connect flow), which of
 * the three modes (workspace context, previous result, their instruction),
 * and when. Nothing here picks an agent, and nothing starts until Continue.
 *
 * ## The preview is the runtime's
 *
 * What is shown under "Context" and "Previous result" is what the runtime
 * computed from the source session's own records (`prepare_handoff`), and
 * confirming is refused if that changed since — so the person never sends
 * something they did not see. The transport is the host's: the Command
 * Centre passes the runtime's two commands, the landing page's demo a
 * deterministic stand-in built on the same pure functions. This component is
 * the same in both.
 *
 * ## Failure is said, not hidden
 *
 * The runtime reports a failed handoff as what it was — the session that
 * could not be started, or the handoff that never reached it — and this
 * says which, with "Try again". The source session is never touched.
 */

export type HandoffAgentOption = {
  provider: AgentProviderId
  name: string
  /** `ready`: a handoff can start now. `not_connected`: through Connect first. `unavailable`: `reason` says why. */
  state: "ready" | "not_connected" | "unavailable"
  reason?: string
}

export type { HandoffStartInput, HandoffStartResult, HandoffTransport } from "@/lib/agents/handoff/transport"

type Phase =
  | { kind: "choose" }
  | { kind: "preparing"; provider: AgentProviderId }
  | { kind: "preview"; preview: RuntimeHandoffPreview }
  | { kind: "starting"; preview: RuntimeHandoffPreview }
  | { kind: "failed"; provider: AgentProviderId; title: string; detail: string; retry: boolean }

/**
 * One sentence for a refusal, in the runtime's own words — with the
 * handoff-specific cases said plainly. Preparing reads the source session's
 * workspace context, so a context refusal there is "Couldn't load workspace
 * context"; a refusal once Continue was pressed is "Couldn't start handoff",
 * with what the runtime said beneath it. Never a code.
 */
function refusal(code: RuntimeErrorCode, starting: boolean): { title: string; detail: string } {
  if (code === "context_invalid" && starting) {
    return { title: "The work changed since this preview", detail: "Nothing was sent. Review what will be passed and continue again." }
  }
  if (code === "invalid_session_state") {
    return { title: "This session can't be handed on right now", detail: "Wait for the agent to finish, or answer what it is waiting on." }
  }
  const presentation = RUNTIME_ERROR_PRESENTATION[code]
  if (starting && !presentation.reconnect && code !== "runtime_unavailable") {
    return { title: "Couldn't start handoff", detail: `${presentation.title}. Nothing was sent.` }
  }
  return { title: presentation.title, detail: presentation.action }
}

function Step({ state, label }: { state: "done" | "active" | "pending" | "failed"; label: string }) {
  const common = "size-3.5 shrink-0"
  return (
    <li className="flex items-center gap-2 py-0.5">
      {state === "done" ? (
        <CircleCheck aria-hidden className={cn(common, "text-muted-foreground")} />
      ) : state === "active" ? (
        <LoaderCircle aria-hidden className={cn(common, "animate-spin text-muted-foreground [animation-duration:1.4s]")} />
      ) : state === "failed" ? (
        <CircleAlert aria-hidden className={cn(common, "text-destructive")} />
      ) : (
        <CircleDot aria-hidden className={cn(common, "text-tertiary")} />
      )}
      <span className={cn("text-body-sm", state === "pending" ? "text-tertiary" : "text-foreground")}>{label}</span>
      <span className="sr-only">
        {state === "done" ? "done" : state === "active" ? "in progress" : state === "failed" ? "failed" : "not started"}
      </span>
    </li>
  )
}

/** A mode the person can keep or leave out. The checkbox's label is the whole row. */
function Mode({
  checked,
  disabled,
  onToggle,
  label,
  detail,
  children,
}: {
  checked: boolean
  disabled?: boolean
  onToggle: () => void
  label: string
  detail?: string
  children?: React.ReactNode
}) {
  return (
    <div className="py-1">
      <label className={cn("flex items-center gap-2 rounded-md px-1 py-1", disabled ? "opacity-60" : "hover:bg-surface-hover has-focus-visible:bg-surface-hover")}>
        <Checkbox checked={checked} disabled={disabled} onCheckedChange={onToggle} />
        <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{label}</span>
        {/* Bounded, so a long Context Pack line truncates instead of squeezing the label to nothing. */}
        {detail && (
          <span className="max-w-[60%] shrink-0 truncate text-meta text-tertiary" title={detail}>
            {detail}
          </span>
        )}
      </label>
      {children && <div className="pl-7">{children}</div>}
    </div>
  )
}

export function HandoffDialog({
  open,
  onOpenChange,
  source,
  workspaceName,
  agents,
  onConnect,
  projectsFor,
  transport,
  onStarted,
  initialProvider,
  packFor,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The session whose work is handed on. */
  source: { provider: AgentProviderId; agentName: string; title?: string; statusLabel: string }
  workspaceName?: string
  /** The connected-agent roster, as the Command Centre reads it. */
  agents: readonly HandoffAgentOption[]
  /** The existing Connect flow, for an agent that is not connected. */
  onConnect: (provider: AgentProviderId) => void
  /** Projects the new session could use with this agent, and the one to start from. Absent: none offered. */
  projectsFor?: (provider: AgentProviderId) => { options: readonly { id: string; name: string }[]; defaultId?: string }
  transport: HandoffTransport
  /** The handoff reached its target. The dialog closes; the host shows the new session. */
  onStarted: (result: HandoffStartResult) => void
  /** Opens straight on this agent's preview — "Continue with Codex". */
  initialProvider?: AgentProviderId
  /**
   * The canonical Context Pack the handoff would pass with these modes
   * (Hubble 1.5) — built by the host from the same workspace and focus the
   * runtime builds it from, so the names shown are the ones sent.
   */
  /** The pack the target would receive — with the project it would work in (Hubble 1.6), described for it. */
  packFor?: (preview: RuntimeHandoffPreview, include: HandoffInclude, projectId?: string) => ContextPack | undefined
}) {
  const [phase, setPhase] = useState<Phase>({ kind: "choose" })
  const [include, setInclude] = useState<HandoffInclude>({ workspace: true, previousResult: true, answer: true })
  const [instruction, setInstruction] = useState("")
  const [projectId, setProjectId] = useState("")
  /** Answers that arrive after the person closed or moved on are dropped. */
  const generation = useRef(0)

  const prepare = async (provider: AgentProviderId) => {
    const ticket = ++generation.current
    setPhase({ kind: "preparing", provider })
    const result = await transport.prepare(provider)
    if (ticket !== generation.current) return
    if (!result.ok) {
      const words = refusal(result.error.code, false)
      setPhase({ kind: "failed", provider, ...words, retry: result.error.code !== "invalid_session_state" })
      return
    }
    const projects = projectsFor?.(provider)
    setProjectId(projects?.defaultId ?? "")
    setInclude({ workspace: Boolean(result.value.context.workspace), previousResult: Boolean(result.value.context.previousResult) })
    setPhase({ kind: "preview", preview: result.value })
  }

  const start = async (preview: RuntimeHandoffPreview) => {
    const ticket = ++generation.current
    setPhase({ kind: "starting", preview })
    const trimmed = instruction.trim()
    const result = await transport.start({
      preview,
      include,
      ...(trimmed ? { instruction: trimmed } : {}),
      ...(projectId ? { projectId } : {}),
    })
    if (ticket !== generation.current) return
    const target = agentDisplayName(preview.targetProvider)
    if (!result.ok) {
      setPhase({ kind: "failed", provider: preview.targetProvider, ...refusal(result.error.code, true), retry: true })
      return
    }
    const { handoff } = result.value
    if (handoff.status !== "ready") {
      const why = result.value.error ? `${runtimeErrorTitle(result.value.error.code, target, { starting: true })}. ` : ""
      setPhase({
        kind: "failed",
        provider: preview.targetProvider,
        title: handoff.failure === "context_not_delivered" ? `${target} didn't receive the handoff` : "Couldn't start handoff",
        detail:
          handoff.failure === "context_not_delivered"
            ? `The ${target} session started, but it wasn't told anything. ${source.agentName}'s session is as it was.`
            : `${why}${target}'s session couldn't be started. Nothing was changed, and ${source.agentName}'s session is as it was.`,
        retry: true,
      })
      return
    }
    onStarted(result.value)
  }

  // Opening on an agent goes straight to its preview, once per opening.
  const opened = useRef(false)
  useEffect(() => {
    if (!open) {
      opened.current = false
      generation.current += 1
      return
    }
    if (opened.current) return
    opened.current = true
    // An answer from the runtime is the external system this waits on.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (initialProvider) void prepare(initialProvider)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open, initialProvider])

  const targetName =
    phase.kind === "preview" || phase.kind === "starting"
      ? agentDisplayName(phase.preview.targetProvider)
      : phase.kind === "preparing" || phase.kind === "failed"
        ? agentDisplayName(phase.provider)
        : null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-lg" data-handoff-dialog data-handoff-phase={phase.kind}>
        <DialogHeader>
          <DialogTitle>{targetName ? `Continue with ${targetName}` : "Continue with…"}</DialogTitle>
          <DialogDescription>
            {source.agentName}
            {source.title ? ` · ${source.title}` : ""} · {source.statusLabel}
            {workspaceName ? ` · ${workspaceName}` : ""}
          </DialogDescription>
        </DialogHeader>

        {phase.kind === "choose" && (
          <section aria-label="Agents that can continue" className="flex flex-col">
            <ul className="-mx-1 flex flex-col">
              {agents.map((agent) => (
                <li key={agent.provider} className="flex items-center gap-2 px-1 py-1">
                  <AgentIcon connector={agent.provider} size="sm" />
                  <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{agent.name}</span>
                  {agent.state === "ready" ? (
                    <Button type="button" size="xs" variant="ghost" onClick={() => void prepare(agent.provider)} aria-label={`Continue with ${agent.name}`}>
                      Continue
                      <ArrowRight />
                    </Button>
                  ) : agent.state === "not_connected" ? (
                    <>
                      <span className="min-w-0 shrink truncate text-label text-tertiary">{agent.reason ?? "Not connected"}</span>
                      <Button type="button" size="xs" variant="outline" onClick={() => onConnect(agent.provider)} aria-label={`Connect ${agent.name}`}>
                        Connect
                      </Button>
                    </>
                  ) : (
                    <span className="min-w-0 shrink truncate text-label text-tertiary">{agent.reason ?? "Unavailable"}</span>
                  )}
                </li>
              ))}
            </ul>
            {agents.length === 0 && <p className="text-body-sm text-tertiary">No other agents are connected yet.</p>}
            <p className="mt-2 text-meta text-tertiary">
              A new session starts with the agent you choose. You&apos;ll see exactly what it receives before anything is sent.
            </p>
          </section>
        )}

        {phase.kind === "preparing" && (
          <div role="status" aria-live="polite">
            <ol aria-label="Handoff progress" className="flex flex-col">
              <Step state="active" label={`Reviewing what ${targetName ?? "the agent"} would receive`} />
            </ol>
          </div>
        )}

        {(phase.kind === "preview" || phase.kind === "starting") && (
          <HandoffPreview
            preview={phase.preview}
            source={source}
            workspaceName={workspaceName}
            include={include}
            onInclude={setInclude}
            instruction={instruction}
            onInstruction={setInstruction}
            projects={projectsFor?.(phase.preview.targetProvider)}
            projectId={projectId}
            onProject={setProjectId}
            disabled={phase.kind === "starting"}
            pack={packFor?.(phase.preview, include, projectId || undefined)}
          />
        )}

        {phase.kind === "starting" && (
          <div role="status" aria-live="polite" className="border-t border-subtle pt-2">
            <ol aria-label="Handoff progress" className="flex flex-col">
              <Step state="done" label="Context reviewed" />
              <Step state="active" label={`Starting a ${targetName ?? "new"} session with this context`} />
            </ol>
          </div>
        )}

        {phase.kind === "failed" && (
          <div role="alert" className="rounded-md border border-destructive/40 bg-surface px-3 py-2">
            <p className="text-body-sm text-foreground">{phase.title}</p>
            <p className="mt-0.5 text-meta text-tertiary">{phase.detail}</p>
          </div>
        )}

        <DialogFooter>
          {phase.kind === "choose" || phase.kind === "preparing" ? (
            <Button type="button" variant="ghost" onClick={() => onOpenChange(false)}>
              Cancel
            </Button>
          ) : phase.kind === "failed" ? (
            <>
              <Button type="button" variant="ghost" onClick={() => setPhase({ kind: "choose" })}>
                Choose another agent
              </Button>
              {phase.retry && (
                <Button type="button" onClick={() => void prepare(phase.provider)}>
                  Try again
                </Button>
              )}
            </>
          ) : (
            <>
              {/* Back to the agents, keeping the instruction typed so far. */}
              <Button type="button" variant="ghost" className="sm:mr-auto" disabled={phase.kind === "starting"} onClick={() => setPhase({ kind: "choose" })}>
                <ArrowLeft />
                Back
              </Button>
              <Button type="button" variant="ghost" disabled={phase.kind === "starting"} onClick={() => onOpenChange(false)}>
                Cancel
              </Button>
              <Button type="button" disabled={phase.kind === "starting"} onClick={() => void start(phase.preview)}>
                {phase.kind === "starting" ? "Continuing…" : "Continue"}
              </Button>
            </>
          )}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

/** Exactly what would be passed, from the runtime's preview, with a box for each mode. */
function HandoffPreview({
  preview,
  source,
  workspaceName,
  include,
  onInclude,
  instruction,
  onInstruction,
  projects,
  projectId,
  onProject,
  disabled,
  pack,
}: {
  pack?: ContextPack | undefined
  preview: RuntimeHandoffPreview
  source: { provider: AgentProviderId; agentName: string; statusLabel: string }
  workspaceName?: string
  include: HandoffInclude
  onInclude: (include: HandoffInclude) => void
  instruction: string
  onInstruction: (value: string) => void
  projects?: { options: readonly { id: string; name: string }[] }
  projectId: string
  onProject: (id: string) => void
  disabled: boolean
}) {
  const target = agentDisplayName(preview.targetProvider)
  const workspace = preview.context.workspace
  const result = preview.context.previousResult
  const focus = pack ? packSelectionLine(pack) : workspace ? focusLine(workspace) : undefined
  const files = result?.files?.length ?? 0
  return (
    <div className="flex min-w-0 flex-col gap-2" data-handoff-preview>
      {/* Where you are, what is handed on, and who receives it — before anything else. */}
      <dl className="grid grid-cols-[5.5rem_minmax(0,1fr)] items-center gap-x-2 gap-y-1">
        <dt className="text-eyebrow text-tertiary">From</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-body-sm text-foreground">
          <AgentIcon connector={source.provider} size="xs" />
          <span className="truncate">{source.agentName}</span>
          <span className="shrink-0 text-meta text-tertiary">· {source.statusLabel}</span>
        </dd>
        <dt className="text-eyebrow text-tertiary">To</dt>
        <dd className="flex min-w-0 items-center gap-1.5 text-body-sm text-foreground">
          <AgentIcon connector={preview.targetProvider} size="xs" />
          <span className="truncate">{target}</span>
          <span className="shrink-0 text-meta text-tertiary">· New session</span>
        </dd>
        <dt className="text-eyebrow text-tertiary">Workspace</dt>
        <dd className="min-w-0 truncate text-body-sm text-foreground">{workspaceName ?? "This workspace"}</dd>
      </dl>

      <fieldset disabled={disabled}>
        <legend className="text-eyebrow text-tertiary">Context</legend>
        <Mode
          checked={include.workspace && Boolean(workspace)}
          disabled={!workspace || disabled}
          onToggle={() => onInclude({ ...include, workspace: !include.workspace })}
          label="Workspace context"
          {...(workspace ? { detail: pack && include.workspace ? contextPackLine(pack) : workspaceContextLine(workspace) } : { detail: "Not available" })}
        >
          {pack && include.workspace && (pack.workspace.description || pack.workspace.focus) && (
            <p className="line-clamp-2 break-words text-meta text-muted-foreground" data-handoff-brief>
              {[pack.workspace.description, pack.workspace.focus ? `Focus · ${pack.workspace.focus}` : undefined].filter(Boolean).join(" · ")}
            </p>
          )}
          {focus && include.workspace && <p className="truncate text-meta text-tertiary">Selected · {focus}</p>}
          {workspace && !preview.contextTools && (
            <p className="text-meta text-warning">
              {pack
                ? `${target} can't be given Hubble's workspace tools, so it only knows what's listed here.`
                : `${target} can't be given Hubble's workspace tools, so it will be told the workspace isn't available.`}
            </p>
          )}
        </Mode>
        <Mode
          checked={include.previousResult && Boolean(result)}
          disabled={!result || disabled}
          onToggle={() => onInclude({ ...include, previousResult: !include.previousResult })}
          label="Previous result"
          {...(result
            ? {
                detail:
                  result.lines.length === 0
                    ? "No changes recorded"
                    : `${result.lines.length + result.more} ${result.lines.length + result.more === 1 ? "result" : "results"}${files > 0 ? ` · ${files} ${files === 1 ? "file" : "files"}` : ""}`,
              }
            : {})}
        >
          {result?.answer && include.previousResult && (
            <div className="mt-1 rounded-md border border-subtle p-2" data-handoff-answer>
              <label className="flex items-center gap-2">
                <Checkbox checked={include.answer === true} disabled={disabled} onCheckedChange={() => onInclude({ ...include, answer: !include.answer })} />
                <span className="text-body-sm text-foreground">Include {source.agentName}&apos;s answer</span>
              </label>
              <p className="mt-1 line-clamp-4 text-meta whitespace-pre-wrap text-muted-foreground">{result.answer}</p>
            </div>
          )}
          {result && include.previousResult && result.lines.length > 0 && (
            <ul className="flex flex-col">
              {result.lines.slice(0, 4).map((line, index) => (
                <li key={index} className="truncate text-meta text-muted-foreground" title={line.description ?? line.title}>
                  {line.title}
                  {line.description ? <span className="text-tertiary"> · {line.description}</span> : null}
                </li>
              ))}
              {result.lines.length + result.more > 4 && (
                <li className="text-meta text-tertiary">and {result.lines.length + result.more - 4} more</li>
              )}
            </ul>
          )}
        </Mode>
      </fieldset>

      <div className="flex flex-col gap-1">
        <label htmlFor="handoff-instruction" className="text-eyebrow text-tertiary">
          Instruction
        </label>
        <Textarea
          id="handoff-instruction"
          rows={3}
          maxLength={HANDOFF_LIMITS.instruction}
          value={instruction}
          disabled={disabled}
          placeholder={`What should ${target} do next?`}
          onChange={(event) => onInstruction(event.target.value)}
          className="max-h-40 resize-none text-body-sm"
        />
      </div>

      {projects && projects.options.length > 0 && (
        <div className="flex flex-col gap-1">
          <span className="text-eyebrow text-tertiary">Project</span>
          <Select
            value={projectId}
            onValueChange={onProject}
            placeholder="No project"
            options={[
              { value: "", label: "No project — reads the workspace, can't change it" },
              ...projects.options.map((project) => ({ value: project.id, label: project.name })),
            ]}
          />
        </div>
      )}

      <p className="text-meta text-tertiary">
        {target} gets these in a new session — never {preview.sourceProvider === preview.targetProvider ? "the earlier session" : agentDisplayName(preview.sourceProvider)}&apos;s
        conversation. Changes it wants to make still ask you first.
      </p>
    </div>
  )
}

/**
 * Every agent a handoff could go to, from the connected-agent roster — the
 * same platform answers New session uses, so the two never disagree about
 * whether an agent can start. One that is not connected (or must sign in
 * again) is offered Connect, through the existing flow; one Hubble does not
 * start sessions with says why. The Command Centre passes its platform hook;
 * the landing page's demo passes its own implementation of the same hook.
 */
export function handoffAgentOptions(
  platform: Pick<UseAgentPlatform, "identity" | "sessionsFor" | "prerequisiteFor">,
  canStart: (provider: AgentProviderId) => boolean
): HandoffAgentOption[] {
  return PLATFORM_PROVIDERS.filter((spec) => spec.chat).map((spec): HandoffAgentOption => {
    const base = { provider: spec.provider, name: agentDisplayName(spec.provider) }
    if (!platform.identity(spec.provider)) return { ...base, state: "not_connected", reason: "Not connected" }
    const sessions = platform.sessionsFor(spec.provider)
    if (!sessions.available) return { ...base, state: "unavailable", reason: "Sessions unavailable" }
    const prerequisite = platform.prerequisiteFor(spec.provider)
    if (!prerequisite.ok) return { ...base, state: "not_connected", reason: prerequisite.reason }
    if (!canStart(spec.provider)) return { ...base, state: "unavailable", reason: "Unavailable here" }
    return { ...base, state: "ready" }
  })
}
