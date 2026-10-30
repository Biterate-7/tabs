"use client"

import { useState } from "react"
import { Radar, X } from "lucide-react"
import { toast } from "sonner"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog"
import { IconButton } from "@/components/ui/icon-button"
import { ProviderMark } from "@/components/memory/provider-mark"
import { enableConversationReading, saveSettings } from "@/lib/intelligence/settings-store"
import { SENSITIVE_SUMMARY, SITE_CATEGORY_LABEL } from "@/lib/intelligence/sites"
import { SITE_CATEGORIES } from "@/lib/intelligence/types"
import { AI_PROVIDER_IDS, aiProviderName } from "@/lib/providers/registry"
import { cn } from "@/lib/utils"
import type { AiProviderId } from "@/lib/providers/registry"
import type { DetectionMode, SiteCategory } from "@/lib/intelligence/types"

/**
 * The first-run choice, once Hubble for Chrome is connected: whether Hubble
 * may notice the work done in Chrome, and how much. Three plain choices, each
 * saying what it collects; nothing is detected before one is made, and
 * "Manual" leaves every existing flow exactly as it was.
 *
 * What it says is what the extension does (extension/src/context-activity.js):
 * addresses and titles only, kept in this browser; a conversation's text is
 * read only for an app the person ticks here AND allows in Chrome's own
 * window, and only topic words are kept from it until they accept a
 * suggestion. Nothing goes to an AI service.
 */

const MODES: { value: DetectionMode; title: string; body: string }[] = [
  { value: "auto", title: "Automatic", body: "Notice the pages and AI chats you use and suggest where they belong. Sensitive sites are always skipped." },
  { value: "sites", title: "Only sites I choose", body: "Notice only the kinds of site you pick below." },
  { value: "off", title: "Manual", body: "Hubble notices nothing. You save things yourself, as now." },
]

/** Home's one-line invitation, shown until the person chooses or says "later". */
export function ContextSetupCard({ onSetUp, onLater }: { onSetUp: () => void; onLater: () => void }) {
  return (
    <section aria-label="Context detection" className="mt-5 flex min-w-0 items-center gap-3 rounded-lg border border-subtle bg-card px-4 py-3 animate-enter">
      <Radar aria-hidden className="size-4 shrink-0 text-muted-foreground" />
      <p className="min-w-0 flex-1 text-body-sm text-foreground">
        Let Hubble notice your research and AI chats, suggest which project they belong to, and help you pick work up again.
      </p>
      <Button type="button" size="sm" variant="secondary" onClick={onSetUp}>
        Set up
      </Button>
      <IconButton aria-label="Not now" tooltip="Not now" onClick={onLater}>
        <X />
      </IconButton>
    </section>
  )
}

export function ContextOnboardingDialog({ open, onOpenChange, onDone }: { open: boolean; onOpenChange: (open: boolean) => void; onDone?: (mode: DetectionMode) => void }) {
  return <Dialog open={open} onOpenChange={onOpenChange}>{open && <OnboardingBody onClose={() => onOpenChange(false)} {...(onDone ? { onDone } : {})} />}</Dialog>
}

