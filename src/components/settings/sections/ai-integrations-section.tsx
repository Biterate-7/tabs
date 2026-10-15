"use client"

import { useMemo, useState } from "react"
import { AlertTriangle, Check, Copy, ExternalLink, Loader2, ShieldCheck, X, Cable } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Checkbox } from "@/components/ui/checkbox"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog"
import { ProviderMark } from "@/components/memory/provider-mark"
import { useOptionalAuth } from "@/components/auth/auth-provider"
import { SignInDialog } from "@/components/auth/sign-in-dialog"
import { useIntegrations, useProjectMemory } from "@/hooks/use-integrations"
import { useNow } from "@/hooks/use-now"
import { isDesktop } from "@/lib/platform/detect"
import { CANONICAL_PRODUCTION_ORIGIN } from "@/lib/production-origin.mjs"
import { formatRelativeTime } from "@/lib/time-format"
import { ACTIVITY_KIND_LABEL, ACTIVITY_OUTCOME_LABEL } from "@/lib/integrations/activity-labels"
import { CLIENT_TEST_LABEL, PLATFORM_SURFACES, VERIFICATION_LABEL, VERIFIED_ON } from "@/lib/integrations/platforms"
import { CLIENT_NAME, NEVER_ALLOWED, PERMISSION_DESCRIPTION, PERMISSION_LABEL } from "@/lib/integrations/scopes"
import { setupSnippets } from "@/lib/integrations/setup"
import { GroupBlock, GroupLabel, SectionHeading, SectionStack } from "./section-ui"
import type { ConnectionTestResult, ConnectionView } from "@/lib/integrations/service"
import type { ActivityView } from "@/lib/integrations/activity-labels"
import type { ClientTestRecord, PlatformSurface } from "@/lib/integrations/platforms"
import type { IntegrationClient, PermissionLevel } from "@/lib/integrations/scopes"
import type { IntegrationsData, UseIntegrations } from "@/hooks/use-integrations"

/**
 * Settings → AI connectors: using Hubble from inside ChatGPT, Claude,
 * Gemini and Grok.
 *
 * The other half of cross-AI memory: instead of copying context out of
 * Hubble, an AI app the person already uses reaches *into* their synced
 * Hubble through an MCP connector. One pane
 * for every client, because there is one integration underneath — one MCP
 * endpoint, one grant model, one audit log — and what differs per product
 * is only how it is set up, which comes from the verified platform registry
 * (src/lib/integrations/platforms.ts).
 *
 * Every status shown is one the server observed. A connection reads
 * "Connected" only after the client actually called Hubble; "Setup
 * incomplete" until then; a test passes only when each of its checks did.
 */

/** The client's mark: an AI app Hubble knows, or a neutral one. */
function ClientMark({ client }: { client: IntegrationClient }) {
  if (client === "chatgpt" || client === "claude" || client === "gemini") return <ProviderMark provider={client} size={16} />
  return <Cable aria-hidden className="size-4 shrink-0 text-muted-foreground" />
}

const CLIENTS: { value: Exclude<IntegrationClient, "other">; label: string }[] = [
  { value: "chatgpt", label: "ChatGPT" },
  { value: "claude", label: "Claude" },
  { value: "gemini", label: "Gemini" },
  { value: "grok", label: "Grok" },
]

function CopyButton({ text, label = "Copy" }: { text: string; label?: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={() => {
        void navigator.clipboard?.writeText(text)
        setCopied(true)
      }}
    >
      {copied ? <Check aria-hidden /> : <Copy aria-hidden />}
      {copied ? "Copied" : label}
    </Button>
  )
}

function Snippet({ label, text, where }: { label: string; text: string; where: string }) {
  return (
    <div className="mt-2">
      <div className="flex items-center justify-between gap-2">
        <p className="text-body-sm font-medium text-foreground">{label}</p>
        <CopyButton text={text} />
      </div>
      <pre className="mt-1 max-h-56 overflow-auto rounded-xs bg-muted p-2 text-meta whitespace-pre-wrap break-all text-foreground">{text}</pre>
      <p className="mt-1 text-body-sm text-muted-foreground">{where}</p>
    </div>
  )
}

