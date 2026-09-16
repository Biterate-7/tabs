"use client"

import { useCallback, useEffect, useMemo } from "react"
import { Bot, ChevronLeft, Settings2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import { IconButton } from "@/components/ui/icon-button"
import { useAgentConnectors } from "@/hooks/use-agent-connectors"
import { useAgentIntelligence } from "@/hooks/use-agent-intelligence"
import { useAgentWorld } from "@/hooks/use-agent-world"
import { buildWorldRoster } from "@/lib/agents/world/roster"
import { handoffsForCharacter, idleCharacterId } from "@/lib/agents/world/scene"
import { cn } from "@/lib/utils"
import { AgentIcon } from "./agent-icon"
import { AgentWorld } from "./agent-world"
import type { WorldCharacterDetail } from "./agent-world-detail"
import type { AgentStoreApi } from "@/hooks/use-agent-store"
import type { WorldRosterEntry } from "@/lib/agents/world/roster"
import type { AgentWorldSettings } from "@/lib/agents/world/settings"
import type { WorldScene } from "@/lib/agents/world/types"
import type { WorkspaceStore } from "@/lib/workspace/types"

/**
 * The Agent World, as a place you can go.
 *
 * Phase 18 shipped the world as a panel over the graph canvas, reachable from
 * a button inside the graph sidebar's agent section that only appeared once
 * this workspace already had agent history. Each of those decisions was
 * defensible on its own and wrong in aggregate: the feature sat three levels
 * deep, and the single state in which it was reachable is the state a new
 * user has never been in.
 *
 * This is the same world with a front door. The panel over the canvas stays —
 * watching agents work *on the graph you are reading* is still the better
 * experience once there is work to watch — and this view is what someone
 * opens before any of that is true.
 *
 * ## Two components, on purpose
 *
 * `AgentWorldScreen` is the whole surface as a pure function of a scene, a
 * roster and four callbacks. `AgentWorldView` is the container that mounts
 * the agent stack and feeds it. The split is what lets the screen be tested
 * at every state that matters — nobody connected, connectors idle, agents
 * running — without standing up a connector manager, a store and an observer
 * to reach each one.
 */

/** What the header's quick-access controls do. All three navigate; none is a dialog. */
export type AgentWorldNavProps = {
  onClose: () => void
  onOpenConnectors: () => void
  onOpenWorldSettings: () => void
}

/**
 * The world's own top bar.
 *
 * Deliberately restrained. The brief asks for controls that are obvious
 * without overpowering the world, and the way that is achieved is by weight
 * rather than by size: one row of outline buttons on the app's own border
 * token, above a stage that gets the whole rest of the screen. Nothing here
 * is a filled primary button, because nothing here is the thing you came to
 * do.
 *
 * The labels shorten below `sm`; the accessible names do not. Each button
 * carries its full name as `aria-label`, and the visible text is a substring
 * of that name, so a voice-control user saying what they can see still hits
 * the right target.
 */
function AgentWorldNav({ onClose, onOpenConnectors, onOpenWorldSettings }: AgentWorldNavProps) {
  return (
    <nav aria-label="Agent World" className="flex shrink-0 items-center gap-1.5 sm:gap-2">
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="AI connectors"
        onClick={onOpenConnectors}
      >
        <Bot />
        <span className="hidden sm:inline">AI connectors</span>
      </Button>
      <Button
        type="button"
        variant="outline"
        size="sm"
        aria-label="Agent World settings"
        onClick={onOpenWorldSettings}
      >
        <Settings2 />
        <span className="hidden sm:inline">World settings</span>
      </Button>
      {/* A second way out, beside the back arrow. Both are offered because
          they read differently: the arrow is "where I came from", and this is
          "I am finished with this". */}
      <IconButton aria-label="Close Agent World" tooltip="Close" onClick={onClose}>
        <X />
      </IconButton>
    </nav>
  )
}

/**
 * The connector roster, beneath the stage.
 *
 * The figures in the room already are the roster, so this is not a second
 * source of truth — it is built from the same `buildWorldRoster` call the
 * scene is, and each chip selects the figure it names. What it adds is the
 * part a thirty-pixel silhouette cannot carry: the agent's name as text, its
 * connector status in the connector layer's own words, and a target big
 * enough to hit on a phone.
 */
function AgentWorldRoster({
  roster,
  scene,
  selectedId,
  onSelect,
  onOpenConnectors,
}: {
  roster: readonly WorldRosterEntry[]
  scene: WorldScene
  selectedId: string | null
  onSelect: (id: string | null) => void
  onOpenConnectors: () => void
}) {
  const drawn = new Set(scene.characters.map((character) => character.id))

  if (roster.length === 0) return null

  return (
    <section aria-labelledby="agent-world-roster-heading" className="space-y-1.5">
      <div className="flex items-center justify-between gap-2">
        <p id="agent-world-roster-heading" className="text-label text-tertiary">
          AGENTS IN THIS WORLD
        </p>
        <button
          type="button"
          onClick={onOpenConnectors}
          className="shrink-0 rounded-md px-1.5 py-0.5 text-meta text-muted-foreground transition-colors duration-(--duration-fast) hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50"
        >
          Manage
        </button>
      </div>

      <ul className="flex flex-wrap gap-1.5">
        {roster.map((entry) => {
          const characterId = idleCharacterId(entry.provider)
          // A provider that is running something has run characters in the
          // room instead of a stand-in, so selecting its chip would select
          // nothing. The chip stays — it is still a true statement about who
          // is here — and simply stops being a selector while its agent works.
          const selectable = drawn.has(characterId)
          const selected = selectable && selectedId === characterId

          return (
            <li key={entry.provider}>
              <button
                type="button"
                aria-pressed={selectable ? selected : undefined}
                disabled={!selectable}
                onClick={() => onSelect(selected ? null : characterId)}
                className={cn(
                  "flex items-center gap-1.5 rounded-lg border px-2 py-1 text-left transition-colors duration-(--duration-fast) ease-(--ease-standard) focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/50",
                  selected
                    ? "border-primary/40 bg-primary/10"
                    : "border-subtle hover:border-border hover:bg-surface-hover",
                  !selectable && "cursor-default opacity-70 hover:border-subtle hover:bg-transparent"
                )}
              >
                <AgentIcon connector={entry.provider} state="idle" size="sm" />
                <span className="min-w-0">
                  <span className="block truncate text-body-sm text-foreground">
                    {entry.displayName}
                  </span>
                  <span className="block truncate text-meta text-tertiary">{entry.statusLabel}</span>
                </span>
              </button>
            </li>
          )
        })}
      </ul>
    </section>
  )
}

export type AgentWorldScreenProps = AgentWorldNavProps & {
  scene: WorldScene
  settings: AgentWorldSettings
  /** What this world is called. Falls back to the theme's name inside the world itself. */
  worldName?: string | null
  /** The workspace this world belongs to, named in the header's second line. */
  workspaceName?: string
  now: number
  selectedId: string | null
  onSelect: (id: string | null) => void
  details?: (characterId: string) => WorldCharacterDetail | null
  roster: readonly WorldRosterEntry[]
}

export function AgentWorldScreen({
  scene,
  settings,
  worldName,
  workspaceName,
  now,
  selectedId,
  onSelect,
  details,
  roster,
  onClose,
  onOpenConnectors,
  onOpenWorldSettings,
}: AgentWorldScreenProps) {
  /**
   * Escape, at the view rather than at the stage.
   *
   * The world's own Escape handler lives on the stage element, which is only
   * focusable in the free camera — so from anywhere else on this screen the
   * key did nothing. One handler here covers the whole view, in the order a
   * user expects: the first press closes the card they have open, the second
   * leaves.
   */
  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      if (selectedId) onSelect(null)
      else onClose()
    }
    window.addEventListener("keydown", onKeyDown)
    return () => window.removeEventListener("keydown", onKeyDown)
  }, [selectedId, onSelect, onClose])

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-background"
      style={{ animation: "view-pop-in var(--duration-slow) var(--ease-standard) both" }}
    >
      <header className="flex items-center gap-2 border-b border-subtle px-3 py-2.5 sm:gap-3 sm:px-6 sm:py-3">
        <IconButton aria-label="Back" tooltip="Back" onClick={onClose}>
          <ChevronLeft />
        </IconButton>
        <div className="min-w-0 flex-1">
          <h1 className="truncate text-h2 text-foreground">Agent World</h1>
          <p className="truncate text-meta text-tertiary">
            {workspaceName ? `${workspaceName} · ` : ""}
            Watch connected AI agents work. Nothing here is simulated.
          </p>
        </div>
        <AgentWorldNav
          onClose={onClose}
          onOpenConnectors={onOpenConnectors}
          onOpenWorldSettings={onOpenWorldSettings}
        />
      </header>

      <div className="min-h-0 flex-1 overflow-y-auto p-3 sm:p-6">
        <div className="mx-auto w-full max-w-5xl space-y-4">
          {settings.enabled ? (
            <>
              <AgentWorld
                scene={scene}
                settings={settings}
                worldName={worldName}
                now={now}
                selectedId={selectedId}
                onSelect={onSelect}
                details={details}
                onOpenConnectors={onOpenConnectors}
              />
              <AgentWorldRoster
                roster={roster}
                scene={scene}
                selectedId={selectedId}
                onSelect={onSelect}
                onOpenConnectors={onOpenConnectors}
              />
            </>
          ) : (
            /* The world is switched off in settings, and the honest thing is
               to say so rather than to draw it anyway or to show a blank
               screen. The entry point still works: a nav item that vanished
               when a setting was flipped would leave someone hunting for a
               feature they had only turned off. */
            <div className="rounded-xl border border-subtle bg-background-secondary p-6 text-center">
              <Bot className="mx-auto size-5 text-tertiary" aria-hidden />
              <p className="mt-2 text-body font-medium text-foreground">Agent World is turned off</p>
              <p className="mx-auto mt-1 max-w-sm text-body-sm text-muted-foreground">
                Agent activity is still tracked and listed as text. Turn the world back on to watch
                it happen.
              </p>
              <Button
                type="button"
                variant="secondary"
                size="sm"
                className="mt-3"
                onClick={onOpenWorldSettings}
              >
                Agent World settings
              </Button>
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

export type AgentWorldViewProps = AgentWorldNavProps & {
  store: WorkspaceStore
  /**
   * The agent domain, mounted once at the shell and handed down.
   *
   * Not mounted here, and deliberately so: the graph reads the same domain,
   * and a second `useAgentStore` would be a second debounced writer against
   * one localStorage key. The observer that fills it lives at the shell for
   * the same reason — see AppShell, and connectors/single-loop.test.ts.
   */
  agentStore: AgentStoreApi
}

/**
 * The container: the agent stack, mounted for this view.
 *
 * Mirrors GraphView's shape deliberately, because it has the same job: read
 * the domain the shell mounted, derive the index once, and own nothing that
 * could write back. Neither view observes — the shell does — so opening the
 * world starts no additional reading of the user's machine, and agent work
 * that happened while they were elsewhere in the app is already in the
 * domain when they arrive.
 */
export function AgentWorldView({
  store,
  agentStore,
  onClose,
  onOpenConnectors,
  onOpenWorldSettings,
}: AgentWorldViewProps) {
  const connectors = useAgentConnectors()

  const tabTitles = useMemo(() => {
    const titles = new Map<string, string>()
    for (const workspace of store.workspaces) {
      for (const tab of workspace.tabs) {
        titles.set(tab.id, tab.title?.trim() || tab.domain)
      }
    }
    return titles
  }, [store.workspaces])

  /**
   * Everyone who could be in the room, connected or not.
   *
   * `includeAvailable` is what makes this view explorable on first open: the
   * panel over the canvas draws only connected providers, because it is a
   * small window onto work in progress, and this is the place someone comes
   * to find out what the feature is at all. See world/roster.ts.
   */
  const roster = useMemo(
    () => buildWorldRoster(connectors.connectors, { includeAvailable: true }),
    [connectors.connectors]
  )

  const intelligence = useAgentIntelligence({
    state: agentStore.state,
    workspaceId: store.currentId,
  })

  const world = useAgentWorld({
    index: intelligence.index,
    workspaceId: store.currentId,
    tabTitles,
    idleProviders: roster,
  })

  const workspaceName = useMemo(
    () => store.workspaces.find((workspace) => workspace.id === store.currentId)?.name,
    [store.workspaces, store.currentId]
  )

  /** Detail for the one character that is open. Identical in shape to GraphView's. */
  const details = useCallback(
    (characterId: string): WorldCharacterDetail | null => {
      const character = world.scene.characters.find((entry) => entry.id === characterId)
      if (!character?.runId) return null
      const runId = character.runId
      const index = intelligence.index

      return {
        events: [...agentStore.state.events]
          .filter((event) => event.runId === runId)
          .reverse()
          .slice(0, 8),
        files: (index.artifactLinksByRun.get(runId) ?? []).flatMap((link) => {
          const artifact = index.artifactsById.get(link.artifactId)
          // `relativePath` only — `projectPath` is an absolute local path and
          // never leaves the domain. See intelligence/types.ts.
          return artifact
            ? [{ artifactId: artifact.id, relativePath: artifact.relativePath, role: link.role }]
            : []
        }),
        workItems: (index.workItemsByRun.get(runId) ?? []).map((item) => ({
          id: item.id,
          title: item.title,
          status: item.status,
        })),
        handoffs: handoffsForCharacter(world.scene, characterId),
      }
    },
    [world.scene, intelligence.index, agentStore.state.events]
  )

  return (
    <AgentWorldScreen
      scene={world.scene}
      settings={world.effective}
      worldName={world.worldName ?? workspaceName}
      workspaceName={workspaceName}
      now={world.now}
      selectedId={world.selectedId}
      onSelect={world.select}
      details={details}
      roster={roster}
      onClose={onClose}
      onOpenConnectors={onOpenConnectors}
      onOpenWorldSettings={onOpenWorldSettings}
    />
  )
}
