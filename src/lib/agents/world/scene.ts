import { deriveWorkProgress, selectPrimaryWorkItem } from "@/lib/agents/intelligence/run-summary";
import { RECENT_RUN_WINDOW_MS } from "@/lib/agents/spatial/types";
import { LIVE_AGENT_RUN_STATUSES } from "@/lib/agents/types";
import { agentVisualIdentity } from "@/lib/agents/visual/app-identities";
import { DEFAULT_WORLD_CHARACTER } from "@/lib/agents/visual/registry";
import { visualStateForRun } from "@/lib/agents/visual/states";
import { deriveCraft } from "./craft";
import { deriveHandoffs } from "./handoffs";
import { layoutWorld } from "./layout";
import { getWorldTheme, roomForStation, stationKeyForCraft } from "./themes";
import { STABLE_ZONE_FOR_STATE, ZONE_FOR_STATE, emptyWorldScene } from "./types";
import type { AgentDomainIndex } from "@/lib/agents/intelligence/domain-index";
import type { AgentRun, AgentRunStatus } from "@/lib/agents/types";
import type { AgentVisualState } from "@/lib/agents/visual/types";
import type { DerivedHandoff } from "./handoffs";
import type { LayoutSubject } from "./layout";
import type { WorldPresence } from "./roster";
import type { AgentWorldSettings } from "./settings";
import type { WorldCharacter, WorldHandoff, WorldScene } from "./types";

/**
 * Turning one workspace's agent state into a world.
 *
 * Built on `AgentDomainIndex` rather than on `AgentState` directly, for the
 * same reason `intelligence/workspace-activity.ts` is: the workspace boundary
 * is then crossed exactly once, at the top, under one lookup, and every work
 * item and link is reached only *through* a run already proven to belong to
 * the requested workspace. The isolation is structural rather than a matter
 * of remembering to filter. The index is also already memoised per state by
 * `useAgentIntelligence`, so the world costs one traversal rather than a
 * second copy of the domain.
 *
 * Read-only throughout. Nothing here writes to the domain, and there is no
 * parameter that would let it.
 */

const LIVE_STATUSES = new Set<AgentRunStatus>(LIVE_AGENT_RUN_STATUSES);

/**
 * A provider with nothing to show. Drawn only when "show idle agents" is on.
 *
 * Structurally a `WorldRosterEntry` with the two extra fields optional, so the
 * roster builder's output drops straight in while the Phase 18 shape — a bare
 * provider and a name — keeps working. An entry that says nothing about its
 * presence is treated as `connected`, which is the only kind that existed
 * before the roster did.
 */
export type WorldIdleProvider = {
  provider: string;
  displayName: string;
  presence?: WorldPresence;
  /** The connector layer's own status word, carried through to the detail card. */
  statusLabel?: string;
};

export type BuildWorldSceneInput = {
  index: AgentDomainIndex;
  workspaceId: string;
  /** Already resolved for this workspace — see settingsForWorkspace. */
  settings: AgentWorldSettings;
  /**
   * The clock, injected.
   *
   * Decides only what counts as a recent finish. The hook derives it from the
   * newest thing the domain knows about rather than from the wall clock, for
   * the reason `useAgentSpatial` already documents: it keeps the whole
   * derivation pure, and it means coming back after a week away still shows
   * the last thing an agent did instead of an empty room.
   */
  now: number;
  /** Tab id → title, so a passed tab can be named in a handoff. */
  tabTitles?: ReadonlyMap<string, string>;
  /** Connected providers, for the idle stand-ins. Empty when nothing is connected. */
  idleProviders?: readonly WorldIdleProvider[];
};

/** The character id for a run. Namespaced like every other id in this codebase. */
export function runCharacterId(runId: string): string {
  return `run:${runId}`;
}

/** The character id for a connected provider with no work. */
export function idleCharacterId(provider: string): string {
  return `idle:${provider}`;
}

/**
 * Whether a finished run is recent enough to still be in the room.
 *
 * The same six-hour window the canvas uses, imported rather than restated, so
 * the two views cannot disagree about whether this morning's run counts as
 * recent.
 */
function isRecentlyFinished(run: AgentRun, now: number): boolean {
  const ended = run.endedAt ?? run.updatedAt;
  return now - ended <= RECENT_RUN_WINDOW_MS;
}