/** The person-facing status of a connection, including what the last test and recent activity said. */
export function connectionBadge(
  connection: ConnectionView,
  test: ConnectionTestResult | "running" | { failed: string } | undefined,
  activity: readonly ActivityView[]
): { label: string; variant: "success" | "warning" | "destructive" | "default" } {
  if (test && test !== "running" && ("failed" in test || !test.ok)) return { label: "Connection test failed", variant: "destructive" }
  if (connection.status === "expired") return { label: "Authentication expired", variant: "warning" }
  if (connection.status === "waiting_for_client") return { label: "Setup incomplete", variant: "default" }
  const denied = activity.find((entry) => entry.connectionId === connection.id && entry.actor === "ai_client")?.outcome === "denied"
  if (denied) return { label: "Permission denied on last request", variant: "warning" }
  return { label: connection.permission === "write" ? "Connected · can save" : "Connected · read-only", variant: "success" }
}

function WorkspacePicker({
  workspaces,
  chosen,
  onChange,
}: {
  workspaces: IntegrationsData["workspaces"]
  chosen: string[]
  onChange: (next: string[]) => void
}) {
  if (workspaces.length === 0) {
    return (
      <p className="text-body-sm text-muted-foreground" role="alert">
        No workspace is synced to your account yet. AI clients can only see synced workspaces — sync one first.
      </p>
    )
  }
  return (
    <ul className="flex max-h-48 flex-col gap-0.5 overflow-auto rounded-xs border border-border p-1.5" aria-label="Workspaces it can see">
      {workspaces.map((workspace) => (
        <li key={workspace.id}>
          <label className="flex cursor-pointer items-center gap-2 rounded-xs px-2 py-1 hover:bg-surface-hover">
            <Checkbox
              checked={chosen.includes(workspace.id)}
              onCheckedChange={(checked) => onChange(checked ? [...new Set([...chosen, workspace.id])] : chosen.filter((id) => id !== workspace.id))}
            />
            <span className="truncate text-body-sm text-foreground">{workspace.name || "Untitled workspace"}</span>
          </label>
        </li>
      ))}
    </ul>
  )
}

function PermissionPicker({ value, onChange }: { value: PermissionLevel; onChange: (level: PermissionLevel) => void }) {
  return (
    <div className="flex flex-col gap-1">
      <SegmentedControl
        size="sm"
        value={value}
        onValueChange={onChange}
        options={[
          { value: "read", label: PERMISSION_LABEL.read },
          { value: "write", label: PERMISSION_LABEL.write },
        ]}
      />
      <p className="text-body-sm text-muted-foreground">{PERMISSION_DESCRIPTION[value]}</p>
    </div>
  )
}

/** A token connection for a CLI, a config file or the xAI API: choose, create, copy once. */
function TokenSetup({ surface, integrations, data }: { surface: PlatformSurface; integrations: UseIntegrations; data: IntegrationsData }) {
  const [permission, setPermission] = useState<PermissionLevel>("read")
  const [chosen, setChosen] = useState<string[]>(() => (data.workspaces.length === 1 ? [data.workspaces[0].id] : []))
  const [label, setLabel] = useState(surface.product.split(" (")[0])
  // The token this form created, held only until Done. The hook's copy is the same object.
  const [createdHere, setCreatedHere] = useState<string | null>(null)
  const mine = integrations.created && integrations.created.connection.id === createdHere ? integrations.created : null
  const origin = data.mcpUrl.replace(/\/api\/mcp$/, "")

  if (mine) {
    return (
      <div className="mt-3 rounded-md border border-strong p-3" role="status">
        <p className="text-body-sm font-medium text-foreground">Token created. Copy it now — Hubble shows it once.</p>
        {setupSnippets(surface.id, origin, mine.token).map((snippet) => (
          <Snippet key={snippet.label} {...snippet} />
        ))}
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="mt-3"
          onClick={() => {
            setCreatedHere(null)
            integrations.dismissCreated()
          }}
        >
          Done
        </Button>
      </div>
    )
  }

  return (
    <form
      className="mt-3 flex flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault()
        void integrations.createToken({ client: surface.client, label, permission, workspaceIds: chosen }).then((created) => {
          if (created) setCreatedHere(created.connection.id)
        })
      }}
    >
      <label className="flex flex-col gap-1">
        <span className="text-label text-muted-foreground">Name</span>
        <Input value={label} maxLength={60} onChange={(event) => setLabel(event.target.value)} className="h-8 max-w-72" />
      </label>
      <PermissionPicker value={permission} onChange={setPermission} />
      <WorkspacePicker workspaces={data.workspaces} chosen={chosen} onChange={setChosen} />
      <div>
        <Button type="submit" size="sm" disabled={integrations.busy === "create" || chosen.length === 0 || !label.trim()}>
          {integrations.busy === "create" && <Loader2 className="animate-spin" aria-hidden />}
          Create token
        </Button>
      </div>
    </form>
  )
}

