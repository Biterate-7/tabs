"use client"

import type { CSSProperties, ReactNode } from "react"
import { AGENT_STATUS_VISUALS, WORK_ITEM_STATUS_VISUALS } from "@/components/graph/agent-node-renderer"
import type { AgentRunArtifactRole, AgentRunStatus, AgentWorkItemStatus } from "@/lib/agents/types"
import { cn } from "@/lib/utils"

/**
 * The agent layer's visual vocabulary, for the landing page.
 *
 * Status glyphs and labels are imported from the app's own renderer rather
 * than re-spelled here, so "Waiting" on this page is the same word, the same
 * mark and the same meaning it has inside the product. Only the *colour*
 * mapping is local: the canvas resolves tones against a live theme palette,
 * and this page is pinned to the marketing palette.
 *
 * Every status below is carried by a glyph and a word as well as a colour —
 * the accessibility rule the renderer established, kept rather than dropped
 * the moment the same information moved onto a marketing page.
 */

/* -------------------------------------------------------------------------
 * Tone
 * ---------------------------------------------------------------------- */

/** Marketing-palette colour per renderer tone. */
const TONE_COLOR: Record<"live" | "idle" | "good" | "bad" | "muted", string> = {
  live: "var(--m-agent-live)",
  idle: "var(--m-agent-idle)",
  good: "var(--m-agent-good)",
  bad: "var(--m-agent-bad)",
  muted: "var(--text-tertiary)",
}

export function runStatusColor(status: AgentRunStatus): string {
  return TONE_COLOR[AGENT_STATUS_VISUALS[status].tone]
}

const WORK_ITEM_TONE: Record<AgentWorkItemStatus, keyof typeof TONE_COLOR> = {
  pending: "muted",
  active: "live",
  blocked: "bad",
  completed: "good",
  cancelled: "muted",
}

export function workItemColor(status: AgentWorkItemStatus): string {
  return TONE_COLOR[WORK_ITEM_TONE[status]]
}

/* -------------------------------------------------------------------------
 * Status
 * ---------------------------------------------------------------------- */

/**
 * A run's status, as a dot and a word.
 *
 * The dot only animates for a status the renderer marks `animated` — i.e. for
 * `working` and nothing else. A pulsing dot on a run that has stopped is the
 * single most misleading thing this page could draw, so the decision is read
 * from the same table the canvas reads it from rather than chosen here.
 */
export function RunStatusPill({
  status,
  size = "md",
  className,
}: {
  status: AgentRunStatus
  size?: "sm" | "md"
  className?: string
}) {
  const visual = AGENT_STATUS_VISUALS[status]
  const color = runStatusColor(status)

  return (
    <span
      className={cn(
        "inline-flex shrink-0 items-center gap-1.5 rounded-full border border-subtle bg-white/[0.03] font-medium whitespace-nowrap",
        size === "sm" ? "px-1.5 py-0.5 text-[0.6875rem]" : "px-2 py-1 text-[0.75rem]",
        className
      )}
      style={{ color }}
    >
      <span className="relative flex size-1.5 shrink-0" aria-hidden>
        {visual.animated && (
          // Ring, not a scaling dot: the dot itself stays put, so a row of
          // statuses never reflows while one of them is live.
          <span
            className="m-status-ring absolute inset-0 rounded-full"
            style={{ backgroundColor: color }}
          />
        )}
        <span className="relative size-1.5 rounded-full" style={{ backgroundColor: color }} />
      </span>
      {visual.label}
    </span>
  )
}

/** A work item's status glyph. Paired with the item's title, which carries the word. */
export function WorkItemGlyph({ status }: { status: AgentWorkItemStatus }) {
  return (
    <span
      aria-hidden
      className="m-num inline-flex w-3.5 shrink-0 justify-center text-[0.75rem] leading-5"
      style={{ color: workItemColor(status) }}
    >
      {WORK_ITEM_STATUS_VISUALS[status].glyph}
    </span>
  )
}

/* -------------------------------------------------------------------------
 * Work items
 * ---------------------------------------------------------------------- */

/**
 * One work item row.
 *
 * `dimmed` pushes a row back rather than removing it — the same treatment
 * DemoTabRow uses for a tab filtered out by a search, and for the same reason:
 * a demo that deletes what it is not currently talking about destroys the
 * reader's sense of how much is there.
 */
