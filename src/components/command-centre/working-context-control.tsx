"use client"

import { ArrowRight, Check, FileText, Layers, Minus, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover"
import { ContextPackInspector } from "@/components/agents/context-pack-inspector"
import { READ_CAPABILITIES, SESSION_CONTEXT_ACCESS_LABELS } from "@/lib/agents/session-context/capabilities"
import {
  CONTEXT_SCOPE_LABEL,
  WORKSPACE_LINK_DETAIL,
  changeAccessLabel,
  summarizeWorkingContext,
} from "@/lib/agents/command-centre/working-context"
import { cn } from "@/lib/utils"
import type { WorkingContextView, WorkspaceLink } from "@/lib/agents/command-centre/working-context"
import type { RuntimeSessionContextView } from "@/lib/agents/runtime/protocol"
import type { ContextFreshness } from "@/hooks/use-session-context"
import type { ContextPack } from "@/lib/agents/context-pack/pack"
import type { ContextDeliveryState, ContextPackRowKey } from "@/lib/agents/context-pack/present"

/**
 * The Context Pack's facts beside a selection (Hubble 1.5): what else the
 * agent receives — files, recent changes, a previous result, the person's
 * words — and whether it has it. The selection itself is listed above it, so
 * those rows are not repeated.
 */
export type SessionPackProps = {
  pack?: ContextPack | null
  packState?: ContextDeliveryState
  onSendUpdate?: () => void
}

const SELECTION_ROWS: readonly ContextPackRowKey[] = ["scope", "collections", "tabs"]

export function SessionPackFacts({
  pack,
  packState,
  onSendUpdate,
  agentName,
  busy,
  withWorkspace,
  withSelection = false,
}: SessionPackProps & {
  agentName: string
  busy?: boolean
  /** Show the workspace and its brief — when nothing beside this does. */
  withWorkspace: boolean
  /** Show the selection too — when no selection list sits above this. */
  withSelection?: boolean
}) {
  if (!pack) return null
  const hide: ContextPackRowKey[] = [...(withWorkspace ? [] : (["workspace", "focus"] as const)), ...(withSelection ? [] : SELECTION_ROWS)]
  return (
    <section aria-label="What the agent receives" className={cn(!withSelection && "border-t border-subtle pt-2")}>
      <ContextPackInspector
        pack={pack}
        agentName={agentName}
        {...(packState ? { state: packState } : {})}
        {...(onSendUpdate ? { onSendUpdate } : {})}
        busy={busy ?? false}
        hide={hide}
      />
    </section>
  )
}

/**
 * The workspace ↔ agent relationship, said where the user works with an agent.
 *
 * Two small controls, each answering one question, and nothing heavier:
 *
 *   - **Working in** — which workspace this agent works in, what it can read
 *     there, and whether it can change anything. Fixed for the session's life
 *     and said so.
 *   - **Context** — what, inside that workspace, the agent is pointed at:
 *     the whole workspace, or the tabs and collections chosen. Opens to show
 *     them by name, and to change them.
 *
 * Every name comes from live Hubble state (see `describeWorkingContext`);
 * nothing here names MCP, a server, a version protocol or a token.
 */

const CHIP =
  "flex h-6 min-w-0 items-center gap-1 rounded-full bg-surface-hover px-2 text-body-sm text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-color) outline-none hover:bg-surface-active hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/60 disabled:pointer-events-none disabled:opacity-55"

/* ------------------------------------------------------------------ *
 * Context — what the agent is pointed at
 * ------------------------------------------------------------------ */

export type WorkingContextActions = {
  onRemove?: (entry: { tabId: string } | { collectionId: string }) => void
  /** Back to the whole workspace: nothing extra attached. */
  onUseWholeWorkspace?: () => void
  /** Opens the chooser for this workspace. */
  onChoose?: () => void
}

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <p className="text-eyebrow text-tertiary">{children}</p>
}

/**
 * The context, listed. Used inside the chip's popover and in the side panel,
 * so what the two say can never disagree.
 */
