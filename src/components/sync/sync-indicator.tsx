"use client"

import { useState } from "react"
import { Check, CloudOff, RefreshCw, TriangleAlert, UploadCloud } from "lucide-react"
import type { WorkspaceJournal } from "@/lib/sync/journal"
import type { LocalSyncConflict } from "@/lib/sync/conflicts"
import { favoursLocalManualIntent } from "@/lib/sync/conflicts"

/**
 * A small, unobtrusive sync status control.
 *
 * Deliberately not a settings page and deliberately never a modal: a
 * conflict is surfaced, not forced. The user keeps working and deals with it
 * when they choose, which is the whole point of local-first — a
 * synchronization problem is not an application problem.
 */

type Props = {
  state: WorkspaceJournal
  /** Signed out, or this deployment has no accounts. The control hides itself entirely rather than offering something that cannot work. */
  disabled?: boolean
  onSyncNow(): void
  onMigrate(): void
  onResolve(conflictId: string, choice: "local" | "remote"): void
}

function describe(state: WorkspaceJournal): { label: string; icon: React.ReactNode; tone: string } {
  switch (state.status) {
    case "never-synced":
      return { label: "Not synced", icon: <UploadCloud className="size-3.5" />, tone: "text-tertiary" }
    case "queued":
    case "syncing":
      return { label: "Syncing…", icon: <RefreshCw className="size-3.5 animate-spin" />, tone: "text-tertiary" }
    case "offline":
      return { label: "Offline", icon: <CloudOff className="size-3.5" />, tone: "text-tertiary" }
    case "paused":
      return { label: "Sign in to sync", icon: <CloudOff className="size-3.5" />, tone: "text-tertiary" }
    case "conflict":
      // A conflict status with nothing in it is not something to show a
      // person — "0 conflicts" reads as a fault when nothing is wrong.
      // The status itself should no longer be reachable while empty (the
      // second-device case that produced it now adopts instead), but the
      // label must not depend on that being true everywhere.
      if (state.conflicts.length === 0) {
        return { label: "Syncing…", icon: <RefreshCw className="size-3.5 animate-spin" />, tone: "text-tertiary" }
      }
      return {
        label: `${state.conflicts.length} conflict${state.conflicts.length === 1 ? "" : "s"}`,
        icon: <TriangleAlert className="size-3.5" />,
        tone: "text-amber-600 dark:text-amber-500",
      }
    case "error":
      return { label: "Sync failed", icon: <TriangleAlert className="size-3.5" />, tone: "text-tertiary" }
    default:
      return { label: "Synced", icon: <Check className="size-3.5" />, tone: "text-tertiary" }
  }
}

export function SyncIndicator({ state, disabled, onSyncNow, onMigrate, onResolve }: Props) {
  const [open, setOpen] = useState(false)
  if (disabled) return null

  const { label, icon, tone } = describe(state)
  const hasConflicts = state.conflicts.length > 0

  return (
    <div className="relative">
      <button
        type="button"
        aria-label={`Sync status: ${label}`}
        onClick={() => setOpen((v) => !v)}
        className={`flex items-center gap-1.5 rounded-md px-2 py-1 text-xs ${tone} hover:bg-subtle`}
      >
        {icon}
        <span>{label}</span>
      </button>

      {open ? (
        <div
          role="dialog"
          aria-label="Synchronization"
          className="absolute right-0 z-50 mt-1 w-80 rounded-lg border border-subtle bg-surface p-3 shadow-lg"
        >
          {state.status === "never-synced" ? (
            <div className="space-y-2">
              <p className="text-xs text-secondary">
                This workspace is only on this device. Uploading it is explicit — nothing is sent until you ask.
              </p>
              <button
                type="button"
                onClick={() => {
                  onMigrate()
                  setOpen(false)
                }}
                className="w-full rounded-md bg-accent px-2 py-1.5 text-xs text-on-accent"
              >
                Upload this workspace
              </button>
            </div>
          ) : null}

          {state.lastError && !hasConflicts ? (
            <p className="text-xs text-secondary">{state.lastError}</p>
          ) : null}

          {hasConflicts ? (
            <div className="space-y-3">
              <p className="text-xs text-secondary">
                These were changed on another device too. Your copy is safe either way — nothing is
                overwritten until you choose.
              </p>
              {state.conflicts.map((conflict) => (
                <ConflictRow key={conflict.id} conflict={conflict} onResolve={onResolve} />
              ))}
            </div>
          ) : null}

          {state.status !== "never-synced" && !hasConflicts ? (
            <button
              type="button"
              onClick={() => {
                onSyncNow()
                setOpen(false)
              }}
              className="mt-2 w-full rounded-md border border-subtle px-2 py-1.5 text-xs"
            >
              Sync now
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

function summarize(payload: LocalSyncConflict["local"]): string {
  if (payload === null) return "deleted"
  if (payload.entityType === "tab") return payload.entity.title || payload.entity.url
  if (payload.entityType === "workspace") return payload.entity.name
  return payload.entity.name
}

function ConflictRow({
  conflict,
  onResolve,
}: {
  conflict: LocalSyncConflict
  onResolve(conflictId: string, choice: "local" | "remote"): void
}) {
  const manual = favoursLocalManualIntent(conflict)

  return (
    <div className="rounded-md border border-subtle p-2">
      <p className="text-[11px] uppercase tracking-wide text-tertiary">{conflict.entityType}</p>
      <dl className="mt-1 space-y-0.5 text-xs">
        <div className="flex gap-1">
          <dt className="text-tertiary">Yours:</dt>
          <dd className="truncate">{summarize(conflict.local)}</dd>
        </div>
        <div className="flex gap-1">
          <dt className="text-tertiary">Theirs:</dt>
          <dd className="truncate">{conflict.remote ? summarize(conflict.remote) : "not yet fetched"}</dd>
        </div>
      </dl>

      {manual ? (
        // The one case with real product meaning: an automatic
        // reorganization tried to move something a human placed. Saying so
        // beats presenting two equivalent-looking buttons.
        <p className="mt-1 text-[11px] text-amber-600 dark:text-amber-500">
          You placed this manually — keeping yours preserves that.
        </p>
      ) : null}

      <div className="mt-2 flex gap-1">
        <button
          type="button"
          onClick={() => onResolve(conflict.id, "local")}
          className="flex-1 rounded-md border border-subtle px-2 py-1 text-xs"
        >
          Keep mine
        </button>
        <button
          type="button"
          onClick={() => onResolve(conflict.id, "remote")}
          className="flex-1 rounded-md border border-subtle px-2 py-1 text-xs"
          // Without the remote payload there is nothing to switch to yet;
          // the next pull fills it in.
          disabled={conflict.remote === null && conflict.reason !== "local-edit-remote-delete"}
        >
          Keep theirs
        </button>
      </div>
    </div>
  )
}
