"use client"

import { useEffect, useState } from "react"
import { X } from "lucide-react"
import { toast } from "sonner"
import { AlertDialog, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from "@/components/ui/alert-dialog"
import { Badge } from "@/components/ui/badge"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import { IconButton } from "@/components/ui/icon-button"
import { Input } from "@/components/ui/input"
import { SegmentedControl } from "@/components/ui/segmented-control"
import { Switch } from "@/components/ui/switch"
import { ProviderMark } from "@/components/memory/provider-mark"
import { ActivityRow } from "@/components/intelligence/activity-row"
import { ContextOnboardingDialog } from "@/components/intelligence/context-onboarding"
import { useContextSettingsView, useContextState } from "@/hooks/use-context-intelligence"
import { useBrowserConnected } from "@/hooks/use-tab-sessions"
import { useIsDesktop } from "@/hooks/use-is-desktop"
import { useNow } from "@/hooks/use-now"
import { clearActivity, forgetActivity } from "@/lib/intelligence/bridge"
import { forgetRecords } from "@/lib/intelligence/decisions"
import { writeContext } from "@/lib/intelligence/persistence"
import { enableConversationReading, refreshSettings, saveSettings } from "@/lib/intelligence/settings-store"
import { SENSITIVE_SUMMARY, SITE_CATEGORY_LABEL, cleanExcludedHost } from "@/lib/intelligence/sites"
import { clearContext } from "@/lib/intelligence/sync"
import { RETENTION_CHOICES, SITE_CATEGORIES } from "@/lib/intelligence/types"
import { AI_PROVIDER_IDS, aiProviderName } from "@/lib/providers/registry"
import { formatRelativeTime } from "@/lib/time-format"
import type { ContextSettings, DetectionMode, RetentionDays, SuggestionPreference } from "@/lib/intelligence/types"
import type { AiProviderId } from "@/lib/providers/registry"
import { FieldRow, GroupBlock, GroupLabel, SectionHeading, SectionStack } from "./section-ui"

/**
 * Settings → Context: every choice about context detection, and every
 * record it kept. The extension enforces the choices, so each change is
 * shown only once it has answered; with it missing, the pane says so and
 * still lets the person clear what Hubble holds.
 */

const MODE_OPTIONS: { value: DetectionMode; label: string }[] = [
  { value: "off", label: "Manual" },
  { value: "sites", label: "Chosen sites" },
  { value: "auto", label: "Automatic" },
]

const PREFERENCE_OPTIONS: { value: SuggestionPreference; label: string }[] = [
  { value: "all", label: "Normal" },
  { value: "strong", label: "Only strong" },
  { value: "off", label: "Off" },
]

const HOUR = 60 * 60 * 1000

export function ContextSection() {
  const isDesktop = useIsDesktop()
  const connected = useBrowserConnected()
  const view = useContextSettingsView()
  const state = useContextState()
  const [busy, setBusy] = useState(false)
  const [host, setHost] = useState("")
  const [confirmClear, setConfirmClear] = useState(false)
  const [onboarding, setOnboarding] = useState(false)
  const now = useNow()

  useEffect(() => {
    if (connected) void refreshSettings()
  }, [connected])

  const value = view.status === "ready" ? view.value : view.status === "loading" || view.status === "unavailable" ? view.last : undefined
  const settings = value?.settings
  // A timed pause ends by itself (the extension stops honouring it); the switch says so too.
  const paused = Boolean(settings?.paused && !(settings.pausedUntil && settings.pausedUntil <= now))

  async function change(patch: Partial<ContextSettings>) {
    setBusy(true)
    try {
      const answer = await saveSettings(patch)
      if (!answer.ok) toast.error("Couldn't change that", { description: answer.error === "needs-update" ? "Update Hubble for Chrome, then try again." : "Hubble for Chrome didn't answer. Nothing changed." })
      return answer.ok
    } finally {
      setBusy(false)
    }
  }

  async function toggleReading(provider: AiProviderId, on: boolean) {
    if (!settings) return
    if (!on) {
      await change({ readConversations: settings.readConversations.filter((id) => id !== provider) })
      return
    }
    setBusy(true)
    try {
      const result = await enableConversationReading(provider, settings)
      if (!result.ok) toast.error(`Couldn't turn on reading ${aiProviderName(provider)}`)
      else if (!result.granted) toast(`Chrome didn't allow ${aiProviderName(provider)}`, { description: "Its chats are still matched by title. Try again to see Chrome's prompt." })
    } finally {
      setBusy(false)
    }
  }

  async function forget(keys: string[]) {
    const local = writeContext((current) => forgetRecords(current, keys, Date.now()))
    const remote = connected ? await forgetActivity(keys) : undefined
    if (!local.ok || (remote && !remote.ok)) toast.error("Couldn't remove everything", { description: !local.ok ? "This browser's storage refused the change." : "Hubble for Chrome didn't answer; it may show this again." })
  }

  async function clearAll() {
    setConfirmClear(false)
    const remote = connected ? await clearActivity() : undefined
    const local = writeContext(clearContext)
    if (!local.ok || (remote && !remote.ok)) {
      toast.error("Couldn't clear everything", { description: !local.ok ? "This browser's storage refused the change." : "Hubble for Chrome didn't answer. Its copy is still there — try again with it connected." })
      return
    }
    toast.success("Activity cleared", { description: "Your projects were not changed." })
  }

  const records = state.records
  const status: { label: string; tone: "success" | "default" } = isDesktop
    ? { label: "Chrome only", tone: "default" }
    : !connected
      ? { label: "Not connected", tone: "default" }
      : view.status === "unavailable" && view.error === "needs-update"
        ? { label: "Update needed", tone: "default" }
        : !settings
          ? { label: "Checking…", tone: "default" }
          : settings.mode === "off"
            ? { label: "Manual", tone: "default" }
            : paused
              ? { label: "Paused", tone: "default" }
              : { label: "On", tone: "success" }

  const editable = !isDesktop && connected && Boolean(settings) && !busy

  return (
    <div>
      <SectionHeading title="Context" description="Hubble can notice the work you do in Chrome, suggest which project it belongs to, and help you pick up where you left off." />

      <SectionStack className="mb-6">
        <FieldRow
          label="Context detection"
          description={
            isDesktop
              ? "Detection runs in Hubble for Chrome on the web. Open Hubble in Chrome to set it up."
              : !connected
                ? "Connect Hubble for Chrome to set this up."
                : view.status === "unavailable" && view.error === "needs-update"
                  ? "Your Hubble for Chrome is older than this feature. Download the latest from Settings → Chrome extension."
                  : settings?.decidedAt
                    ? `Chosen ${formatRelativeTime(settings.decidedAt, now)?.toLowerCase() ?? ""}.`
                    : "Not set up yet: nothing is detected."
          }
        >
          <Badge variant={status.tone === "success" ? "success" : "default"}>{status.label}</Badge>
        </FieldRow>
        {settings && !isDesktop && (
          <>
            <FieldRow label="Mode" description={settings.mode === "auto" ? "Any ordinary site, except sensitive ones and those you exclude." : settings.mode === "sites" ? "Only the kinds of site ticked below." : "Nothing is detected. Saving by hand works as always."} stacked>
              <SegmentedControl label="Mode" value={settings.mode} options={MODE_OPTIONS} onValueChange={(mode) => editable && void change({ mode, decidedAt: settings.decidedAt ?? Date.now() })} />
            </FieldRow>
            {settings.mode === "sites" && (
              <GroupBlock className="flex flex-col gap-2">
                {SITE_CATEGORIES.map((category) => {
                  const on = settings.categories.includes(category)
                  const flip = () => editable && void change({ categories: on ? settings.categories.filter((entry) => entry !== category) : [...settings.categories, category] })
                  return (
                    <div key={category} className="flex items-start gap-2.5">
                      <Checkbox className="mt-0.5" checked={on} disabled={!editable} onCheckedChange={flip} aria-label={SITE_CATEGORY_LABEL[category].name} />
                      <div className="min-w-0 cursor-default" onClick={flip}>
                        <p className="text-body-sm text-foreground">{SITE_CATEGORY_LABEL[category].name}</p>
                        <p className="text-meta text-tertiary">{SITE_CATEGORY_LABEL[category].examples}</p>
                      </div>
                    </div>
                  )
                })}
              </GroupBlock>
            )}
            {settings.mode !== "off" && (
              <FieldRow label="Pause detection" description={paused ? (settings.pausedUntil ? `Paused until ${new Date(settings.pausedUntil).toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" })}.` : "Paused until you turn it back on.") : "Stop noticing anything for now. What was kept stays."}>
                <span className="flex items-center gap-2">
                  {!paused && (
                    <Button type="button" size="sm" variant="ghost" disabled={!editable} onClick={() => void change({ paused: true, pausedUntil: Date.now() + HOUR })}>
                      For an hour
                    </Button>
                  )}
                  <Switch checked={paused} disabled={!editable} onCheckedChange={(checked) => void change({ paused: checked === true, ...(checked ? {} : { pausedUntil: undefined }) })} aria-label="Pause detection" />
                </span>
              </FieldRow>
            )}
          </>
        )}
        {settings && !settings.decidedAt && !isDesktop && (
          <GroupBlock>
            <Button type="button" size="sm" onClick={() => setOnboarding(true)}>
              Set up
            </Button>
          </GroupBlock>
        )}
      </SectionStack>

      {settings && !isDesktop && settings.mode !== "off" && (
        <>
          <GroupLabel>Read AI conversations</GroupLabel>
          <SectionStack className="mb-6">
            <GroupBlock>
              <p className="text-body-sm text-muted-foreground">Off: a chat is matched by its title. On: Hubble for Chrome reads an open chat a few seconds after it loads and keeps only its topic words, on this computer. Its text is saved only when you accept a suggestion.</p>
            </GroupBlock>
            {AI_PROVIDER_IDS.map((provider) => {
              const wanted = settings.readConversations.includes(provider)
              const granted = value?.granted.includes(provider) ?? false
              return (
                <FieldRow key={provider} label={aiProviderName(provider)} description={wanted ? (granted ? "Reading open chats." : "Waiting for Chrome's permission — turn it off and on to be asked again.") : granted ? "Chrome allows access (used by Use in AI); reading is off." : "Off."}>
                  <span className="flex items-center gap-2">
                    <ProviderMark provider={provider} size={14} />
                    <Switch checked={wanted} disabled={!editable} onCheckedChange={(checked) => void toggleReading(provider, checked === true)} aria-label={`Read ${aiProviderName(provider)} conversations`} />
                  </span>
                </FieldRow>
              )
            })}
          </SectionStack>
        </>
      )}

      <GroupLabel>Suggestions</GroupLabel>
      <SectionStack className="mb-6">
        <FieldRow label="How often" description="“Only strong” shows a suggestion only when the evidence is clear. “Off” keeps what is detected for Resume but suggests nothing." stacked>
          <SegmentedControl label="Suggestions" value={state.preference} options={PREFERENCE_OPTIONS} onValueChange={(preference) => writeContext((current) => ({ ...current, preference }))} />
        </FieldRow>
        <FieldRow label="How matching works" description="On this device, from the words pages, chats and your projects share, when you used them, and what you accepted or turned down before. No AI service is asked and nothing is sent.">
          <span />
        </FieldRow>
      </SectionStack>

      {settings && !isDesktop && (
        <>
          <GroupLabel>Never detect</GroupLabel>
          <SectionStack className="mb-6">
            <GroupBlock>
              <p className="text-body-sm text-muted-foreground">Always skipped: {SENSITIVE_SUMMARY.toLowerCase()}, and private windows.</p>
            </GroupBlock>
            {settings.excludedHosts.map((excluded) => (
              <div key={excluded} className="flex items-center justify-between gap-3 px-4 py-2">
                <span className="truncate text-body text-foreground">{excluded}</span>
                <IconButton aria-label={`Detect ${excluded} again`} disabled={!editable} onClick={() => void change({ excludedHosts: settings.excludedHosts.filter((entry) => entry !== excluded) })}>
                  <X />
                </IconButton>
              </div>
            ))}
            <GroupBlock>
              <form
                className="flex gap-2"
                onSubmit={(event) => {
                  event.preventDefault()
                  const cleaned = cleanExcludedHost(host)
                  if (!cleaned) {
                    toast.error("That isn't a site address", { description: "Type a site like example.com." })
                    return
                  }
                  void change({ excludedHosts: [...new Set([...settings.excludedHosts, cleaned])] }).then((ok) => ok && setHost(""))
                }}
              >
                <Input value={host} onChange={(event) => setHost(event.target.value)} placeholder="example.com" aria-label="Site to never detect" className="min-w-0 flex-1" />
                <Button type="submit" size="sm" variant="secondary" disabled={!editable || host.trim() === ""}>
                  Add
                </Button>
              </form>
              <p className="mt-1.5 text-meta text-tertiary">Adding a site also removes what was kept from it.</p>
            </GroupBlock>
          </SectionStack>

          <GroupLabel>Keep activity for</GroupLabel>
          <SectionStack className="mb-6">
            <FieldRow label="Retention" description="Older activity is removed automatically. Pages you saved to a project stay there." stacked>
              <SegmentedControl
                label="Retention"
                value={String(settings.retentionDays)}
                options={RETENTION_CHOICES.map((days) => ({ value: String(days), label: `${days} days` }))}
                onValueChange={(days) => editable && void change({ retentionDays: Number(days) as RetentionDays })}
              />
            </FieldRow>
          </SectionStack>
        </>
      )}

      <GroupLabel>Activity Hubble kept</GroupLabel>
      <SectionStack className="mb-6">
        {records.length === 0 ? (
          <GroupBlock>
            <p className="text-body-sm text-muted-foreground">Nothing yet.</p>
          </GroupBlock>
        ) : (
          <ul aria-label="Detected activity" className="flex max-h-96 flex-col divide-y divide-subtle overflow-y-auto">
            {records.slice(0, 100).map((record) => (
              <li key={record.key} className="px-4 py-2">
                <ActivityRow
                  record={record}
                  trailing={
                    <IconButton aria-label={`Remove ${record.title || record.domain}`} onClick={() => void forget([record.key])}>
                      <X />
                    </IconButton>
                  }
                />
              </li>
            ))}
          </ul>
        )}
        <GroupBlock className="flex items-center justify-between gap-3">
          <p className="text-body-sm text-muted-foreground">{records.length === 0 ? "Clear also removes your earlier answers to suggestions." : `${records.length} pages · Removing one doesn't touch your projects.`}</p>
          <Button type="button" size="sm" variant="destructive" onClick={() => setConfirmClear(true)}>
            Clear activity
          </Button>
        </GroupBlock>
      </SectionStack>

      <AlertDialog open={confirmClear} onOpenChange={setConfirmClear}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Clear all detected activity?</AlertDialogTitle>
            <AlertDialogDescription>
              Removes every page Hubble noticed, its suggestions and your answers to them, here and in Hubble for Chrome. Your projects, sources and sessions are not changed.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <Button type="button" variant="destructive" onClick={() => void clearAll()}>
              Clear activity
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
      <ContextOnboardingDialog open={onboarding} onOpenChange={setOnboarding} />
    </div>
  )
}
