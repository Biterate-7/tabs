"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"
import { ProviderMark } from "@/components/memory/provider-mark"
import { FieldRow, GroupBlock, GroupLabel, SectionHeading, SectionStack } from "./section-ui"
import { DEFAULT_INTELLIGENCE_SETTINGS, isProviderAnalyzed, loadIntelligenceSettings, saveIntelligenceSettings, setProviderAnalyzed } from "@/lib/conversations/intelligence/settings"
import { EMBEDDING_MODEL } from "@/lib/conversations/intelligence/semantic"
import { EMBEDDINGS, clearDerived, derivedOwner, derivedSize } from "@/lib/conversations/intelligence/store"
import { AI_PROVIDER_IDS, AI_PROVIDERS } from "@/lib/providers/registry"
import type { IntelligenceSettings } from "@/lib/conversations/intelligence/settings"
import type { AiProviderId } from "@/lib/providers/registry"

/** How a provider's conversations can reach Hubble, from the registry's own claims. */
function ingestionWords(id: AiProviderId): string {
  const { pageCapture, exportImport, autoSync } = AI_PROVIDERS[id].capabilities
  const ways = [pageCapture.supported ? "save from the page (Hubble for Chrome)" : undefined, exportImport.supported ? `import ${AI_PROVIDERS[id].exportFile ?? "its export"}` : undefined].filter(Boolean)
  return `${ways.length > 0 ? `Comes in by: ${ways.join(", or ")}.` : "No way to bring conversations in yet."} ${autoSync.supported ? "" : "No automatic sync — save again to update."}`.trim()
}

/**
 * Settings → Conversations: what Hubble reads from saved AI conversations,
 * and the person's control over it. Two different things are kept apart on
 * purpose:
 *
 *   stop analysing   (here) Hubble stops reading them for decisions, tasks,
 *                    threads; every saved conversation stays saved
 *   delete           (on the conversation) removes it from Hubble, and
 *                    everything Hubble read from it goes with it
 */
