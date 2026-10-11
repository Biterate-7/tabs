"use client"

import { useId, useState } from "react"
import { Check, ChevronDown, Loader2, Plus } from "lucide-react"
import { toast } from "sonner"
import { AgentIcon } from "@/components/agents/agent-icon"
import { Button } from "@/components/ui/button"
import { DesktopLink } from "@/components/command-centre/connect-agent-dialog"
import { CONNECTION_PHASE_LABEL, availableInDesktop } from "@/lib/agents/platform/lifecycle"
import { PLATFORM_PROVIDERS, platformProvider } from "@/lib/agents/platform/catalog"
import { aiConnectionState, aiName, aiRecoverySentence } from "@/lib/product/ai-vocabulary"
import { cn } from "@/lib/utils"
import type { UseAgentPlatform } from "@/hooks/use-agent-platform"
import type { AgentProviderId } from "@/lib/agents/connectors/types"

/**
 * AI Connections, the way a student reads them.
 *
 *     Claude      Connected ✓        [Test connection] [Reconnect]
 *     Gemini      Installed          [Connect →]
 *     Codex       Not detected       [Set up]
 *     Grok        Needs reconnecting [Fix connection]
 *                 We couldn't connect to Grok.   Details ▾
 *     + Connect AI
 *
 * Every state comes from the same platform hook the Command Centre and
 * Settings read (use-agent-platform.ts), which detects installed tools on
 * its own as soon as a runtime answers — so "Installed" is something Hubble
 * found, never something the student had to tell it. Every button opens the
 * same Connect flow (ConnectAgentDialog), already on the right step for that
 * AI. Nothing technical is shown unless "Details" is opened: there, the
 * precise phase and the runtime's own sentence, as before.
 *
 * An AI that runs on the student's own computer cannot be reached from the
 * web: its row says "Needs the desktop app" and links to Hubble's download
 * page — the same link, with the same honesty about whether a build is out,
 * as the Connect flow's (DesktopLink). Only for an AI that really does run
 * there (availableInDesktop); anything else unavailable just says so.
 */
export function AiConnectionsList({
  platform,
  onConnect,
  className,
}: {
  platform: UseAgentPlatform
  /** Opens the Connect flow for one AI — or, with no provider, its chooser. */
  onConnect: (provider?: AgentProviderId) => void
  className?: string
}) {
  return (
    <section aria-label="AI Connections" className={className}>
      <ul className="flex flex-col divide-y divide-subtle rounded-md border border-subtle">
        {PLATFORM_PROVIDERS.filter((spec) => spec.provider !== "custom").map((spec) => (
          <AiConnectionRow key={spec.provider} provider={spec.provider} platform={platform} onConnect={onConnect} />
        ))}
      </ul>
      <Button type="button" variant="ghost" size="sm" className="mt-2 -ml-2" onClick={() => onConnect()}>
        <Plus /> Connect AI
      </Button>
    </section>
  )
}

function AiConnectionRow({
  provider,
  platform,
  onConnect,
}: {
  provider: AgentProviderId
  platform: UseAgentPlatform
  onConnect: (provider?: AgentProviderId) => void
}) {
  const [details, setDetails] = useState(false)
  const [testing, setTesting] = useState(false)
  const nameId = useId()
  const stateId = useId()
  const describedBy = `${nameId} ${stateId}`
  const phase = platform.phaseOf(provider)
  const spec = platformProvider(provider)
  const needsDesktop = Boolean(spec && availableInDesktop(spec, phase, platform.surface))
  const base = aiConnectionState(phase)
  const state = needsDesktop ? { ...base, label: "Needs the desktop app" } : base
  const name = aiName(provider)
  const busy = testing || (platform.pending === provider && state.kind !== "connected")

  async function test() {
    setTesting(true)
    try {
      const ok = await platform.retry(provider)
      if (ok) toast.success(`${name} is working`)
      else toast.error(`${name} needs reconnecting`, { description: aiRecoverySentence(provider), action: { label: "Fix connection", onClick: () => onConnect(provider) } })
    } finally {
      setTesting(false)
    }
  }

  return (
    <li className="flex flex-col gap-1 px-4 py-3" data-ai-connection={provider} data-ai-state={state.kind}>
      <div className="flex min-w-0 items-center gap-3">
        <AgentIcon connector={provider} size="md" />
        <div className="min-w-0 flex-1">
          <p id={nameId} className="text-body text-foreground">
            {name}
          </p>
          <p
            id={stateId}
            className={cn(
              "flex items-center gap-1 text-meta",
              state.kind === "connected" ? "text-success" : state.kind === "broken" ? "text-destructive" : "text-tertiary"
            )}
          >
            {busy && <Loader2 aria-hidden className="size-3 animate-spin" />}
            {state.label}
            {state.kind === "connected" && <Check aria-hidden className="size-3" />}
          </p>
        </div>
        {state.kind === "connected" ? (
          <div className="flex shrink-0 items-center gap-1">
            <Button type="button" size="sm" variant="ghost" disabled={busy} aria-describedby={describedBy} onClick={() => void test()}>
              Test connection
            </Button>
            <Button type="button" size="sm" variant="outline" aria-describedby={describedBy} onClick={() => onConnect(provider)}>
              Reconnect
            </Button>
          </div>
        ) : needsDesktop && spec ? (
          <DesktopLink provider={spec} compact />
        ) : state.action ? (
          <Button
            type="button"
            size="sm"
            variant={state.kind === "installed" || state.kind === "broken" || state.kind === "needs-you" ? "default" : "outline"}
            className="shrink-0"
            disabled={busy}
            aria-describedby={describedBy}
            onClick={() => (state.action === "Details" ? setDetails((open) => !open) : onConnect(provider))}
          >
            {state.action}
            {state.kind === "installed" && " →"}
          </Button>
        ) : null}
      </div>
      {(state.kind === "broken" || state.kind === "unavailable") && (
        <div className="pl-10">
          {state.kind === "broken" && <p className="text-body-sm text-muted-foreground">{aiRecoverySentence(provider)}</p>}
          {state.kind === "broken" && (
            <button
              type="button"
              className="mt-0.5 flex items-center gap-0.5 text-meta text-tertiary hover:text-foreground"
              aria-expanded={details}
              onClick={() => setDetails((open) => !open)}
            >
              Details <ChevronDown aria-hidden className={cn("size-3 transition-transform", details && "rotate-180")} />
            </button>
          )}
          {details && (
            <p className="mt-1 text-meta text-tertiary" data-ai-connection-details>
              {CONNECTION_PHASE_LABEL[phase]} · {platform.sentenceOf(provider)}
            </p>
          )}
        </div>
      )}
    </li>
  )
}
