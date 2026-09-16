"use client"

import { useCallback, useEffect, useMemo, useState } from "react"
import {
  loadAgentWorldState,
  saveAgentWorldState,
} from "@/lib/agents/world/persistence"
import { buildWorldScene } from "@/lib/agents/world/scene"
import {
  DEFAULT_AGENT_WORLD_SETTINGS,
  settingsForWorkspace,
  setWorkspaceOverride,
  worldNameForWorkspace,
} from "@/lib/agents/world/settings"
import type { AgentDomainIndex } from "@/lib/agents/intelligence/domain-index"
import type { WorldIdleProvider } from "@/lib/agents/world/scene"
import type {
  AgentWorldSettings,
  WorldEffects,
  WorldWorkspaceOverride,
} from "@/lib/agents/world/settings"
import type { WorldScene } from "@/lib/agents/world/types"

/**
 * The Agent World, ready to render.
 *
 * Shaped after `useAgentSpatial`, deliberately: same debounce on persistence,
 * same workspace-scoped selection, same derived clock, same refusal to own a
 * poll. Two surfaces that do the same job should be recognisable as siblings,
 * and a reader who has understood one should not have to learn a second set
 * of conventions for the other.
 *
 * Read-only with respect to the agent domain. It selects, themes and
 * remembers preferences, and has no path that could change a run's status,
 * delete a run or touch a relationship. Observation belongs to the Phase 12
 * observer; this hook reads what the store already holds.
 */

const SAVE_DEBOUNCE_MS = 400

export type AgentWorldLayer = {
  /** The stored settings, unresolved. What the settings panel edits. */
  settings: AgentWorldSettings
  /** The same settings with this workspace's overrides applied. What the world renders from. */
  effective: AgentWorldSettings
  scene: WorldScene
  /**
   * The clock the scene was derived against.
   *
   * Exposed because elapsed times in the detail card have to be measured
   * against the same instant the scene was built at. A consumer reaching for
   * `Date.now()` instead would report a run as having been active for longer
   * than the data it is looking at can support.
   */
  now: number
  /** What this workspace's world is called, or null to fall back to the workspace name. */
  worldName: string | null
  selectedId: string | null
  select: (id: string | null) => void
  /** Patches the stored settings. Persisted on a debounce. */
  update: (patch: Partial<AgentWorldSettings>) => void
  /** Toggles one effect without the caller having to spread the whole record. */
  setEffect: (key: keyof WorldEffects, value: boolean) => void
  /** Sets this workspace's theme or name. */
  setOverride: (patch: WorldWorkspaceOverride) => void
  /** False until localStorage has been read — the first render is the server's. */
  hydrated: boolean
}

export type UseAgentWorldInput = {
  /** The memoised domain index. The world reads it and never writes. */
  index: AgentDomainIndex
  workspaceId: string
  /** Tab id → title, so a passed tab can be named in a handoff. */
  tabTitles?: ReadonlyMap<string, string>
  /** Connected providers, for the idle stand-ins. */
  idleProviders?: readonly WorldIdleProvider[]
  /** Clock, injected for tests. Defaults to the derived clock described below. */
  now?: number
}

/**
 * Just the preferences.
 *
 * Split out because two surfaces need them and only one of them needs a
 * scene: the settings panel edits these without any agent state in scope at
 * all, and building a whole world in order to change a theme would be both
 * wasteful and a needless coupling of Settings to the agent domain.
 */
export type AgentWorldSettingsApi = {
  settings: AgentWorldSettings
  hydrated: boolean
  update: (patch: Partial<AgentWorldSettings>) => void
  setEffect: (key: keyof WorldEffects, value: boolean) => void
  setOverrideFor: (workspaceId: string, patch: WorldWorkspaceOverride) => void
}

