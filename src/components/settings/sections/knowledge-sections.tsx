"use client"

import { useState } from "react"
import { Check, Download, Minus, Trash2 } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
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
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"
import { AI_PROVIDERS, AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { loadCollectionState } from "@/lib/collections/persistence"
import { loadDependencyState } from "@/lib/dependencies/persistence"
import { getProjectContents } from "@/lib/resources/content-store"
import { buildWorkspaceExport, downloadJsonFile, serializeWorkspaceExport } from "@/lib/workspace/json-export"
import { deleteLegacyAgentData, exportLegacyAgentData, findLegacyAgentData, hasLegacyAgentData } from "@/lib/storage/legacy-agent-data"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { FieldRow, GroupBlock, GroupLabel, SectionHeading, SectionStack } from "./section-ui"
import type { ProviderCapabilities, ProviderCapability } from "@/lib/providers/registry"
import type { ResourceContent } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

const CAPABILITY_ROWS: { key: keyof ProviderCapabilities; label: string }[] = [
  { key: "pageCapture", label: "Save from the page" },
  { key: "exportImport", label: "Import an export" },
  { key: "paste", label: "Paste a conversation" },
  { key: "insert", label: "Type into the chat box" },
  { key: "attachFiles", label: "Attach uploaded files" },
  { key: "autoSubmit", label: "Send automatically (when chosen)" },
  { key: "connector", label: "AI connector (MCP)" },
  { key: "autoSync", label: "Keep in sync automatically" },
]

const VERIFIED_WORDS: Record<ProviderCapability["verified"], string> = {
  fixture: "Tested against saved sample pages and files, not the live app.",
  protocol: "Tested over the connector protocol, not yet with the vendor's app.",
  none: "",
}

/**
 * Settings → AI apps: what Hubble can do with each AI app, as the provider
 * registry records it — including what it cannot, and how each claim was
 * tested. One mark per app and capability; the registry's note and how it
 * was tested are a focus or hover away, never a wall of text. Nothing here
 * is a toggle.
 */
export function AiAppsSection() {
  return (
    <div>
      <SectionHeading title="AI apps" description="Hubble never signs in to these apps. It saves a conversation only when you ask." />
      <div className="overflow-x-auto rounded-md border border-border bg-card">
        <table className="w-full border-collapse text-body-sm">
          <thead>
            <tr className="border-b border-subtle">
              <th scope="col" className="px-4 py-2.5 text-left text-label font-normal text-muted-foreground">
                <span className="sr-only">Capability</span>
              </th>
              {AI_PROVIDER_IDS.map((id) => (
                <th key={id} scope="col" className="px-2 py-2.5 text-center font-normal text-muted-foreground" data-provider-capabilities={id}>
                  <span className="inline-flex items-center gap-1.5">
                    <ProviderMark provider={id} size={14} />
                    <span className="max-sm:sr-only">{AI_PROVIDERS[id].name}</span>
                  </span>
                </th>
              ))}
            </tr>
          </thead>
          <tbody className="divide-y divide-subtle">
            {CAPABILITY_ROWS.map(({ key, label }) => (
              <tr key={key} data-capability={key}>
                <th scope="row" className="px-4 py-2 text-left font-normal text-foreground">
                  {label}
                </th>
                {AI_PROVIDER_IDS.map((id) => {
                  const capability = AI_PROVIDERS[id].capabilities[key]
                  const detail = [capability.note, capability.supported ? VERIFIED_WORDS[capability.verified] : "", capability.liveCheck ?? ""].filter(Boolean).join(" ")
                  const state = capability.supported ? "Available" : "Not available"
                  const spoken = detail.startsWith(state) ? detail : `${state}. ${detail}`.trim()
                  return (
                    <td key={id} className="px-2 py-1 text-center" data-supported={capability.supported}>
                      <Tooltip>
                        <TooltipTrigger
                          render={
                            <button
                              type="button"
                              aria-label={`${AI_PROVIDERS[id].name}: ${label} — ${spoken}`}
                              className="inline-flex size-7 items-center justify-center rounded-xs outline-none hover:bg-surface-hover focus-visible:ring-2 focus-visible:ring-ring/60"
                            >
                              {capability.supported ? <Check aria-hidden className="size-4 text-foreground" /> : <Minus aria-hidden className="size-4 text-tertiary" />}
                            </button>
                          }
                        />
                        <TooltipContent>{detail || state}</TooltipContent>
                      </Tooltip>
                    </td>
                  )
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="mt-3 text-meta text-tertiary">If saving from a page stops working, paste the conversation instead.</p>
    </div>
  )
}

function today(): string {
  return new Date().toISOString().slice(0, 10)
}

/**
 * Settings → Data: what is stored on this device, a complete export, and
 * the records the removed AI agent features left behind.
 */
export function DataSection({ workspaces }: { workspaces: readonly Workspace[] }) {
  const [busy, setBusy] = useState(false)
  const isDesktop = useIsDesktop()
  const [legacy, setLegacy] = useState(() => (typeof window === "undefined" ? null : findLegacyAgentData()))

  async function exportAll(includeText: boolean) {
    setBusy(true)
    try {
      let contents: Map<string, Map<string, ResourceContent>> | undefined
      if (includeText) {
        contents = new Map()
        for (const workspace of workspaces) contents.set(workspace.id, await getProjectContents(workspace.id))
      }
      const text = serializeWorkspaceExport(buildWorkspaceExport([...workspaces], loadDependencyState().dependencies, loadCollectionState().collections, contents))
      const saved = await downloadJsonFile(`hubble-${includeText ? "everything" : "projects"}-${today()}.json`, text)
      if (saved) toast.success(includeText ? "Exported your projects with their saved text" : "Exported your projects")
    } catch {
      toast.error("Couldn't export", { description: "Nothing was saved. Try again." })
    } finally {
      setBusy(false)
    }
  }

  async function exportLegacy() {
    const saved = await downloadJsonFile(`hubble-agent-records-${today()}.json`, exportLegacyAgentData())
    if (saved) toast.success("Saved the old AI agent records")
  }

  return (
    <div>
      <SectionHeading title="Data" />
      <SectionStack className="mb-6">
        <FieldRow
          label="On this device"
          description={
            isDesktop
              ? "Everything is kept in this app on this computer."
              : "Everything is kept in this browser. Signing in syncs titles and links — not conversation text or notes."
          }
        >
          <span />
        </FieldRow>
        <FieldRow label="Export everything" description="All projects with their text, as one JSON file.">
          <Button type="button" size="sm" disabled={busy} onClick={() => void exportAll(true)}>
            <Download /> Export
          </Button>
        </FieldRow>
        <FieldRow label="Export projects only" description="Links, collections and titles, without text.">
          <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void exportAll(false)}>
            <Download /> Export
          </Button>
        </FieldRow>
      </SectionStack>

      {legacy && hasLegacyAgentData(legacy) && (
        <>
          <GroupLabel>Records from removed AI agent features</GroupLabel>
          <SectionStack>
            <GroupBlock>
              <p className="text-body-sm text-foreground">
                {legacy.keys.length} stored list{legacy.keys.length === 1 ? "" : "s"}
                {legacy.projectEvents > 0 ? ` and ${legacy.projectEvents} project history entries` : ""} from earlier AI agent features. Hubble no longer uses them.
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <Button type="button" size="sm" variant="outline" onClick={() => void exportLegacy()}>
                  <Download /> Download them
                </Button>
                <AlertDialog>
                  <AlertDialogTrigger render={<Button type="button" size="sm" variant="ghost" className="text-destructive" />}>
                    <Trash2 /> Delete them
                  </AlertDialogTrigger>
                  <AlertDialogContent>
                    <AlertDialogHeader>
                      <AlertDialogTitle>Delete the old AI agent records?</AlertDialogTitle>
                      <AlertDialogDescription>
                        This removes the agent runs, sessions, folder permissions and agent history entries from this browser. Your projects, conversations and notes are not touched. Download them first if you want to keep them — this can&apos;t be undone.
                      </AlertDialogDescription>
                    </AlertDialogHeader>
                    <AlertDialogFooter>
                      <AlertDialogCancel>Cancel</AlertDialogCancel>
                      <AlertDialogAction
                        variant="destructive"
                        onClick={() => {
                          const removed = deleteLegacyAgentData()
                          setLegacy(findLegacyAgentData())
                          toast(removed > 0 ? "Deleted the old AI agent records" : "Nothing was deleted")
                        }}
                      >
                        Delete
                      </AlertDialogAction>
                    </AlertDialogFooter>
                  </AlertDialogContent>
                </AlertDialog>
              </div>
            </GroupBlock>
          </SectionStack>
        </>
      )}
    </div>
  )
}
