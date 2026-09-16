import type { AgentVisualState, WorldCharacterConfig } from "@/lib/agents/visual/types";
import type { WorldPresence } from "./roster";

/**
 * The Agent World's model.
 *
 * A second presentation model for agent work, beside `spatial/` rather than
 * replacing it. The two answer different questions and deliberately do not
 * share a scene:
 *
 *   - `spatial/` places runs, agents and files **next to the tab graph**, as
 *     cards in a column, so agent work can be read alongside the workspace it
 *     happened in. It is the analytical view.
 *   - `world/` places runs **inside a room**, as characters at workstations,
 *     so a glance says who is working and on what. It is the ambient view.
 *
 * Merging them would mean one layout serving two incompatible goals: the
 * column must hold still while it is read, and the world must move when work
 * moves. What they do share is their source — both are derived from the same
 * `AgentState`, and neither can write to it.
 *
 * ## A character is a run, not an agent
 *
 * The decision that shapes everything below. An `Agent` is a persistent
 * identity — one per provider — so a world of agents would hold at most five
 * figures however much work was happening, and "ten agents running" would
 * look identical to "one agent running". A character is therefore one
 * **run**: one session, doing one thing, wearing its agent's identity. Three
 * concurrent Claude Code sessions are three workers who look alike, which is
 * exactly what they are.
 *
 * ## Nothing here is invented
 *
 * Every character corresponds to a run the domain holds. Every handoff
 * corresponds to a relationship the domain recorded. There is no idle
 * wandering, no simulated chatter and no decorative agent: a world with
 * nothing in it renders as empty, because nothing is happening.
 */

/** Which environment is being drawn. */
export type WorldThemeId = "office" | "city" | "command-center" | "studio";

export const WORLD_THEME_IDS: readonly WorldThemeId[] = [
  "office",
  "city",
  "command-center",
  "studio",
] as const;

export function isWorldThemeId(value: unknown): value is WorldThemeId {
  return typeof value === "string" && (WORLD_THEME_IDS as readonly string[]).includes(value);
}

/**
 * What a part of the world is *for*.
 *
 * The shared vocabulary that makes four environments one engine. A theme
 * decides what a work zone looks like and what it is called — "Research
 * desk", "Data centre", "Terminal bank", "Editing station" — but every theme
 * has one, and the layout engine only ever reasons about zones. That is why
 * adding a theme is a data change: it supplies labels and coordinates, not
 * behaviour.
 *
 * Six zones, each mapped to from a visual state, so a character's location is
 * always a consequence of something real:
 */
export type WorldZoneKind =
  /** Present, not working. Where an idle or queued agent stands. */
  | "arrival"
  /** Doing the work. `working` and `thinking`. */
  | "work"
  /** Handing something over. Only reachable from an observed handoff. */
  | "exchange"
  /** Live but stalled. `waiting`, and `starting`. */
  | "waiting"
  /** Finished. `success`. */
  | "done"
  /** Stopped in a way worth noticing. `error`. */
  | "attention";

export const WORLD_ZONE_KINDS: readonly WorldZoneKind[] = [
  "arrival",
  "work",
  "exchange",
  "waiting",
  "done",
  "attention",
] as const;

/**
 * Where a visual state puts a character.
 *
 * The whole of the world's movement logic. A character moves because its
 * run's state changed, full stop — there is no path by which one drifts, and
 * no timer that relocates anything. Brief §15: deterministic movement based
 * on activity.
 */
export const ZONE_FOR_STATE: Record<AgentVisualState, WorldZoneKind> = {
  idle: "arrival",
  queued: "arrival",
  starting: "waiting",
  thinking: "work",
  working: "work",
  communicating: "exchange",
  waiting: "waiting",
  success: "done",
  error: "attention",
};

/**
 * Where a visual state puts a character when the user has turned
 * auto-arrange off.
 *
 * The same mapping with every *live* state collapsed onto `work`. A run then
 * keeps its desk for its whole working life — it stops hopping to the meeting
 * room and back as a handoff begins and ends, or to the waiting area for the
 * moments it has nothing to report — and moves exactly once, when it actually
 * finishes. Its mark still changes state, so nothing is hidden; only the
 * movement is.
 *
 * This is why "don't rearrange" needs no stored positions. The setting picks a
 * different pure function of the same state rather than remembering where
 * everybody was, so it survives a reload, cannot drift out of step with the
 * scene, and has no snapshot to get stale.
 */
export const STABLE_ZONE_FOR_STATE: Record<AgentVisualState, WorldZoneKind> = {
  idle: "arrival",
  queued: "arrival",
  starting: "work",
  thinking: "work",
  working: "work",
  communicating: "work",
  waiting: "work",
  success: "done",
  error: "attention",
};

/**
 * A place in the world an agent can stand.
 *
 * Coordinates are normalised 0..1 against the stage, never pixels. The stage
 * is whatever size the viewport gives it — a full panel on a desktop, a short
 * strip on a phone — and a layout in pixels would need re-authoring per
 * breakpoint. Normalised coordinates make the responsive requirement (§20) a
 * property of the model rather than a set of media queries.
 */
export type WorldStation = {
  id: string;
  zone: WorldZoneKind;
  /** What this station is called in this theme. Shown as a label at detailed density. */
  label: string;
  /** 0..1 across the stage. */
  x: number;
  /** 0..1 down the stage. */
  y: number;
  /**
   * How many characters stand here before the next station is used.
   *
   * Capacity is what prevents overlap without a collision solver: the layout
   * engine hands out numbered slots, and a slot is a fixed offset from the
   * station. Two characters cannot receive the same slot, so two characters
   * cannot occupy the same point.
   */
  capacity: number;
};

