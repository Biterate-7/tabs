"use client"

import { useEffect, useRef } from "react"
import { Button } from "@/components/ui/button"
import { permissionScopeLabel, approvalActionLabel } from "@/lib/agents/command-centre/presentation"
import { WORKSPACE_CHANGE_HEADLINE } from "@/lib/agents/session-context/changes"
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities"
import { platformProvider } from "@/lib/agents/platform/catalog"
import { cn } from "@/lib/utils"
import type { RuntimeApprovalView } from "@/lib/agents/runtime/protocol"

/**
 * The decision the run is stopped on.
 *
 * ## Why this is the loudest thing on the screen
 *
 * `waiting_for_approval` is the one session state where the agent is blocked
 * on the *user* and nothing else will happen until they answer. Everything
 * else in the command centre is dim by design; this is the exception, and it
 * is the only place in the surface that uses a warning border.
 *
 * ## What it is architecturally
 *
 * A pair of buttons that call `respond_to_approval` with the id the runtime
 * gave, and nothing else. It does not execute the tool, does not reach a
 * provider SDK, does not construct an approval object, and cannot mint an
 * approval id — the broker owns all of that, and the runtime's guard suite
 * asserts there is no second path to a granted decision. The UI's entire role
 * is to express which of two words the user chose.
 *
 * ## Targets
 *
 * `targets` is project-relative by the time it reaches here — the control
 * plane's approvals module makes it so, precisely because an absolute path in
 * an approval dialog would publish the user's directory layout into a
 * screenshot. This component prints what it is given and never joins it to a
 * root.
 */

function expiryLabel(expiresAt: number, now: number): { text: string; expired: boolean } {
  const remaining = expiresAt - now
  if (remaining <= 0) return { text: "Expired", expired: true }

  const seconds = Math.ceil(remaining / 1000)
  if (seconds < 60) return { text: `Expires in ${seconds}s`, expired: false }
  return { text: `Expires in ${Math.ceil(seconds / 60)}m`, expired: false }
}

export function ApprovalPrompt({
  approval,
  projectName,
  workspaceName,
  onRespond,
  pending,
  now,
}: {
  approval: RuntimeApprovalView
  /** The project's name. Falls back to nothing rather than printing an id at the user. */
  projectName?: string
  /** The workspace's name, for a change to a TabDump workspace (Phase J.3). */
  workspaceName?: string
  onRespond: (approvalId: string, decision: "granted" | "denied") => void
  pending: boolean
  /** Supplied by the caller so the countdown ticks without an impure render. */
  now: number
}) {
  const denyRef = useRef<HTMLButtonElement | null>(null)
  const expiry = expiryLabel(approval.expiresAt, now)
  // The name the connector surfaces use ("Gemini CLI"), whichever agent asks.
  const agentName = platformProvider(approval.provider)?.displayName ?? agentVisualIdentity(approval.provider).displayName

  /*
    Focus lands on Deny.

    A run that stops for permission has interrupted the user, and the button
    that arrives under an unaimed Enter should be the one that changes nothing.
    Both remain reachable by keyboard; only the default differs.
  */
  useEffect(() => {
    denyRef.current?.focus()
  }, [approval.approvalId])

  return (
    <li
      // `alertdialog` would trap focus and take the whole surface hostage; this
      // is an inline decision inside a stream the user may still scroll. The
      // live region is what makes it announce when it appears.
      role="group"
      aria-live="assertive"
      aria-label="Approval required"
      className={cn(
        /*
          Deliberately the heaviest block in the stream.

          Everything else here is flat on the page; this is the one event that
          stops the run and waits for a person, and in review it read as just
          another bordered box — the same weight as the user's own message two
          rows above it. So it gets the full-strength warning border, a tinted
          surface and an accent edge, which is the only place in the command
          centre that combination is used.
        */
        "my-4 rounded-md border border-l-2 px-3.5 py-3",
        expiry.expired
          ? "border-subtle border-l-subtle bg-surface opacity-70"
          : "border-warning/60 border-l-warning bg-warning/[0.06]"
      )}
    >
      <div className="flex items-baseline justify-between gap-3">
        <span className="text-eyebrow text-warning">Approval required</span>
        <span className="shrink-0 text-meta text-tertiary">{expiry.text}</span>
      </div>

      {/*
        The action, then the permission it falls under — in words.

        `approval.scope` is an internal identifier (`write_project`), and
        printing it raw turned the one authorization prompt in the product
        into debug output. See `permissionScopeLabel`.
      */}
      <p className="mt-2 text-body font-medium text-foreground">{approvalActionLabel(approval.action)}</p>
      {approval.change ? (
        /*
          A workspace change (J.4), said the same way whichever agent asks:
          who, what, to which collection — names and titles, never ids.
        */
        <div className="mt-0.5">
          <p className="text-body-sm text-muted-foreground">
            {agentName} wants to {WORKSPACE_CHANGE_HEADLINE[approval.change.kind]}:
          </p>
          <p className="mt-1 text-body-sm font-medium text-foreground">
            {approval.change.kind === "rename_collection" && approval.change.to
              ? `${approval.change.subject} → ${approval.change.to}`
              : approval.change.subject}
          </p>
          {approval.change.details.length > 0 && (
            <ul className="mt-1 flex flex-col gap-0.5">
              {approval.change.details.map((detail) => (
                <li key={detail} className="truncate text-meta text-muted-foreground">
                  {detail}
                </li>
              ))}
            </ul>
          )}
        </div>
      ) : (
        <p className="mt-0.5 text-body-sm text-muted-foreground">
          {permissionScopeLabel(approval.scope)}
        </p>
      )}

      {!approval.change && approval.targets.length > 0 && (
        <ul className="mt-1.5 flex flex-col gap-0.5">
          {approval.targets.map((target) => (
            <li key={target} className="truncate font-mono text-meta text-muted-foreground">
              {target}
            </li>
          ))}
        </ul>
      )}

      {approval.reason && !approval.change && <p className="mt-1.5 text-body-sm text-tertiary">{approval.reason}</p>}

      {projectName && (
        <p className="mt-1.5 text-label text-tertiary">
          In <span className="text-muted-foreground">{projectName}</span>
        </p>
      )}
      {workspaceName && (
        <p className="mt-1.5 text-label text-tertiary">
          Workspace <span className="text-muted-foreground">{workspaceName}</span>
        </p>
      )}

      {/* Wider than the command centre's other buttons: this is the decision
          the whole run is stopped on, and it should not be the same size as
          "Edit" in the context panel. */}
      <div className="mt-3 flex items-center gap-2">
        <Button
          ref={denyRef}
          type="button"
          size="sm"
          variant="outline"
          className="min-w-20"
          disabled={pending || expiry.expired}
          onClick={() => onRespond(approval.approvalId, "denied")}
        >
          Deny
        </Button>
        <Button
          type="button"
          size="sm"
          variant="default"
          className="min-w-20"
          disabled={pending || expiry.expired}
          onClick={() => onRespond(approval.approvalId, "granted")}
        >
          Allow
        </Button>
        {expiry.expired && (
          <span className="ml-1 text-body-sm text-tertiary">
            This decision timed out. Send the task again.
          </span>
        )}
      </div>
    </li>
  )
}
