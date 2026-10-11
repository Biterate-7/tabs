"use client"

import { useState, type FormEvent } from "react"
import { ArrowUp, PanelLeftOpen } from "lucide-react"
import { AiConnectionsList } from "@/components/ai/ai-connections"
import { ASK_AI_ACTIONS } from "@/components/agents/agent-actions"
import { useSettingsAgentPlatform } from "@/components/settings/sections/agent-connections-panel"
import { ConnectAgentDialog } from "@/components/command-centre/connect-agent-dialog"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { useAgentRuntime } from "@/hooks/use-agent-runtime"
import { useProviderConnections } from "@/hooks/use-provider-connections"
import { PLATFORM_PROVIDERS } from "@/lib/agents/platform/catalog"
import { subjectName } from "@/lib/product/subjects"
import type { AgentIntent } from "@/lib/agents/command-centre/working-context"
import type { AgentProviderId } from "@/lib/agents/connectors/types"
import type { Workspace } from "@/lib/workspace/types"

/**
 * AI — the one page about AI a student needs.
 *
 *     AI
 *     [History HL ▾]  Ask anything…                        ↑
 *     Summarize · Explain · Quiz me · Help me write
 *
 *     AI Connections
 *     Claude   Connected ✓
 *     Gemini   Installed      Connect →
 *     + Connect AI
 *
 *     AI chats · AI activity · Connection details
 *
 * Asking hands the question to the Command Centre (through the shell's
 * `onAsk`, the same handoff Ask AI uses everywhere), which starts a chat with
 * a ready AI on the chosen subject. Connections are the same platform hook
 * and Connect flow as Settings and the Command Centre. The power surfaces
 * are links at the foot: kept, and out of the way.
 *
 * A sibling destination of the Command Centre, never mounted with it, so
 * there is still exactly one agent surface on screen at a time.
 */
export function AiView({
  subjects,
  currentSubjectId,
  onAsk,
  onOpenCommandCentre,
  onOpenActivity,
  onOpenConnectionDetails,
  onOpenSidebar,
}: {
  subjects: readonly Workspace[]
  currentSubjectId: string | null
  onAsk: (workspaceId: string, intent: AgentIntent, text?: string) => void
  onOpenCommandCentre: () => void
  onOpenActivity: () => void
  onOpenConnectionDetails: () => void
  onOpenSidebar?: () => void
}) {
  /*
    The runtime's report, read on mount and again whenever the Connect flow
    closes — the same rhythm as Settings → AI Connections. No poll: nothing
    here changes on a timer.
  */
  const runtime = useAgentRuntime({ poll: false })
  const connections = useProviderConnections()
  const { platform } = useSettingsAgentPlatform(runtime, connections)
  const [connectFor, setConnectFor] = useState<AgentProviderId | null | undefined>(undefined)

  const fallback = subjects.find((subject) => subject.id === currentSubjectId) ?? subjects[0]
  const [subjectId, setSubjectId] = useState<string | undefined>(fallback?.id)
  const subject = subjects.find((candidate) => candidate.id === subjectId) ?? fallback
  const [text, setText] = useState("")
  const anyConnected = PLATFORM_PROVIDERS.some((spec) => platform.phaseOf(spec.provider) === "connected")

  function submit(event?: FormEvent) {
    event?.preventDefault()
    if (!subject || !text.trim()) return
    onAsk(subject.id, "ask", text.trim())
    setText("")
  }

  return (
    <div className="min-h-screen" data-ai-page>
      {onOpenSidebar && (
        <header className="flex h-12 items-center px-3 md:hidden">
          <IconButton aria-label="Open sidebar" onClick={onOpenSidebar}>
            <PanelLeftOpen />
          </IconButton>
        </header>
      )}
      <main className="mx-auto w-full max-w-2xl px-4 py-10 sm:px-8 sm:py-16">
        <h1 className="text-statement text-foreground">AI</h1>

        {subject ? (
          <form onSubmit={submit} className="mt-6 rounded-md border border-border bg-card transition-colors focus-within:border-strong" aria-label="Ask AI">
            <label htmlFor="ai-page-ask" className="sr-only">
              Ask AI about {subjectName(subject)}
            </label>
            <textarea
              id="ai-page-ask"
              rows={2}
              value={text}
              onChange={(event) => setText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || event.shiftKey) return
                event.preventDefault()
                submit()
              }}
              placeholder={`Ask anything about ${subjectName(subject)}…`}
              className="block w-full resize-none bg-transparent px-3 pt-2.5 pb-1 text-body text-foreground outline-none placeholder:text-tertiary"
            />
            <div className="flex items-center gap-2 px-2 pb-2">
              {subjects.length > 1 ? (
                <label className="flex min-w-0 items-center gap-1 text-body-sm text-muted-foreground">
                  <span className="sr-only">Subject</span>
                  <select
                    value={subject.id}
                    onChange={(event) => setSubjectId(event.target.value)}
                    className="h-6 max-w-48 truncate rounded-xs border border-subtle bg-background px-1.5 text-body-sm text-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring/60"
                  >
                    {subjects.map((candidate) => (
                      <option key={candidate.id} value={candidate.id}>
                        {subjectName(candidate)}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <span className="truncate text-body-sm text-tertiary">{subjectName(subject)}</span>
              )}
              <span className="min-w-0 flex-1" />
              <Button type="submit" size="icon-sm" shape="pill" aria-label="Ask" disabled={!text.trim()}>
                <ArrowUp />
              </Button>
            </div>
          </form>
        ) : (
          <p className="mt-4 text-body text-muted-foreground">Make a subject first, then ask AI about it.</p>
        )}

        {subject && (
          <div className="mt-3 flex flex-wrap gap-1.5" role="group" aria-label="Quick actions">
            {ASK_AI_ACTIONS.map((action) => (
              <Button key={action.intent} type="button" size="sm" variant="secondary" shape="pill" onClick={() => onAsk(subject.id, action.intent)}>
                <action.icon /> {action.label}
              </Button>
            ))}
          </div>
        )}

        <section aria-labelledby="ai-connections-heading" className="mt-12">
          <h2 id="ai-connections-heading" className="text-h2 text-foreground">
            AI Connections
          </h2>
          {!anyConnected && !runtime.loading && <p className="mt-1 text-body-sm text-muted-foreground">Connect one to start asking.</p>}
          <AiConnectionsList className="mt-3" platform={platform} onConnect={(provider) => setConnectFor(provider ?? null)} />
        </section>

        <nav aria-label="Advanced" className="mt-12 flex flex-wrap gap-x-4 gap-y-1 border-t border-subtle pt-4 text-body-sm">
          <button type="button" className="text-tertiary hover:text-foreground" onClick={onOpenCommandCentre}>
            AI chats
          </button>
          <button type="button" className="text-tertiary hover:text-foreground" onClick={onOpenActivity}>
            AI activity
          </button>
          <button type="button" className="text-tertiary hover:text-foreground" onClick={onOpenConnectionDetails}>
            Connection details
          </button>
        </nav>
      </main>

      <ConnectAgentDialog
        // Remounted per opening so it starts on the AI that was chosen (or its chooser).
        key={`ai-connect:${connectFor === undefined ? "closed" : (connectFor ?? "choose")}`}
        open={connectFor !== undefined}
        onOpenChange={(next) => {
          if (next) return
          setConnectFor(undefined)
          // A sign-in may have changed what the runtime reports; ask again.
          void runtime.refresh()
        }}
        platform={platform}
        initialProvider={connectFor ?? null}
        apiKeys={connections}
        onOpenSettings={onOpenConnectionDetails}
      />
    </div>
  )
}