export function WorkingContextDetails({
  view,
  link,
  agentName,
  delivered,
  busy = false,
  onRemove,
  onUseWholeWorkspace,
  onChoose,
}: {
  view: WorkingContextView
  link: WorkspaceLink
  agentName: string
  /** `false` — sent with the next message; `true` — the agent has it; absent — not attached yet (a new session). */
  delivered?: boolean
  busy?: boolean
} & WorkingContextActions) {
  const workspaceName = view.workspace?.name ?? "this workspace"
  const whole = view.scope === "workspace"
  const editable = Boolean(onChoose) && view.workspace !== null

  return (
    <div className="flex flex-col gap-2.5">
      <div className="flex items-center justify-between gap-2">
        <div className="min-w-0">
          <Eyebrow>Context</Eyebrow>
          <p className="truncate text-body-sm text-foreground">{CONTEXT_SCOPE_LABEL[view.scope]}</p>
        </div>
        {!whole && onUseWholeWorkspace && (
          <Button type="button" size="xs" variant="ghost" disabled={busy} onClick={onUseWholeWorkspace}>
            Use whole workspace
          </Button>
        )}
      </div>

      {whole ? (
        <p className="text-body-sm text-muted-foreground">
          {link.kind === "live"
            ? `${agentName} reads ${workspaceName} when it needs to.`
            : `${agentName} only knows what Hubble sends it. Choose tabs or collections to add more.`}
        </p>
      ) : (
        <>
          {view.collections.length > 0 && (
            <section aria-label="Collections in context">
              <Eyebrow>Collections</Eyebrow>
              <ul className="mt-0.5">
                {view.collections.map((collection) => (
                  <ContextRow
                    key={collection.id}
                    icon={<Layers className="size-3.5" aria-hidden />}
                    label={collection.name}
                    detail={`${collection.tabCount} ${collection.tabCount === 1 ? "tab" : "tabs"}`}
                    {...(onRemove && editable
                      ? { onRemove: () => onRemove({ collectionId: collection.id }), removeLabel: `Remove ${collection.name} from context` }
                      : {})}
                    busy={busy}
                  />
                ))}
              </ul>
            </section>
          )}
          {view.tabs.length > 0 && (
            <section aria-label="Tabs in context">
              <Eyebrow>Tabs</Eyebrow>
              <ul className="mt-0.5 max-h-48 overflow-y-auto">
                {view.tabs.map((tab) => (
                  <ContextRow
                    key={tab.id}
                    icon={<FileText className="size-3.5" aria-hidden />}
                    label={tab.title}
                    detail={tab.domain}
                    {...(onRemove && editable
                      ? { onRemove: () => onRemove({ tabId: tab.id }), removeLabel: `Remove ${tab.title} from context` }
                      : {})}
                    busy={busy}
                  />
                ))}
              </ul>
            </section>
          )}
          {view.relationships.length > 0 && (
            <section aria-label="Relationships in context">
              <Eyebrow>Relationships</Eyebrow>
              <ul className="mt-0.5">
                {view.relationships.map((relationship) => (
                  <li key={relationship.id} className="flex min-w-0 items-center gap-1 py-0.5 text-body-sm text-muted-foreground">
                    <span className="min-w-0 truncate">{relationship.from}</span>
                    <ArrowRight className="size-3 shrink-0 text-tertiary" aria-label="depends on" />
                    <span className="min-w-0 truncate">{relationship.to}</span>
                  </li>
                ))}
              </ul>
            </section>
          )}
        </>
      )}

      {view.missing > 0 && (
        <p className="text-meta text-tertiary">
          {view.missing} {view.missing === 1 ? "item is" : "items are"} no longer in {workspaceName}.
        </p>
      )}

      {(editable || delivered !== undefined) && (
        <div className="flex items-center justify-between gap-2 border-t border-subtle pt-2">
          {editable ? (
            <Button type="button" size="xs" variant="secondary" disabled={busy} onClick={onChoose}>
              Choose tabs and collections…
            </Button>
          ) : (
            <span />
          )}
          {!whole && delivered !== undefined && (
            <span className="shrink-0 text-meta text-tertiary">
              {delivered ? `${agentName} has this` : "Sent with your next message"}
            </span>
          )}
        </div>
      )}
    </div>
  )
}

function ContextRow({
  icon,
  label,
  detail,
  onRemove,
  removeLabel,
  busy,
}: {
  icon: React.ReactNode
  label: string
  detail?: string
  onRemove?: () => void
  removeLabel?: string
  busy: boolean
}) {
  return (
    <li className="group flex min-w-0 items-center gap-1.5 py-0.5">
      <span className="shrink-0 text-tertiary">{icon}</span>
      <span className="min-w-0 flex-1 truncate text-body-sm text-foreground">{label}</span>
      {detail && <span className="max-w-[40%] shrink-0 truncate text-meta text-tertiary">{detail}</span>}
      {onRemove && (
        <IconButton aria-label={removeLabel ?? `Remove ${label}`} className="size-5 shrink-0" disabled={busy} onClick={onRemove}>
          <X />
        </IconButton>
      )}
    </li>
  )
}

/**
 * "Context · Physics collection · 3 tabs" — the chip, and the popover it
 * opens. Controlled, so the header and the composer can share one popover
 * state and never show two at once.
 */