/** Scenery. Purely decorative, never interactive, and the first thing dropped at low density. */
export type WorldDecor = {
  id: string;
  /** The shape family the renderer draws. Themes compose scenes from these. */
  kind: "block" | "panel" | "tower" | "bench" | "screen" | "plant" | "rack" | "window";
  x: number;
  y: number;
  /** Width and height, normalised like the coordinates. */
  width: number;
  height: number;
  /**
   * Whether this piece carries the theme's ambient animation.
   *
   * A minority of decor on purpose: §25 asks for a world that feels alive
   * while keeping the active agent dominant, and the way that is guaranteed
   * is by animating few things, faintly. The renderer enforces the amplitude;
   * this flag decides the count.
   */
  ambient?: boolean;
};

/** One environment. Entirely data — no theme contributes behaviour. */
export type WorldTheme = {
  id: WorldThemeId;
  name: string;
  /** One line, for the theme picker. */
  description: string;
  stations: WorldStation[];
  decor: WorldDecor[];
  /** What this theme calls the space itself, for the stage's accessible name. */
  spaceLabel: string;
};

/**
 * One agent at work, placed.
 *
 * Everything the renderer needs and nothing it does not. Note the absences,
 * which mirror `spatial/types.ts` and exist for the same reasons: there is no
 * `externalId` (a provider session id is not a caption) and no `projectPath`
 * (it is an absolute local path). A character carries only what is safe to
 * draw.
 */
export type WorldCharacter = {
  /** Stable across polls. Derived from the run id, never from an array index. */
  id: string;
  /**
   * The run this character is.
   *
   * Absent for the one kind of character that is not a run: a connected
   * provider that has observed nothing yet, drawn standing in the arrival
   * zone when "show idle agents" is on. It is labelled idle and its detail
   * view says plainly that no activity has been observed — it is present
   * because the user connected it, not because anything is happening.
   */
  runId?: string;
  agentId?: string;
  /**
   * What a character with no run is.
   *
   * Absent for a run — a run's presence is that it exists. Present for the
   * two kinds of stand-in: `connected`, an observable agent that has done
   * nothing here yet, and `available`, an agent this build ships that the
   * user has not connected. Both are drawn `idle`, and neither can ever hold
   * a working, thinking or communicating state — see world/roster.ts for why
   * an unconnected provider is drawn at all.
   */
  presence?: WorldPresence;
  /**
   * The connector layer's own status word for a stand-in, e.g. "Not
   * connected". Carried rather than re-derived, so the world and the settings
   * page cannot disagree about what state a connector is in.
   */
  statusLabel?: string;
  /** Opaque provider key, used to resolve a visual identity. Never branched on here. */
  provider: string;
  /** The agent's name, as the domain recorded it. */
  agentName: string;
  /** The run's own title, when it has one. */
  title: string;
  state: AgentVisualState;
  /** The run's sanitised activity line, or its active work item's title. Never raw provider text. */
  activity?: string;
  zone: WorldZoneKind;
  stationId: string;
  stationLabel: string;
  /** Final position, 0..1, station plus slot offset. */
  x: number;
  y: number;
  /** Slot within the station. Decides the offset, and is stable for a given run. */
  slot: number;
  character: WorldCharacterConfig;
  /** Derived work progress, when the run has countable work items. Never fabricated. */
  progress?: { completed: number; total: number };
  /** When the run started, so the detail view can show elapsed time. Absent for an idle stand-in. */
  startedAt?: number;
  updatedAt: number;
};

/**
 * Two agents sharing work, as the domain recorded it.
 *
 * This is the one part of the world that could most easily have been faked,
 * and the reason it is not is worth stating. TabDump's domain has no
 * agent-to-agent message: nothing observes one agent talking to another, and
 * drawing a line between two characters because they are both on screen would
 * be inventing a relationship.
 *
 * What the domain *does* record is real and is enough: two runs that touched
 * the same file, and a run that produced a tab another run then used as
 * context. Both are genuine transfers of work between agents, both are
 * already stored, and both are directional. A world with no such relationship
 * draws no lines at all — which, for a workspace where one agent worked
 * alone, is the correct picture.
 */
export type WorldHandoff = {
  id: string;
  fromCharacterId: string;
  toCharacterId: string;
  /** What was shared. Decides the label, and is always something observed. */
  via: "file" | "tab";
  /** A short human phrase: "shared src/app/page.tsx". Already safe to render. */
  label: string;
};

/** Everything the stage needs to draw one workspace's world. */
export type WorldScene = {
  theme: WorldTheme;
  characters: WorldCharacter[];
  handoffs: WorldHandoff[];
  /**
   * Runs that belong in the world but were not drawn.
   *
   * A count rather than a silent omission, for the same reason
   * `AgentSpatialScene.hiddenRunCount` exists: a user who cannot tell "no
   * agents" from "too many agents to draw" will read the first as the truth.
   */
  hiddenCharacterCount: number;
  /** Stations actually in use, so the renderer can label only what is occupied. */
  occupiedStationIds: string[];
};

export function emptyWorldScene(theme: WorldTheme): WorldScene {
  return {
    theme,
    characters: [],
    handoffs: [],
    hiddenCharacterCount: 0,
    occupiedStationIds: [],
  };
}