export function ConversationIntelligenceSection({ onOpenAiApps }: { onOpenAiApps?: () => void }) {
  const [settings, setSettings] = useState<IntelligenceSettings>(() => loadIntelligenceSettings())
  const update = (next: IntelligenceSettings) => {
    setSettings(next)
    if (!saveIntelligenceSettings(next)) toast.error("This browser didn't keep the change.")
  }
  const corrections = Object.keys(settings.facts).length + settings.unrelated.length + settings.related.length + settings.dismissed.length
  // What Hubble keeps on this device from its analysis — shown so the person can see it, and delete the vectors.
  const [stored, setStored] = useState<{ extractions: number; embeddings: number; bytes: number } | null>(null)
  const [refresh, setRefresh] = useState(0)
  useEffect(() => {
    let cancelled = false
    derivedSize(derivedOwner())
      .then((size) => {
        if (!cancelled) setStored(size)
      })
      .catch(() => undefined)
    return () => {
      cancelled = true
    }
  }, [refresh])
  const forgetVectors = async () => {
    await clearDerived(EMBEDDINGS, derivedOwner()).catch(() => 0)
    setRefresh((value) => value + 1)
    toast.success("Deleted the stored meaning data.")
  }

  return (
    <div>
      <SectionHeading
        title="Conversations"
        description="Hubble reads the AI conversations you saved — what you decided, what's still open, how they connect across apps. It runs on this device; nothing is sent anywhere."
      />

      <SectionStack>
        <FieldRow label="Analyse saved conversations" description="Off keeps every conversation saved and searchable — Hubble just stops reading them for decisions, tasks and threads.">
          <Switch aria-label="Analyse saved conversations" checked={settings.enabled} onCheckedChange={(checked) => update({ ...settings, enabled: checked })} />
        </FieldRow>
        <FieldRow
          label="Compare by meaning"
          description={`Links conversations about the same thing even when they use different words. Hubble downloads a small model (${EMBEDDING_MODEL.name}, about ${EMBEDDING_MODEL.approxDownloadMB} MB) from Hugging Face once and runs it on this device — your conversations are never sent anywhere. Not available in the desktop app yet.`}
        >
          <Switch aria-label="Compare conversations by meaning" checked={settings.semantic} disabled={!settings.enabled} onCheckedChange={(checked) => update({ ...settings, semantic: checked })} />
        </FieldRow>
        <FieldRow
          label="Kept on this device"
          description={
            stored === null
              ? "Checking…"
              : `Analysis of ${stored.extractions} conversation${stored.extractions === 1 ? "" : "s"}${stored.embeddings > 0 ? `, meaning data for ${stored.embeddings}` : ""} — about ${Math.max(1, Math.round(stored.bytes / 1024))} KB. Kept so unchanged conversations are never analysed twice; deleted with their conversations.`
          }
        >
          <Button type="button" variant="secondary" size="sm" disabled={!stored || stored.embeddings === 0} onClick={() => void forgetVectors()}>
            Delete meaning data
          </Button>
        </FieldRow>
      </SectionStack>

      <GroupLabel className="mt-6">By AI app</GroupLabel>
      <SectionStack>
        {AI_PROVIDER_IDS.map((id) => (
          <FieldRow key={id} label={AI_PROVIDERS[id].name} description={ingestionWords(id)}>
            <span className="flex items-center gap-3">
              <ProviderMark provider={id} size={14} />
              <Switch aria-label={`Analyse ${AI_PROVIDERS[id].name} conversations`} checked={isProviderAnalyzed(settings, id)} disabled={!settings.enabled} onCheckedChange={(checked) => update(setProviderAnalyzed(settings, id, checked))} />
            </span>
          </FieldRow>
        ))}
        <FieldRow label="Grok" description="Not supported yet: Hubble has no reader for grok.com conversations and hasn't verified xAI's data export. Grok can read Hubble through AI connectors.">
          <span className="text-meta text-tertiary">Unavailable</span>
        </FieldRow>
        {onOpenAiApps && (
          <GroupBlock>
            <button type="button" className="text-body-sm text-link hover:underline" onClick={onOpenAiApps}>
              What each AI app supports, and how it was checked
            </button>
          </GroupBlock>
        )}
      </SectionStack>

      <GroupLabel className="mt-6">Your corrections</GroupLabel>
      <SectionStack>
        <FieldRow label="Left out of analysis" description={settings.excluded.length === 0 ? "No conversations. Leave one out from its page in Conversations." : `${settings.excluded.length} conversation${settings.excluded.length === 1 ? "" : "s"} — still saved, not analysed.`}>
          <Button type="button" variant="secondary" size="sm" disabled={settings.excluded.length === 0} onClick={() => update({ ...settings, excluded: [] })}>
            Include all again
          </Button>
        </FieldRow>
        <FieldRow label="Corrections and dismissals" description={corrections === 0 ? "None yet. Correct a decision or task from its conversation." : `${corrections} — things you confirmed, removed, marked related or unrelated, or dismissed.${Object.keys(settings.reviews).length > 0 ? ` Plus ${Object.keys(settings.reviews).length} answers from checking Hubble's links.` : ""}`}>
          <Button type="button" variant="secondary" size="sm" disabled={corrections === 0} onClick={() => update({ ...DEFAULT_INTELLIGENCE_SETTINGS, enabled: settings.enabled, providers: settings.providers, excluded: settings.excluded, semantic: settings.semantic })}>
            Forget them
          </Button>
        </FieldRow>
        <GroupBlock>
          <p className="text-body-sm text-muted-foreground">
            To delete a conversation from Hubble, open it in Conversations and choose Delete. Its messages, and everything Hubble read from them — decisions, tasks, memories, threads and your corrections — go with it.
          </p>
        </GroupBlock>
      </SectionStack>
    </div>
  )
}