export function WorkingContextChip({
  view,
  link,
  agentName,
  delivered,
  busy,
  open,
  onOpenChange,
  align = "end",
  className,
  pack,
  packState,
  onSendUpdate,
  ...actions
}: {
  view: WorkingContextView | null
  link: WorkspaceLink
  agentName: string
  delivered?: boolean
  busy?: boolean
  open?: boolean
  onOpenChange?: (open: boolean) => void
  align?: "start" | "center" | "end"
  className?: string
} & WorkingContextActions & SessionPackProps) {
  if (!view) {
    return (
      <Popover>
        <PopoverTrigger aria-label="No Hubble context for this session" className={cn(CHIP, "text-tertiary", className)}>
          <span>Context</span>
          <Minus className="size-3 shrink-0" aria-hidden />
        </PopoverTrigger>
        <PopoverContent align={align} className="w-72">
          <p className="text-body-sm text-foreground">No Hubble context</p>
          <p className="mt-1 text-body-sm text-muted-foreground">{WORKSPACE_LINK_DETAIL[link.kind]}</p>
        </PopoverContent>
      </Popover>
    )
  }

  const summary = summarizeWorkingContext(view)
  return (
    <Popover {...(open !== undefined ? { open } : {})} {...(onOpenChange ? { onOpenChange } : {})}>
      <PopoverTrigger
        aria-label={`Context: ${summary}${delivered === false ? ", sent with your next message" : ""}`}
        className={cn(CHIP, className)}
      >
        <span className="shrink-0 text-tertiary">Context</span>
        <span className="min-w-0 truncate text-foreground">{summary}</span>
        {delivered === false && <span aria-hidden className="size-1.5 shrink-0 rounded-full bg-link" />}
      </PopoverTrigger>
      <PopoverContent align={align} className="max-h-[min(32rem,var(--available-height,80vh))] w-[min(20rem,calc(100vw-2rem))] overflow-y-auto">
        <div className="flex flex-col gap-2.5">
          <WorkingContextDetails
            view={view}
            link={link}
            agentName={agentName}
            {...(delivered !== undefined && !packState ? { delivered } : {})}
            busy={busy ?? false}
            {...actions}
          />
          <SessionPackFacts
            pack={pack ?? null}
            {...(packState ? { packState } : {})}
            {...(onSendUpdate ? { onSendUpdate } : {})}
            agentName={agentName}
            busy={busy ?? false}
            withWorkspace
          />
        </div>
      </PopoverContent>
    </Popover>
  )
}

/* ------------------------------------------------------------------ *
 * Working in — which workspace, and what the agent can do there
 * ------------------------------------------------------------------ */

/**
 * "Working in Research ✓" — the workspace a session is bound to, and what
 * that means. The name is the workspace's live name; the popover says what
 * the agent can read and change there, that it sees nothing else, and that
 * switching workspaces in Hubble does not move it.
 */
export function WorkingInIndicator({
  workspaceName,
  link,
  context,
  freshness = "fresh",
  origin,
  className,
}: {
  workspaceName: string | undefined
  link: WorkspaceLink
  context?: RuntimeSessionContextView
  freshness?: ContextFreshness
  /** How the session came to be — "Controlled session", "Observed externally". */
  origin?: string
  className?: string
}) {
  const stale = link.kind === "live" && freshness === "update_available"
  const change = changeAccessLabel(link)
  const reads = context ? READ_CAPABILITIES.filter((capability) => context.capabilities.includes(capability)) : []
  const name = link.kind === "workspace-missing" ? "a deleted workspace" : link.kind === "none" ? undefined : workspaceName

  return (
    <Popover>
      <PopoverTrigger
        aria-label={
          name ? `Working in ${name}${stale ? ", update available" : ""}` : "Not working in a workspace"
        }
        className={cn(
          "flex min-w-0 items-center gap-1 rounded-xs text-meta text-tertiary outline-none hover:text-muted-foreground focus-visible:ring-2 focus-visible:ring-ring/60",
          className
        )}
      >
        {name ? (
          <>
            <span className="shrink-0">Working in</span>
            <span className="min-w-0 truncate text-muted-foreground">{name}</span>
            {stale ? (
              <span className="shrink-0 text-link">· Update available</span>
            ) : link.kind === "live" ? (
              <Check className="size-3 shrink-0" aria-hidden />
            ) : null}
          </>
        ) : (
          <span className="truncate">No workspace</span>
        )}
      </PopoverTrigger>
      <PopoverContent align="start" className="w-72">
        <div className="flex flex-col gap-2.5">
          <div>
            <Eyebrow>Working in</Eyebrow>
            <p className="truncate text-body-sm text-foreground">{name ?? "No workspace"}</p>
            {context && link.kind === "live" && (
              <p className="text-label text-tertiary">
                Version {context.version} · {stale ? "Update available" : "Current"}
              </p>
            )}
          </div>
          <p className="text-body-sm text-muted-foreground">{WORKSPACE_LINK_DETAIL[link.kind]}</p>
          {reads.length > 0 && (
            <div>
              <Eyebrow>Can read</Eyebrow>
              <p aria-label="What the agent can read" className="text-body-sm text-foreground">
                {reads.map((capability) => SESSION_CONTEXT_ACCESS_LABELS[capability]).join(" · ")}
              </p>
            </div>
          )}
          <div>
            <Eyebrow>Can change</Eyebrow>
            <p className="flex items-center gap-1.5 text-body-sm text-muted-foreground">
              {change.allowed ? (
                <Check className="size-3.5 shrink-0 text-success" aria-hidden />
              ) : (
                <Minus className="size-3.5 shrink-0" aria-hidden />
              )}
              {change.text}
            </p>
          </div>
          {name && link.kind !== "workspace-missing" && (
            <p className="text-meta text-tertiary">
              Fixed for this session. Switching workspaces in Hubble doesn&apos;t move it — start a new session there.
            </p>
          )}
          {origin && <p className="text-meta text-tertiary">{origin}</p>}
        </div>
      </PopoverContent>
    </Popover>
  )
}