export function buildWorldScene(input: BuildWorldSceneInput): WorldScene {
  const { index, workspaceId, settings, now, tabTitles, idleProviders } = input;
  const theme = getWorldTheme(settings.themeId);

  if (!workspaceId) return emptyWorldScene(theme);

  const runs = index.runsByWorkspace.get(workspaceId) ?? [];

  // ---- Who is in the room -------------------------------------------------

  const visibleRuns = runs.filter((run) => {
    if (LIVE_STATUSES.has(run.status)) return true;
    // A run that is over is here only if the user wants finished work kept,
    // and only while it is recent. Both conditions, because "show completed"
    // means "let me watch things finish", not "show me every run this
    // workspace has ever had".
    return settings.showCompleted && isRecentlyFinished(run, now);
  });

  if (visibleRuns.length === 0 && !settings.showIdleAgents) return emptyWorldScene(theme);

  const visibleRunIds = visibleRuns.map((run) => run.id);

  // ---- What passed between them -------------------------------------------

  const handoffs = deriveHandoffs({
    visibleRunIds,
    artifacts: [...index.artifactsById.values()],
    artifactLinks: visibleRunIds.flatMap((runId) => index.artifactLinksByRun.get(runId) ?? []),
    runLinks: visibleRunIds.flatMap((runId) => index.tabLinksByRun.get(runId) ?? []),
    tabTitles,
  });

  /**
   * Who is currently mid-handoff.
   *
   * **Both** ends have to be live. A single live run that once shared a file
   * with a run that finished hours ago is not handing anything over — it is
   * working — and putting it in the exchange zone would misreport what it is
   * doing. Requiring both ends also makes the state self-limiting: it ends on
   * its own when either side finishes, with no timer deciding when a
   * conversation is over.
   */
  const liveRunIds = new Set(
    visibleRuns.filter((run) => LIVE_STATUSES.has(run.status)).map((run) => run.id)
  );
  const handingOff = new Set<string>();
  for (const handoff of handoffs) {
    if (liveRunIds.has(handoff.fromRunId) && liveRunIds.has(handoff.toRunId)) {
      handingOff.add(handoff.fromRunId);
      handingOff.add(handoff.toRunId);
    }
  }

  // ---- Each run's state and caption ---------------------------------------

  type Draft = Omit<WorldCharacter, "zone" | "stationId" | "stationLabel" | "x" | "y" | "slot">;
  const drafts: Draft[] = [];
  const subjects: LayoutSubject[] = [];

  // Which of the two zone maps applies. Turning auto-arrange off does not
  // remember where anybody was standing — it picks a mapping under which the
  // live states all share one zone, so a working run keeps its desk until it
  // actually finishes. See STABLE_ZONE_FOR_STATE.
  const zoneFor = settings.autoArrange ? ZONE_FOR_STATE : STABLE_ZONE_FOR_STATE;

  for (const run of visibleRuns) {
    const items = index.workItemsByRun.get(run.id);
    const primary = selectPrimaryWorkItem(items);
    const hasNamedWork = primary?.status === "active";

    const state = visualStateForRun({
      status: run.status,
      currentActivity: run.currentActivity,
      hasNamedWork,
      isHandingOff: handingOff.has(run.id),
    });

    const agent = index.agentsById.get(run.agentId);
    const provider = agent?.provider ?? "";
    // The domain's own name wins over the catalogue's, because a run
    // persisted by a build that knew a provider this one does not still has a
    // name the user recognises.
    const agentName = agent?.name ?? agentVisualIdentity(provider).displayName;

    /**
     * Which room this run works in.
     *
     * Derived from the run's own evidence — what it has said it is doing and
     * which files it has touched — and never from which provider it is. A run
     * whose evidence says nothing gets no craft and stands on the general
     * floor, which is where every run stood before rooms existed.
     *
     * Suppressed entirely when the user has turned auto-arrange off, because
     * that setting's promise is that a run keeps its desk for its whole
     * working life: a craft can change as evidence accumulates, and honouring
     * it here would be a second reason for a figure to move after the user
     * asked for none.
     */
    const craft = settings.autoArrange
      ? deriveCraft({
          title: run.title,
          activity: run.currentActivity,
          workItemTitles: (items ?? []).map((item) => item.title),
          filePaths: (index.artifactLinksByRun.get(run.id) ?? []).flatMap((link) => {
            const artifact = index.artifactsById.get(link.artifactId);
            return artifact ? [artifact.relativePath] : [];
          }),
        })
      : null;

    const preferredStationKey = craft ? stationKeyForCraft(craft) : null;

    drafts.push({
      id: runCharacterId(run.id),
      runId: run.id,
      agentId: run.agentId,
      provider,
      agentName,
      title: run.title?.trim() || agentName,
      state,
      // What it is doing, in the order of how specific the evidence is: the
      // run's own activity line first, then the task it is on. Both are
      // already-sanitised domain strings; neither is raw provider text.
      activity: run.currentActivity?.trim() || primary?.title,
      ...(craft ? { craft } : {}),
      character: agentVisualIdentity(provider).character ?? DEFAULT_WORLD_CHARACTER,
      progress: deriveWorkProgress(items),
      startedAt: run.createdAt,
      updatedAt: run.updatedAt,
    });

    subjects.push({
      id: runCharacterId(run.id),
      zone: zoneFor[state],
      createdAt: run.createdAt,
      ...(preferredStationKey ? { preferredStationId: `${theme.id}-${preferredStationKey}` } : {}),
    });
  }

  // ---- Connected providers with nothing to show ---------------------------

  if (settings.showIdleAgents && idleProviders?.length) {
    const busyProviders = new Set(drafts.map((draft) => draft.provider));

    // Ordered after every real run, so the density cap sheds stand-ins before
    // it sheds actual work.
    let order = Number.MAX_SAFE_INTEGER - idleProviders.length;

    for (const idle of idleProviders) {
      if (busyProviders.has(idle.provider)) continue;

      const state: AgentVisualState = "idle";
      drafts.push({
        id: idleCharacterId(idle.provider),
        provider: idle.provider,
        agentName: idle.displayName,
        title: idle.displayName,
        state,
        // `idle`, unconditionally, for both kinds of stand-in. A figure that
        // is here because the user connected it and a figure that is here
        // because this build ships it are both doing nothing, and the only
        // thing that may ever put a character into a live state is a run.
        presence: idle.presence ?? "connected",
        statusLabel: idle.statusLabel,
        character: agentVisualIdentity(idle.provider).character ?? DEFAULT_WORLD_CHARACTER,
        updatedAt: 0,
      });
      subjects.push({
        id: idleCharacterId(idle.provider),
        zone: zoneFor[state],
        createdAt: (order += 1),
      });
    }
  }

  // ---- Place everybody ----------------------------------------------------

  const layout = layoutWorld({ theme, subjects, density: settings.density });

  const placementById = new Map(layout.placements.map((placement) => [placement.id, placement]));

  const characters: WorldCharacter[] = [];
  for (const draft of drafts) {
    const placement = placementById.get(draft.id);
    // No placement means the density cap left this one out. It is already
    // counted in `hiddenCount`; dropping it here is what makes the count and
    // the drawing agree.
    if (!placement) continue;

    // Which room the figure ended up in, resolved from the station it was
    // actually given rather than from the one it asked for. A run that
    // preferred a full Research Lab is standing on the general floor, and the
    // caption has to say the general floor.
    const room = roomForStation(theme, placement.stationId);

    characters.push({
      ...draft,
      zone: placement.zone,
      stationId: placement.stationId,
      stationLabel: placement.stationLabel,
      ...(room ? { roomId: room.id, roomName: room.name } : {}),
      slot: placement.slot,
      x: placement.x,
      y: placement.y,
    });
  }

  const drawnIds = new Set(characters.map((character) => character.id));

  return {
    theme,
    characters,
    handoffs: toWorldHandoffs(handoffs, drawnIds),
    hiddenCharacterCount: layout.hiddenCount,
    occupiedStationIds: layout.occupiedStationIds,
  };
}