export function WorkItemRow({
  title,
  status,
  summary,
  dimmed = false,
  highlighted = false,
  onSelect,
  selected = false,
  wrap = false,
  className,
  style,
}: {
  title: string
  status: AgentWorkItemStatus
  summary?: string
  dimmed?: boolean
  highlighted?: boolean
  onSelect?: () => void
  selected?: boolean
  /** Let a long title run to a second line instead of truncating. For narrow rails, where every row would otherwise end in an ellipsis. */
  wrap?: boolean
  className?: string
  style?: CSSProperties
}) {
  const body = (
    <>
      <WorkItemGlyph status={status} />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            "block text-body-sm",
            wrap ? "line-clamp-2" : "truncate",
            status === "completed" ? "text-muted-foreground" : "text-foreground"
          )}
        >
          {title}
        </span>
        {summary && <span className="mt-0.5 block truncate text-meta text-tertiary">{summary}</span>}
      </span>
      <span className="sr-only">{WORK_ITEM_STATUS_VISUALS[status].label}</span>
    </>
  )

  const shared = cn(
    "flex w-full items-start gap-2 rounded-lg border px-2.5 py-2 text-left",
    "transition-[opacity,border-color,background-color] duration-(--duration-base) ease-(--ease-standard)",
    highlighted || selected
      ? "border-[color-mix(in_oklch,var(--primary),transparent_45%)] bg-accent-subtle"
      : "border-subtle bg-card/70",
    dimmed && "opacity-30",
    className
  )

  if (!onSelect) {
    return (
      <div className={shared} style={style}>
        {body}
      </div>
    )
  }

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={selected}
      className={cn(shared, "hover:border-strong/60 focus-visible:ring-3 focus-visible:ring-ring/50 focus-visible:outline-none")}
      style={style}
    >
      {body}
    </button>
  )
}

/* -------------------------------------------------------------------------
 * Progress
 * ---------------------------------------------------------------------- */

/**
 * A progress bar, or nothing.
 *
 * `progress` is optional on purpose and this renders `null` when it is absent,
 * mirroring the domain rule exactly: TabDump reports progress only where a
 * provider actually counted something, and never derives a ratio from event
 * volume or elapsed time. A landing page that drew an empty bar in that case
 * would be advertising a measurement the product refuses to invent.
 */