export function useAgentWorldSettings(): AgentWorldSettingsApi {
  /**
   * Settings start at the defaults and are replaced once on mount.
   *
   * Not read during the initial state computation — there is no `window` on
   * the server — and not read during render on the client either, so the
   * first client render matches the server's and hydration stays stable. The
   * `hydrated` flag lets a caller avoid flashing a default theme before the
   * stored one arrives.
   */
  const [settings, setSettings] = useState<AgentWorldSettings>(DEFAULT_AGENT_WORLD_SETTINGS)
  const [hydrated, setHydrated] = useState(false)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setSettings(loadAgentWorldState().settings)
    setHydrated(true)
  }, [])

  useEffect(() => {
    // Nothing is written before the stored value has been read. Without this
    // guard the debounce would fire once on mount and overwrite the user's
    // saved settings with the defaults.
    if (!hydrated) return
    const timer = setTimeout(() => {
      saveAgentWorldState({ version: 1, settings })
    }, SAVE_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [settings, hydrated])

  const update = useCallback((patch: Partial<AgentWorldSettings>) => {
    setSettings((current) => ({ ...current, ...patch }))
  }, [])

  const setEffect = useCallback((key: keyof WorldEffects, value: boolean) => {
    setSettings((current) => ({ ...current, effects: { ...current.effects, [key]: value } }))
  }, [])

  const setOverrideFor = useCallback((workspaceId: string, patch: WorldWorkspaceOverride) => {
    setSettings((current) => setWorkspaceOverride(current, workspaceId, patch))
  }, [])

  return useMemo(
    () => ({ settings, hydrated, update, setEffect, setOverrideFor }),
    [settings, hydrated, update, setEffect, setOverrideFor]
  )
}

export function useAgentWorld(input: UseAgentWorldInput): AgentWorldLayer {
  const { index, workspaceId, tabTitles, idleProviders, now } = input
  const { settings, hydrated, update, setEffect, setOverrideFor } = useAgentWorldSettings()

  /**
   * Selection remembers which workspace it belongs to.
   *
   * Derived rather than cleared by an effect, exactly as the spatial layer
   * does it: a character selected in one workspace means nothing in another,
   * so the selection simply does not apply unless the workspace matches. Pure,
   * no effect, and it restores what was selected when the user comes back.
   */
  const [selection, setSelection] = useState<{ workspaceId: string; id: string } | null>(null)
  const selectedId = selection && selection.workspaceId === workspaceId ? selection.id : null

  const select = useCallback(
    (id: string | null) => setSelection(id ? { workspaceId, id } : null),
    [workspaceId]
  )

  /**
   * "Now", derived from the data rather than from the wall clock.
   *
   * It decides one thing: how recent a finished run has to be to still be in
   * the room. Taking it from the newest thing the domain knows about keeps
   * the whole derivation pure — no interval, no effect, no rerender on a
   * timer — and behaves better besides: come back after a week away and the
   * last thing an agent did is still there, rather than the room being empty
   * because the clock moved and the work did not.
   */
  const derivedNow = useMemo(() => {
    let latest = 0
    for (const run of index.runsByWorkspace.get(workspaceId) ?? []) {
      if (run.updatedAt > latest) latest = run.updatedAt
    }
    return latest
  }, [index, workspaceId])

  const effective = useMemo(
    () => settingsForWorkspace(settings, workspaceId),
    [settings, workspaceId]
  )

  /**
   * The scene.
   *
   * Entirely derived, with no stored positions anywhere in this hook — which
   * is what lets the whole world be a `useMemo` over the domain index. Even
   * "don't rearrange my world" is handled by the builder choosing a different
   * pure zone mapping (see `STABLE_ZONE_FOR_STATE`), rather than by this hook
   * remembering where anybody was standing. A remembered layout would have
   * been a second source of truth about the same scene, free to drift out of
   * step with it and impossible to restore correctly after a reload.
   */
  const scene = useMemo(
    () =>
      buildWorldScene({
        index,
        workspaceId,
        settings: effective,
        now: now ?? derivedNow,
        tabTitles,
        idleProviders,
      }),
    [index, workspaceId, effective, now, derivedNow, tabTitles, idleProviders]
  )

  const setOverride = useCallback(
    (patch: WorldWorkspaceOverride) => setOverrideFor(workspaceId, patch),
    [setOverrideFor, workspaceId]
  )

  const worldName = useMemo(
    () => worldNameForWorkspace(settings, workspaceId),
    [settings, workspaceId]
  )

  return useMemo(
    () => ({
      settings,
      effective,
      scene,
      now: now ?? derivedNow,
      worldName,
      selectedId,
      select,
      update,
      setEffect,
      setOverride,
      hydrated,
    }),
    [settings, effective, scene, now, derivedNow, worldName, selectedId, select, update, setEffect, setOverride, hydrated]
  )
}