function OnboardingBody({ onClose, onDone }: { onClose: () => void; onDone?: (mode: DetectionMode) => void }) {
  const [mode, setMode] = useState<DetectionMode>("auto")
  const [categories, setCategories] = useState<Set<SiteCategory>>(() => new Set<SiteCategory>(["ai", "docs", "research"]))
  const [readers, setReaders] = useState<Set<AiProviderId>>(() => new Set())
  const [saving, setSaving] = useState(false)

  const toggle = <T,>(set: Set<T>, value: T): Set<T> => {
    const next = new Set(set)
    if (next.has(value)) next.delete(value)
    else next.add(value)
    return next
  }

  async function confirm() {
    setSaving(true)
    try {
      const saved = await saveSettings({
        mode,
        decidedAt: Date.now(),
        categories: [...categories],
        readConversations: [],
        paused: false,
      })
      if (!saved.ok) {
        toast.error("Couldn't save your choice", { description: saved.error === "needs-update" ? "Update Hubble for Chrome, then try again." : "Hubble for Chrome didn't answer. Nothing was turned on." })
        return
      }
      // Each app's access is asked for in Chrome's own window, one at a time; a "no" there leaves that app off.
      let current = saved.value.settings
      const refused: string[] = []
      if (mode !== "off") {
        for (const provider of readers) {
          const result = await enableConversationReading(provider, current)
          if (!result.granted) refused.push(aiProviderName(provider))
          current = { ...current, readConversations: [...new Set([...current.readConversations, provider])] }
        }
      }
      toast.success(mode === "off" ? "Manual mode — Hubble won't detect anything" : "Context detection is on", {
        description:
          refused.length > 0
            ? `Chrome didn't allow reading ${refused.join(" and ")}. Their pages are still noticed by title. You can allow it in Settings.`
            : mode === "off"
              ? "Change this any time in Settings → Context."
              : "Suggestions appear on Home as you work. Pause or change this in Settings → Context.",
      })
      onDone?.(mode)
      onClose()
    } finally {
      setSaving(false)
    }
  }

  return (
    <DialogContent className="sm:max-w-lg">
      <DialogHeader>
        <DialogTitle>Keep your work connected</DialogTitle>
        <DialogDescription>Hubble can notice the pages, documents and AI chats you use in Chrome, suggest which project they belong to, and help you pick up where you left off.</DialogDescription>
      </DialogHeader>

      <div className="flex min-w-0 flex-col gap-4">
        <div role="radiogroup" aria-label="Detection" className="flex flex-col gap-1.5">
          {MODES.map((entry) => {
            const selected = mode === entry.value
            return (
              <button
                key={entry.value}
                type="button"
                role="radio"
                aria-checked={selected}
                onClick={() => setMode(entry.value)}
                className={cn(
                  "flex min-w-0 items-start gap-3 rounded-md border px-3 py-2.5 text-left outline-none transition-[border-color,background-color] duration-(--duration-fast) ease-(--ease-color) focus-visible:ring-2 focus-visible:ring-ring/60",
                  selected ? "border-strong bg-surface-selected" : "border-subtle hover:bg-surface-hover"
                )}
              >
                <span aria-hidden className={cn("mt-1 size-3 shrink-0 rounded-full border", selected ? "border-[5px] border-foreground" : "border-strong")} />
                <span className="min-w-0">
                  <span className="block text-body text-foreground">{entry.title}</span>
                  <span className="block text-body-sm text-muted-foreground">{entry.body}</span>
                </span>
              </button>
            )
          })}
        </div>

        {mode === "sites" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-label text-muted-foreground">Sites</legend>
            {SITE_CATEGORIES.map((category) => (
              <div key={category} className="flex items-start gap-2.5">
                <Checkbox className="mt-0.5" checked={categories.has(category)} onCheckedChange={() => setCategories((current) => toggle(current, category))} aria-label={SITE_CATEGORY_LABEL[category].name} />
                <div className="min-w-0 cursor-default" onClick={() => setCategories((current) => toggle(current, category))}>
                  <p className="text-body-sm text-foreground">{SITE_CATEGORY_LABEL[category].name}</p>
                  <p className="text-meta text-tertiary">{SITE_CATEGORY_LABEL[category].examples}</p>
                </div>
              </div>
            ))}
          </fieldset>
        )}

        {mode !== "off" && (
          <fieldset className="flex flex-col gap-2">
            <legend className="mb-1 text-label text-muted-foreground">Read conversations to match them (optional)</legend>
            <p className="text-meta text-tertiary">Without this, a chat is matched by its title. With it, Hubble for Chrome reads an open chat and keeps only its topic words. Chrome asks you to allow each app.</p>
            <div className="flex flex-wrap gap-1.5">
              {AI_PROVIDER_IDS.map((provider) => {
                const on = readers.has(provider)
                return (
                  <button
                    key={provider}
                    type="button"
                    aria-pressed={on}
                    onClick={() => setReaders((current) => toggle(current, provider))}
                    className={cn(
                      "flex h-7 items-center gap-1.5 rounded-full border px-2.5 text-body-sm outline-none focus-visible:ring-2 focus-visible:ring-ring/60",
                      on ? "border-strong bg-surface-selected text-foreground" : "border-subtle text-muted-foreground hover:text-foreground"
                    )}
                  >
                    <ProviderMark provider={provider} size={12} /> {aiProviderName(provider)}
                  </button>
                )
              })}
            </div>
          </fieldset>
        )}

        <ul className="flex flex-col gap-1 rounded-md bg-surface-hover px-3 py-2.5 text-meta text-muted-foreground">
          <li>Kept: addresses, titles, icons and when you used them — in this browser only.</li>
          <li>Never kept: {SENSITIVE_SUMMARY.toLowerCase()}; private windows; passwords or anything you type.</li>
          <li>Nothing is sent to an AI service. Matching runs in this browser; pages are read like any source only after you save them.</li>
        </ul>
      </div>

      <DialogFooter>
        <Button type="button" variant="ghost" onClick={onClose} disabled={saving}>
          Later
        </Button>
        <Button type="button" onClick={() => void confirm()} disabled={saving || (mode === "sites" && categories.size === 0)}>
          {saving ? "Saving…" : mode === "off" ? "Use manual mode" : "Turn on"}
        </Button>
      </DialogFooter>
    </DialogContent>
  )
}