export function WorkProgress({
  progress,
  className,
}: {
  progress?: { completed: number; total: number }
  className?: string
}) {
  if (!progress) return null
  const fraction = progress.completed / progress.total

  return (
    <div className={cn("flex items-center gap-2.5", className)}>
      <div
        className="h-1 min-w-0 flex-1 overflow-hidden rounded-full bg-white/[0.08]"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={progress.total}
        aria-valuenow={progress.completed}
        aria-label="Work items complete"
      >
        <div
          className="h-full rounded-full transition-[width] duration-700 ease-(--m-ease)"
          style={{
            width: `${fraction * 100}%`,
            backgroundColor: fraction >= 1 ? TONE_COLOR.good : TONE_COLOR.live,
          }}
        />
      </div>
      <span className="m-num shrink-0 text-[0.75rem] text-tertiary">
        {progress.completed}/{progress.total}
      </span>
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Artifacts
 * ---------------------------------------------------------------------- */

/** Per-role wording. The domain's four roles, spelled the way the product spells them. */
const ROLE_LABEL: Record<AgentRunArtifactRole, string> = {
  created: "created",
  edited: "edited",
  inspected: "inspected",
  deleted: "deleted",
}

const ROLE_TONE: Record<AgentRunArtifactRole, keyof typeof TONE_COLOR> = {
  created: "good",
  edited: "live",
  inspected: "muted",
  deleted: "bad",
}

/** A single `edited` / `inspected` / `created` tag. */
export function RoleTag({ role }: { role: AgentRunArtifactRole }) {
  return (
    <span
      className="m-num shrink-0 rounded-full border border-subtle px-1.5 py-0.5 text-[0.625rem] leading-none tracking-[0.04em] uppercase"
      style={{ color: TONE_COLOR[ROLE_TONE[role]] }}
    >
      {ROLE_LABEL[role]}
    </span>
  )
}

/**
 * One file the run touched.
 *
 * The path is split so the filename reads at full strength and its directory
 * sits back — a column of `src/lib/auth/…` prefixes at equal weight is a wall,
 * and the leaf is the part a reader is scanning for.
 */
export function ArtifactRow({
  relativePath,
  roles,
  dimmed = false,
  highlighted = false,
  trailing,
  className,
  style,
}: {
  relativePath: string
  roles: AgentRunArtifactRole[]
  dimmed?: boolean
  highlighted?: boolean
  trailing?: ReactNode
  className?: string
  style?: CSSProperties
}) {
  const cut = relativePath.lastIndexOf("/")
  const dir = cut === -1 ? "" : relativePath.slice(0, cut + 1)
  const file = cut === -1 ? relativePath : relativePath.slice(cut + 1)

  return (
    <div
      className={cn(
        "flex items-center gap-2 rounded-lg border px-2.5 py-2",
        "transition-[opacity,border-color,background-color] duration-(--duration-base) ease-(--ease-standard)",
        highlighted
          ? "border-[color-mix(in_oklch,var(--primary),transparent_45%)] bg-accent-subtle"
          : "border-subtle bg-card/70",
        dimmed && "opacity-30",
        className
      )}
      style={style}
    >
      <span className="m-num min-w-0 flex-1 truncate text-[0.75rem]">
        <span className="text-tertiary">{dir}</span>
        <span className="text-foreground">{file}</span>
      </span>
      {roles.map((role) => (
        <RoleTag key={role} role={role} />
      ))}
      {trailing}
    </div>
  )
}

/* -------------------------------------------------------------------------
 * Agent identity
 * ---------------------------------------------------------------------- */

/**
 * The square an agent is drawn as.
 *
 * A square, where a tab is a rounded rectangle and a section is a circle: the
 * agent layer is a different kind of object in the workspace and reads as one
 * at a glance, which is the same distinction the spatial canvas draws.
 */
export function AgentGlyph({ className, style }: { className?: string; style?: CSSProperties }) {
  return (
    <span
      aria-hidden
      className={cn(
        "inline-flex shrink-0 items-center justify-center rounded-[5px] border text-[0.625rem] font-semibold",
        className
      )}
      style={{
        borderColor: "color-mix(in oklch, var(--primary), transparent 55%)",
        backgroundColor: "color-mix(in oklch, var(--primary), transparent 86%)",
        color: "var(--accent-text)",
        ...style,
      }}
    >
      ◆
    </span>
  )
}

/** Agent name plus the provider line under it. */
export function AgentIdentity({
  name,
  provider,
  size = "md",
}: {
  name: string
  provider: string
  size?: "sm" | "md"
}) {
  return (
    <span className="flex min-w-0 items-center gap-2">
      <AgentGlyph className={size === "sm" ? "size-5" : "size-6"} />
      <span className="min-w-0">
        <span
          className={cn(
            "block truncate font-medium text-foreground",
            size === "sm" ? "text-body-sm" : "text-[0.9375rem]"
          )}
        >
          {name}
        </span>
        <span className="m-num block truncate text-meta text-tertiary">{provider}</span>
      </span>
    </span>
  )
}

/* -------------------------------------------------------------------------
 * Counts
 * ---------------------------------------------------------------------- */

/**
 * The `3 files · 2 context tabs` line under a run.
 *
 * Takes already-computed counts: every caller gets them from
 * `getAgentRunSummary`, so this component has no opportunity to count
 * something differently from the product.
 */
export function RunCounts({
  artifactCount,
  contextTabCount,
  producedTabCount,
  className,
}: {
  artifactCount: number
  contextTabCount: number
  producedTabCount: number
  className?: string
}) {
  const parts = [
    artifactCount > 0 ? `${artifactCount} file${artifactCount === 1 ? "" : "s"}` : null,
    contextTabCount > 0 ? `${contextTabCount} context tab${contextTabCount === 1 ? "" : "s"}` : null,
    producedTabCount > 0 ? `${producedTabCount} produced tab${producedTabCount === 1 ? "" : "s"}` : null,
  ].filter(Boolean)

  if (parts.length === 0) return null

  return (
    <p className={cn("m-num text-[0.75rem] text-tertiary", className)}>{parts.join(" · ")}</p>
  )
}