/**
 * Handoffs, attached to characters that were actually drawn.
 *
 * A handoff whose other end fell off the stage is dropped rather than drawn
 * to nowhere. That is the same rule the count above follows: the picture
 * never claims a relationship to something it is not showing.
 */
function toWorldHandoffs(
  handoffs: readonly DerivedHandoff[],
  drawnIds: ReadonlySet<string>
): WorldHandoff[] {
  const out: WorldHandoff[] = [];

  for (const handoff of handoffs) {
    const fromCharacterId = runCharacterId(handoff.fromRunId);
    const toCharacterId = runCharacterId(handoff.toRunId);
    if (!drawnIds.has(fromCharacterId) || !drawnIds.has(toCharacterId)) continue;

    out.push({
      id: `${fromCharacterId}->${toCharacterId}`,
      fromCharacterId,
      toCharacterId,
      via: handoff.via,
      label: handoff.label,
    });
  }

  return out;
}

/**
 * The handoffs one character is on either end of.
 *
 * For the detail card, which states a relationship in words for someone who
 * cannot see the line that draws it. Direction is preserved, because "passed
 * this to Gemini" and "took this from Gemini" are different facts.
 */
export function handoffsForCharacter(
  scene: WorldScene,
  characterId: string
): { id: string; label: string; withName: string; direction: "to" | "from" }[] {
  const nameById = new Map(scene.characters.map((character) => [character.id, character.agentName]));
  const out: { id: string; label: string; withName: string; direction: "to" | "from" }[] = [];

  for (const handoff of scene.handoffs) {
    if (handoff.fromCharacterId === characterId) {
      out.push({
        id: handoff.id,
        label: handoff.label,
        withName: nameById.get(handoff.toCharacterId) ?? "another agent",
        direction: "to",
      });
    } else if (handoff.toCharacterId === characterId) {
      out.push({
        id: handoff.id,
        label: handoff.label,
        withName: nameById.get(handoff.fromCharacterId) ?? "another agent",
        direction: "from",
      });
    }
  }

  return out;
}