/** What happened in the vendor's own product, capability by capability — never one blanket tick. */
function ClientTests({ record }: { record: ClientTestRecord }) {
  const rows = [
    ["Read", record.read],
    ["Save", record.write],
    ["Approval in Hubble", record.approval],
    ["Disconnect", record.revocation],
  ] as const
  return (
    <div className="rounded-xs border border-border p-2" data-testid="client-tests">
      <p className="text-body-sm text-foreground">Tested in this product on {record.date}</p>
      <ul className="mt-1 flex flex-wrap gap-x-4 gap-y-1">
        {rows.map(([label, status]) => (
          <li key={label} className={`flex items-center gap-1 text-body-sm ${status === "pass" ? "text-foreground" : "text-muted-foreground"}`}>
            {status === "pass" ? <Check className="size-3.5 text-success" aria-hidden /> : <X className="size-3.5" aria-hidden />}
            {label}: {CLIENT_TEST_LABEL[status]}
          </li>
        ))}
      </ul>
      <p className="mt-1 text-meta text-tertiary">{record.setup}.</p>
      {record.note && <p className="mt-1 text-meta text-tertiary">{record.note}</p>}
    </div>
  )
}

function SurfaceGuide({ surface, integrations, data }: { surface: PlatformSurface; integrations: UseIntegrations; data: IntegrationsData }) {
  const [open, setOpen] = useState(surface.kind === "app")
  const origin = data.mcpUrl.replace(/\/api\/mcp$/, "")
  const usesToken = surface.recommended !== "remote-oauth"
  return (
    <div className="border-t border-subtle px-4 py-3 first:border-t-0" data-testid={`surface-${surface.id}`}>
      <button
        type="button"
        className="flex w-full items-start justify-between gap-3 text-left"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="min-w-0">
          <span className="block text-body text-foreground">{surface.product}</span>
          <span className="mt-0.5 block text-body-sm text-muted-foreground">
            {surface.hubble === "ready" ? (usesToken ? "Connect with a Hubble token" : "Connect by signing in to Hubble (OAuth)") : "Not supported"}
          </span>
        </span>
        <Badge variant={surface.verification === "client" ? "success" : surface.clientTests ? "warning" : "outline"}>
          {surface.verification === "client" ? "Tested in this app" : surface.clientTests ? "Blocked by the vendor" : "Not yet tested in this app"}
        </Badge>
      </button>
      {open && (
        <div className="mt-3 flex flex-col gap-2">
          <ol className="flex list-decimal flex-col gap-1 pl-5 text-body-sm text-muted-foreground">
            {surface.steps.map((step) => (
              <li key={step}>{step}</li>
            ))}
          </ol>
          {surface.clientTests && <ClientTests record={surface.clientTests} />}
          {!usesToken && setupSnippets(surface.id, origin).map((snippet) => <Snippet key={snippet.label} {...snippet} />)}
          {usesToken && <TokenSetup surface={surface} integrations={integrations} data={data} />}
          <div className="mt-1 rounded-xs bg-surface-hover p-2">
            <p className="text-body-sm text-foreground">Requirements</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-body-sm text-muted-foreground">
              {surface.requirements.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-body-sm text-foreground">Limitations</p>
            <ul className="mt-1 flex list-disc flex-col gap-0.5 pl-5 text-body-sm text-muted-foreground">
              {[surface.write.note, ...surface.limitations].map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
            <p className="mt-2 text-meta text-tertiary">
              {VERIFICATION_LABEL[surface.verification]}. Requirements checked against{" "}
              <a className="text-link underline-offset-4 hover:underline" href={surface.docs} target="_blank" rel="noreferrer">
                the vendor’s documentation <ExternalLink className="inline size-3" aria-hidden />
              </a>{" "}
              on {surface.verifiedOn}.
            </p>
          </div>
        </div>
      )}
    </div>
  )
}

function ConnectionRow({
  connection,
  integrations,
  data,
  now,
}: {
  connection: ConnectionView
  integrations: UseIntegrations
  data: IntegrationsData
  now: number
}) {
  const [editing, setEditing] = useState(false)
  const [permission, setPermission] = useState<PermissionLevel>(connection.permission)
  const [chosen, setChosen] = useState<string[]>(connection.workspaceIds)
  const test = integrations.tests[connection.id]
  const badge = connectionBadge(connection, test, data.activity)
  const names = new Map(data.workspaces.map((workspace) => [workspace.id, workspace.name]))
  const visible = connection.workspaceIds.filter((id) => names.has(id))

  return (
    <li className="px-4 py-3" data-testid={`connection-${connection.id}`}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="flex min-w-0 items-start gap-2">
          <ClientMark client={connection.client} />
          <div className="min-w-0">
            <p className="truncate text-body text-foreground">
              {connection.label} <span className="text-body-sm text-muted-foreground">· {connection.clientName}</span>
            </p>
            <p className="text-body-sm text-muted-foreground">
              {PERMISSION_LABEL[connection.permission]} · {visible.length} {visible.length === 1 ? "workspace" : "workspaces"} ·{" "}
              {connection.method === "oauth" ? "signed in with OAuth" : `token …${connection.token?.hint ?? ""}`}
              {connection.lastUsedAt ? ` · last used ${formatRelativeTime(connection.lastUsedAt, now)}` : " · never used yet"}
            </p>
          </div>
        </div>
        <Badge variant={badge.variant}>{badge.label}</Badge>
      </div>

      {connection.status === "waiting_for_client" && (
        <p className="mt-2 text-body-sm text-muted-foreground">
          Hubble has not heard from {connection.clientName} on this connection yet. Finish setup there, then ask it something about your workspace.
        </p>
      )}
      {connection.status === "expired" && (
        <p className="mt-2 text-body-sm text-muted-foreground">
          {connection.method === "oauth"
            ? `Reconnect Hubble from ${connection.clientName} to sign in again.`
            : "This token has expired. Disconnect it and create a new one."}
        </p>
      )}

      {test && test !== "running" && (
        <ul className="mt-2 flex flex-col gap-1" aria-label="Connection test results">
          {"failed" in test ? (
            <li className="flex items-start gap-2 text-body-sm text-destructive">
              <X className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {test.failed}
            </li>
          ) : (
            test.steps.map((step) => (
              <li key={step.id} className={`flex items-start gap-2 text-body-sm ${step.ok ? "text-muted-foreground" : "text-destructive"}`}>
                {step.ok ? <Check className="mt-0.5 size-3.5 shrink-0 text-success" aria-hidden /> : <X className="mt-0.5 size-3.5 shrink-0" aria-hidden />}
                <span>
                  <span className="text-foreground">{step.label}.</span> {step.detail}
                </span>
              </li>
            ))
          )}
        </ul>
      )}

      {editing && (
        <div className="mt-3 flex flex-col gap-3 rounded-xs border border-border p-3">
          <PermissionPicker value={permission} onChange={setPermission} />
          <WorkspacePicker workspaces={data.workspaces} chosen={chosen} onChange={setChosen} />
          <div className="flex gap-2">
            <Button
              type="button"
              size="sm"
              disabled={chosen.length === 0 || integrations.busy === `update:${connection.id}`}
              onClick={async () => {
                await integrations.updateConnection(connection.id, { permission, workspaceIds: chosen })
                setEditing(false)
              }}
            >
              Save
            </Button>
            <Button type="button" size="sm" variant="outline" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          </div>
        </div>
      )}

      <div className="mt-2 flex flex-wrap gap-2">
        <Button type="button" size="sm" variant="outline" disabled={test === "running" || connection.status === "expired"} onClick={() => void integrations.testConnection(connection.id)}>
          {test === "running" && <Loader2 className="animate-spin" aria-hidden />}
          {test === "running" ? "Testing…" : test && !("failed" in test) && test.ok ? "Test again" : "Test connection"}
        </Button>
        {!editing && (
          <Button type="button" size="sm" variant="outline" onClick={() => setEditing(true)}>
            Change access
          </Button>
        )}
        <AlertDialog>
          <AlertDialogTrigger render={<Button type="button" size="sm" variant="destructive" />}>Disconnect</AlertDialogTrigger>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Disconnect {connection.label}?</AlertDialogTitle>
              <AlertDialogDescription>
                {connection.clientName} loses access to Hubble on its very next request. What it already saved stays in Hubble. You can connect it again later.
              </AlertDialogDescription>
            </AlertDialogHeader>
            <AlertDialogFooter>
              <AlertDialogCancel>Keep connected</AlertDialogCancel>
              <AlertDialogAction onClick={() => void integrations.revokeConnection(connection.id)}>Disconnect</AlertDialogAction>
            </AlertDialogFooter>
          </AlertDialogContent>
        </AlertDialog>
      </div>
    </li>
  )
}

function Proposals({ integrations, data, now }: { integrations: UseIntegrations; data: IntegrationsData; now: number }) {
  const shown = data.proposals.filter((proposal) => ["pending", "approved", "applying"].includes(proposal.status) || now - proposal.createdAt < 7 * 24 * 60 * 60 * 1000)
  if (shown.length === 0) return null
  const names = new Map(data.workspaces.map((workspace) => [workspace.id, workspace.name]))
  const STATUS: Record<string, string> = {
    pending: "Waiting for you",
    approved: "Approved — waiting to be applied",
    applying: "Applying…",
    applied: "Applied",
    declined: "Declined",
    failed: "Not applied",
    expired: "Expired",
  }
  return (
    <>
      <GroupLabel>Changes proposed by AI clients</GroupLabel>
      <SectionStack className="mb-6">
        <ul className="divide-y divide-subtle">
          {shown.map((proposal) => (
            <li key={proposal.proposalId} className="px-4 py-3" data-testid={`proposal-${proposal.proposalId}`}>
              <div className="flex flex-wrap items-start justify-between gap-2">
                <p className="text-body text-foreground">
                  {proposal.clientName} proposed {proposal.changes.length} {proposal.changes.length === 1 ? "change" : "changes"} in “{names.get(proposal.workspaceId) ?? "a workspace"}”
                </p>
                <Badge variant={proposal.status === "pending" ? "accent" : proposal.status === "applied" ? "success" : "default"}>{STATUS[proposal.status]}</Badge>
              </div>
              {proposal.summary && <p className="mt-1 text-body-sm text-muted-foreground">Its words: “{proposal.summary}”</p>}
              <ul className="mt-2 flex flex-col gap-1">
                {proposal.steps.map((step, index) => (
                  <li key={index} className="text-body-sm text-foreground">
                    {step.line}
                    {step.tabs.length > 0 && (
                      <span className="block text-meta text-tertiary">
                        {step.tabs.slice(0, 5).join(" · ")}
                        {step.tabs.length > 5 || step.moreTabs ? ` · and ${(step.moreTabs ?? 0) + Math.max(0, step.tabs.length - 5)} more` : ""}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
              {proposal.failure === "changed" && (
                <p className="mt-2 text-body-sm text-muted-foreground">The workspace changed after this was proposed, so it was not applied. Nothing changed.</p>
              )}
              <div className="mt-2 flex gap-2">
                {proposal.status === "pending" && (
                  <>
                    <Button type="button" size="sm" disabled={integrations.busy === `proposal:${proposal.proposalId}`} onClick={() => void integrations.decideProposal(proposal.proposalId, "approve")}>
                      Approve
                    </Button>
                    <Button type="button" size="sm" variant="outline" disabled={integrations.busy === `proposal:${proposal.proposalId}`} onClick={() => void integrations.decideProposal(proposal.proposalId, "decline")}>
                      Decline
                    </Button>
                  </>
                )}
                {proposal.status === "approved" && (
                  <Button type="button" size="sm" variant="outline" disabled={integrations.busy === `proposal:${proposal.proposalId}`} onClick={() => void integrations.decideProposal(proposal.proposalId, "apply")}>
                    Apply now
                  </Button>
                )}
              </div>
            </li>
          ))}
        </ul>
      </SectionStack>
    </>
  )
}

function ProjectMemoryPanel({ data }: { data: IntegrationsData }) {
  const [workspaceId, setWorkspaceId] = useState<string | null>(null)
  const project = useProjectMemory(workspaceId)
  const memory = project.memory
  return (
    <>
      <GroupLabel>Saved project context</GroupLabel>
      <SectionStack className="mb-6">
        <GroupBlock>
          <p className="text-body-sm text-muted-foreground">What AI clients saved in Hubble when you asked them to — goals, summaries, decisions, tasks and notes. Only you can delete it.</p>
          <select
            aria-label="Workspace"
            className="mt-2 h-8 rounded-xs border border-border bg-background px-2 text-body-sm text-foreground"
            value={workspaceId ?? ""}
            onChange={(event) => setWorkspaceId(event.target.value || null)}
          >
            <option value="">Choose a workspace…</option>
            {data.workspaces.map((workspace) => (
              <option key={workspace.id} value={workspace.id}>
                {workspace.name || "Untitled workspace"}
              </option>
            ))}
          </select>
          {memory === "loading" && <p className="mt-2 text-body-sm text-muted-foreground">Loading…</p>}
          {memory && typeof memory === "object" && "failed" in memory && <p className="mt-2 text-body-sm text-destructive">{memory.failed}</p>}
          {memory && typeof memory === "object" && "notes" in memory && (
            <div className="mt-3 flex flex-col gap-2">
              {!memory.context && memory.notesTotal === 0 && <p className="text-body-sm text-muted-foreground">Nothing has been saved for this workspace.</p>}
              {memory.context?.goal && <p className="text-body-sm text-foreground"><span className="text-muted-foreground">Goal:</span> {memory.context.goal}</p>}
              {memory.context?.summary && <p className="text-body-sm whitespace-pre-wrap text-foreground"><span className="text-muted-foreground">Summary:</span> {memory.context.summary}</p>}
              {memory.context && memory.context.decisions.length > 0 && (
                <div>
                  <p className="text-body-sm text-muted-foreground">Decisions</p>
                  <ul className="list-disc pl-5 text-body-sm text-foreground">
                    {memory.context.decisions.map((decision) => <li key={decision.id}>{decision.text}</li>)}
                  </ul>
                </div>
              )}
              {memory.context && memory.context.tasks.length > 0 && (
                <div>
                  <p className="text-body-sm text-muted-foreground">Tasks</p>
                  <ul className="flex flex-col gap-0.5 text-body-sm text-foreground">
                    {memory.context.tasks.map((task) => (
                      <li key={task.id}>{task.status === "done" ? "✓ " : "○ "}{task.text}</li>
                    ))}
                  </ul>
                </div>
              )}
              {memory.notes.length > 0 && (
                <div>
                  <p className="text-body-sm text-muted-foreground">Notes ({memory.notesTotal})</p>
                  <ul className="flex flex-col gap-2">
                    {memory.notes.map((note) => (
                      <li key={note.id} className="rounded-xs border border-border p-2">
                        <div className="flex items-start justify-between gap-2">
                          <p className="text-body-sm font-medium text-foreground">{note.title}</p>
                          <Button type="button" size="xs" variant="ghost" onClick={() => void project.deleteNote(note.id)}>
                            Delete
                          </Button>
                        </div>
                        <p className="mt-1 line-clamp-4 text-body-sm whitespace-pre-wrap text-muted-foreground">{note.body}</p>
                      </li>
                    ))}
                  </ul>
                </div>
              )}
              {memory.context && (
                <div>
                  <Button type="button" size="sm" variant="outline" onClick={() => void project.clear()}>
                    Clear saved context
                  </Button>
                </div>
              )}
            </div>
          )}
        </GroupBlock>
      </SectionStack>
    </>
  )
}

function ActivityList({ data, now }: { data: IntegrationsData; now: number }) {
  if (data.activity.length === 0) return null
  const names = new Map(data.workspaces.map((workspace) => [workspace.id, workspace.name]))
  return (
    <>
      <GroupLabel>Recent activity</GroupLabel>
      <SectionStack className="mb-6">
        <ul className="divide-y divide-subtle" aria-label="Recent AI integration activity">
          {data.activity.slice(0, 25).map((entry) => (
            <li key={entry.id} className="flex items-start justify-between gap-3 px-4 py-2">
              <div className="min-w-0">
                <p className="truncate text-body-sm text-foreground">
                  {entry.actor === "user" ? "You" : entry.actor === "connection_test" ? "Connection test" : CLIENT_NAME[entry.client ?? "other"]} ·{" "}
                  {entry.detail ?? `${ACTIVITY_KIND_LABEL[entry.kind]}: ${entry.operation.replaceAll("_", " ")}`}
                </p>
                <p className="text-meta text-tertiary">
                  {formatRelativeTime(entry.at, now)}
                  {entry.workspaceId && names.has(entry.workspaceId) ? ` · ${names.get(entry.workspaceId)}` : ""}
                </p>
              </div>
              <span className={`shrink-0 text-meta ${entry.outcome === "ok" ? "text-tertiary" : entry.outcome === "pending" ? "text-link" : "text-warning"}`}>
                {ACTIVITY_OUTCOME_LABEL[entry.outcome]}
              </span>
            </li>
          ))}
        </ul>
      </SectionStack>
    </>
  )
}

function Guide() {
  return (
    <SectionStack className="mb-6">
      <GroupBlock>
        <p className="flex items-center gap-2 text-body text-foreground">
          <ShieldCheck className="size-4" aria-hidden /> What connecting gives an AI client
        </p>
        <ul className="mt-2 flex list-disc flex-col gap-1 pl-5 text-body-sm text-muted-foreground">
          <li>Only the workspaces you choose, and only once they are synced to your account. Workspaces kept only on a device stay invisible.</li>
          <li>{PERMISSION_LABEL.read} by default. {PERMISSION_LABEL.write} is a separate choice; reorganizing several collections still waits for your approval here.</li>
          <li>What it reads is sent to that AI provider and handled under its privacy terms. Hubble records what each client did — never your conversations or page text.</li>
          <li>Disconnect any time below; access ends on its next request.</li>
        </ul>
        <p className="mt-2 text-body-sm text-foreground">No connection can ever:</p>
        <ul className="mt-1 flex flex-col gap-0.5">
          {NEVER_ALLOWED.map((line) => (
            <li key={line} className="flex items-start gap-2 text-body-sm text-muted-foreground">
              <X className="mt-0.5 size-3.5 shrink-0" aria-hidden /> {line}
            </li>
          ))}
        </ul>
      </GroupBlock>
    </SectionStack>
  )
}

export function AiIntegrationsSection() {
  const desktop = isDesktop()
  const integrations = useIntegrations({ enabled: !desktop })
  const auth = useOptionalAuth()
  const now = useNow()
  const [client, setClient] = useState<Exclude<IntegrationClient, "other">>("chatgpt")
  const [signInOpen, setSignInOpen] = useState(false)
  const surfaces = useMemo(() => PLATFORM_SURFACES.filter((surface) => surface.client === client), [client])

  const heading = (
    <SectionHeading
      title="AI connectors"
      description="Use Hubble inside ChatGPT, Claude, Gemini and Grok. They read the projects you sync — names, links, titles and collections — and keep what you ask them to save. Saved conversation text and notes stay on this device, so a connector can't see them."
    />
  )

  if (desktop) {
    return (
      <div>
        {heading}
        <SectionStack>
          <GroupBlock>
            <p className="text-body-sm text-muted-foreground">
              AI clients connect to your account on the web, where synced projects live. Open Hubble at{" "}
              <a className="text-link underline-offset-4 hover:underline" href={CANONICAL_PRODUCTION_ORIGIN} target="_blank" rel="noreferrer">
                {CANONICAL_PRODUCTION_ORIGIN.replace(/^https:\/\//, "")}
              </a>
              , sign in, and manage AI Integrations there.
            </p>
          </GroupBlock>
        </SectionStack>
      </div>
    )
  }

  const state = integrations.state
  return (
    <div>
      {heading}
      <Guide />

      {state.kind === "loading" && <p className="text-body-sm text-tertiary">Loading…</p>}
      {state.kind === "signed-out" && (
        <SectionStack>
          <GroupBlock>
            <p className="text-body text-foreground">Setup required: sign in</p>
            <p className="mt-1 text-body-sm text-muted-foreground">AI clients connect to your Hubble account and see the projects you sync to it.</p>
            {auth?.configured && (
              <Button type="button" size="sm" className="mt-3" onClick={() => setSignInOpen(true)}>
                Sign in
              </Button>
            )}
            {auth && <SignInDialog open={signInOpen} onOpenChange={setSignInOpen} />}
          </GroupBlock>
        </SectionStack>
      )}
      {state.kind === "unavailable" && (
        <SectionStack>
          <GroupBlock>
            <p className="text-body text-foreground">Connection unavailable</p>
            <p className="mt-1 text-body-sm text-muted-foreground">This Hubble deployment has no database for AI integrations. Everything else keeps working on this device.</p>
          </GroupBlock>
        </SectionStack>
      )}
      {state.kind === "error" && (
        <p className="text-body-sm text-destructive" role="alert">
          Hubble could not load your AI integrations. <button type="button" className="underline" onClick={() => void integrations.refresh()}>Try again</button>
        </p>
      )}

      {integrations.error && (
        <p className="mb-4 flex items-start gap-2 text-body-sm text-destructive" role="alert">
          <AlertTriangle className="mt-0.5 size-4 shrink-0" aria-hidden /> {integrations.error}
        </p>
      )}

      {state.kind === "ready" && (
        <>
          <Proposals integrations={integrations} data={state.data} now={now} />

          <GroupLabel>Your connections</GroupLabel>
          <SectionStack className="mb-6">
            {state.data.connections.length === 0 ? (
              <GroupBlock>
                <p className="text-body-sm text-muted-foreground">Not connected. Choose an AI client below to set one up.</p>
              </GroupBlock>
            ) : (
              <ul className="divide-y divide-subtle">
                {state.data.connections.map((connection) => (
                  <ConnectionRow key={connection.id} connection={connection} integrations={integrations} data={state.data} now={now} />
                ))}
              </ul>
            )}
          </SectionStack>

          <GroupLabel>Connect an AI client</GroupLabel>
          <SectionStack className="mb-6">
            <GroupBlock>
              <SegmentedControl value={client} onValueChange={setClient} options={CLIENTS} />
              <p className="mt-2 flex items-center gap-2 text-body-sm text-muted-foreground">
                <ClientMark client={client} />
                {state.data.connections.some((connection) => connection.client === client)
                  ? `${CLIENT_NAME[client]} is connected — you can add another product below.`
                  : `${CLIENT_NAME[client]}: not connected.`}{" "}
                MCP server URL: <code className="text-meta text-foreground">{state.data.mcpUrl}</code>
              </p>
            </GroupBlock>
            {surfaces.map((surface) => (
              <SurfaceGuide key={surface.id} surface={surface} integrations={integrations} data={state.data} />
            ))}
            <GroupBlock>
              <p className="text-meta text-tertiary">Platform requirements last checked {VERIFIED_ON}. Vendors change plans and settings; their documentation is authoritative.</p>
            </GroupBlock>
          </SectionStack>

          <ProjectMemoryPanel data={state.data} />
          <ActivityList data={state.data} now={now} />

          {state.data.legacyTokens.length > 0 && (
            <>
              <GroupLabel>Older Claude Desktop tokens</GroupLabel>
              <SectionStack className="mb-6">
                <ul className="divide-y divide-subtle">
                  {state.data.legacyTokens.map((token) => (
                    <li key={token.id} className="flex items-center justify-between gap-3 px-4 py-2">
                      <p className="min-w-0 truncate text-body-sm text-foreground">
                        {token.name} <span className="text-muted-foreground">· read-only, every synced workspace · …{token.hint}</span>
                      </p>
                      <Button type="button" size="sm" variant="outline" disabled={integrations.busy === `legacy:${token.id}`} onClick={() => void integrations.revokeLegacyToken(token.id)}>
                        Revoke
                      </Button>
                    </li>
                  ))}
                </ul>
              </SectionStack>
            </>
          )}
        </>
      )}
    </div>
  )
}
