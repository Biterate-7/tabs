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
import { AI_PROVIDERS, AI_PROVIDER_IDS } from "@/lib/providers/registry"
import { loadCollectionState } from "@/lib/collections/persistence"
import { loadDependencyState } from "@/lib/dependencies/persistence"
import { getProjectContents } from "@/lib/resources/content-store"
import { buildWorkspaceExport, downloadJsonFile, serializeWorkspaceExport } from "@/lib/workspace/json-export"
import { deleteLegacyAgentData, exportLegacyAgentData, findLegacyAgentData, hasLegacyAgentData } from "@/lib/storage/legacy-agent-data"
import { FieldRow, GroupBlock, GroupLabel, SectionHeading, SectionStack } from "./section-ui"
import type { ProviderCapabilities, ProviderCapability } from "@/lib/providers/registry"
import type { ResourceContent } from "@/lib/resources/types"
import type { Workspace } from "@/lib/workspace/types"

const CAPABILITY_ROWS: { key: keyof ProviderCapabilities; label: string }[] = [
  { key: "pageCapture", label: "Save the open conversation (Hubble for Chrome)" },
  { key: "exportImport", label: "Import the app's data export" },
  { key: "paste", label: "Paste a conversation" },
  { key: "insert", label: "Type context into the message box" },
  { key: "connector", label: "The app reads Hubble (MCP connector)" },
  { key: "autoSync", label: "Keep saved conversations up to date automatically" },
]

const VERIFIED_WORDS: Record<ProviderCapability["verified"], string> = {
  fixture: "Tested against saved sample pages and files, not the live app",
  protocol: "Tested over the connector protocol, not yet with the vendor's app",
  none: "",
}

/**
 * Settings → AI apps: what Hubble can do with each AI app, as the provider
 * registry records it — including what it cannot, and how each claim was
 * tested. Nothing here is a toggle; it is the honest answer to "will this
 * work with the app I use?".
 */
export function AiAppsSection() {
  return (
    <div>
      <SectionHeading
        title="AI apps"
        description="Hubble keeps what you learn in ChatGPT, Claude, Gemini and Perplexity in one place. It never signs in to these apps or reads your account: it saves the conversation on screen when you ask, or a file you exported yourself."
      />
      <div className="flex flex-col gap-6">
        {AI_PROVIDER_IDS.map((id) => {
          const provider = AI_PROVIDERS[id]
          return (
            <section key={id} aria-label={provider.name} data-provider-capabilities={id}>
              <GroupLabel className="flex items-center gap-1.5">
                <ProviderMark provider={id} size={14} /> {provider.name}
              </GroupLabel>
              <SectionStack>
                {CAPABILITY_ROWS.map(({ key, label }) => {
                  const capability = provider.capabilities[key]
                  return (
                    <div key={key} className="flex items-start gap-3 px-4 py-2.5" data-capability={key} data-supported={capability.supported}>
                      {capability.supported ? (
                        <Check aria-label="Available" className="mt-0.5 size-4 shrink-0 text-foreground" />
                      ) : (
                        <Minus aria-label="Not available" className="mt-0.5 size-4 shrink-0 text-tertiary" />
                      )}
                      <div className="min-w-0">
                        <p className="text-body-sm text-foreground">{label}</p>
                        <p className="text-meta text-muted-foreground">{capability.note}</p>
                        {capability.supported && VERIFIED_WORDS[capability.verified] && <p className="text-meta text-tertiary">{VERIFIED_WORDS[capability.verified]}</p>}
                      </div>
                    </div>
                  )
                })}
              </SectionStack>
            </section>
          )
        })}
      </div>
      <p className="mt-6 text-body-sm text-muted-foreground">
        AI apps change their pages without notice. If saving from a page stops working, Hubble says so — paste the conversation instead, and it is kept the same way.
      </p>
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
      <SectionHeading title="Data" description="Where your knowledge is kept, and how to take it with you." />
      <SectionStack className="mb-6">
        <FieldRow label="On this device" description="Projects, saved conversations, notes and the text Hubble read from pages are kept in this browser. Signing in syncs projects, page titles and links between your devices — not conversation text or notes.">
          <span />
        </FieldRow>
        <FieldRow label="Export everything" description="Every project with its notes, saved conversations and read text, as one JSON file. Import it in Settings → Projects.">
          <Button type="button" size="sm" disabled={busy} onClick={() => void exportAll(true)}>
            <Download /> Export
          </Button>
        </FieldRow>
        <FieldRow label="Export projects only" description="Projects, links, collections and note titles — without saved text. Smaller.">
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
                Earlier versions of Hubble ran AI agents. Their records are still in this browser: {legacy.keys.length} stored list{legacy.keys.length === 1 ? "" : "s"}
                {legacy.projectEvents > 0 ? ` and ${legacy.projectEvents} entries in project history` : ""}. Hubble no longer uses them.
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
