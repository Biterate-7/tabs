import { projectPlanNormalized } from "./projection";
import { WORLD_ZONE_KINDS } from "./types";
import type { WorldFixture, WorldFixtureKind, WorldRoom, WorldRoomAccent } from "./architecture";
import type { WorldCraft } from "./craft";
import type { WorldStation, WorldTheme, WorldThemeId, WorldZoneKind } from "./types";

/**
 * The four environments.
 *
 * Every one of them is **data only**. There is no theme-specific component,
 * no theme-specific layout rule and no `switch (theme)` anywhere in the
 * engine: a theme supplies names, purposes and furniture, and the same code
 * places characters, routes handoffs, draws rooms and handles overflow
 * whatever it was handed. A fifth environment is an entry in this file.
 *
 * ## One building, four dressings
 *
 * All four share two plans below — `STATION_GRID`, which says where an agent
 * can stand, and `ROOM_PLAN`, which says what walls are around it. Themes
 * differ in what those places are *called*, what they are *for*, and what
 * furniture fills them.
 *
 * That is not a shortcut, and Phase 18 already made the argument for the
 * station half of it: someone who has learnt to read one world can read all
 * of them, and the geometry is verified once rather than four times. Phase
 * 18.2 extends it to the architecture for a third reason. A room now carries
 * a purpose and a set of stations, which is what makes "what happens in the
 * Research Lab" a derivable question — and eleven rooms whose rectangles were
 * hand-placed per theme would be forty-four chances for a station to end up
 * in the wrong room.
 *
 * A theme that genuinely needed its own arrangement can still have one: the
 * type takes plain `WorldStation[]` and `WorldRoom[]`, and nothing requires
 * either plan.
 */

/**
 * Where an agent can stand, in plan coordinates.
 *
 * Ten places rather than Phase 18's eight, and the two new ones are the whole
 * reason the redesign has rooms worth naming. The work zone used to be three
 * interchangeable desks filled in discovery order; it is now five, four of
 * which are claimed by a *craft* — a kind of work derived from what a run has
 * actually touched and said (see craft.ts) — and one of which is the general
 * floor for work whose kind cannot be told.
 *
 * The coordinates are chosen so that no two station clusters draw over one
 * another **after projection**, which is a different question from the flat
 * world's and is checked as such in themes.test.ts. Capacities sum to 30
 * across the work zone, which is what keeps twenty simultaneous agents from
 * stacking.
 */
const STATION_GRID = [
  { key: "arrival", zone: "arrival", planX: 0.62, planY: 0.62, capacity: 6 },
  { key: "work-general", zone: "work", planX: 0.42, planY: 0.42, capacity: 6 },
  { key: "work-research", zone: "work", craft: "research", planX: 0.14, planY: 0.52, capacity: 6 },
  { key: "work-code", zone: "work", craft: "code", planX: 0.52, planY: 0.14, capacity: 6 },
  { key: "work-writing", zone: "work", craft: "writing", planX: 0.14, planY: 0.86, capacity: 6 },
  { key: "work-analysis", zone: "work", craft: "analysis", planX: 0.86, planY: 0.14, capacity: 6 },
  { key: "exchange", zone: "exchange", planX: 0.16, planY: 0.16, capacity: 6 },
  { key: "waiting", zone: "waiting", planX: 0.42, planY: 0.88, capacity: 6 },
  { key: "done", zone: "done", planX: 0.88, planY: 0.42, capacity: 6 },
  { key: "attention", zone: "attention", planX: 0.88, planY: 0.88, capacity: 6 },
] as const satisfies readonly {
  key: string;
  zone: WorldZoneKind;
  craft?: WorldCraft;
  planX: number;
  planY: number;
  capacity: number;
}[];

export type StationKey = (typeof STATION_GRID)[number]["key"];

/** The station a craft prefers, if the grid has one for it. */
export function stationKeyForCraft(craft: WorldCraft): StationKey | null {
  const found = STATION_GRID.find((place) => "craft" in place && place.craft === craft);
  return found ? (found.key as StationKey) : null;
}

/**
 * The floor plan: eleven rooms, none of them overlapping.
 *
 * Read it as the reference does — a headquarters organised around a central
 * lobby, with the specialised rooms on the outside and the general floor and
 * the infrastructure in the middle. In isometric, plan (0, 0) is the far
 * corner at the top of the screen and plan (1, 1) is nearest the viewer, so
 * the exchange room is at the back and the help desk is at the front.
 *
 * `stations` is what ties a room to the people in it. A room with none is
 * infrastructure — see `RoomKey` "infra" — and its card says so rather than
 * being given a station it does not need in order to look busy.
 */
const ROOM_PLAN = [
  { key: "exchange", planX: 0.02, planY: 0.02, width: 0.28, depth: 0.28, stations: ["exchange"] },
  { key: "code", planX: 0.36, planY: 0.02, width: 0.32, depth: 0.28, stations: ["work-code"] },
  { key: "analysis", planX: 0.74, planY: 0.02, width: 0.24, depth: 0.26, stations: ["work-analysis"] },
  { key: "research", planX: 0.02, planY: 0.36, width: 0.28, depth: 0.32, stations: ["work-research"] },
  { key: "operations", planX: 0.32, planY: 0.32, width: 0.22, depth: 0.22, stations: ["work-general"] },
  { key: "infra", planX: 0.58, planY: 0.34, width: 0.18, depth: 0.18, stations: [] },
  { key: "done", planX: 0.76, planY: 0.32, width: 0.22, depth: 0.24, stations: ["done"] },
  { key: "writing", planX: 0.02, planY: 0.74, width: 0.26, depth: 0.24, stations: ["work-writing"] },
  { key: "lobby", planX: 0.54, planY: 0.54, width: 0.22, depth: 0.22, stations: ["arrival"] },
  { key: "rest", planX: 0.32, planY: 0.76, width: 0.24, depth: 0.22, stations: ["waiting"] },
  { key: "alert", planX: 0.76, planY: 0.76, width: 0.22, depth: 0.22, stations: ["attention"] },
] as const satisfies readonly {
  key: string;
  planX: number;
  planY: number;
  width: number;
  depth: number;
  stations: readonly StationKey[];
}[];

export type RoomKey = (typeof ROOM_PLAN)[number]["key"];

/** What a theme has to say about each room. Everything else comes from the plan. */
type RoomDressing = {
  name: string;
  purpose: string;
  accent: WorldRoomAccent;
  fixtures: readonly FixtureSpec[];
};

/** A fixture before it is given an id. */
type FixtureSpec = Omit<WorldFixture, "id">;

// ---------------------------------------------------------------------------
// Authoring helpers
//
// Every theme places furniture with these three, which is what keeps four
// dressings comparable: a desk in the studio is placed by the same call as a
// desk in the office, so the two are the same size and sit in the same
// relation to the person using them.
// ---------------------------------------------------------------------------

/** Anything, placed by hand in plan coordinates. */
function at(
  kind: WorldFixtureKind,
  planX: number,
  planY: number,
  width: number,
  depth: number,
  over: { height?: number; ambient?: boolean; travel?: WorldFixture["travel"] } = {}
): FixtureSpec {
  return { kind, planX, planY, width, depth, ...over };
}

const station = (key: StationKey) => STATION_GRID.find((place) => place.key === key)!;
const roomRect = (key: RoomKey) => ROOM_PLAN.find((room) => room.key === key)!;

/**
 * Furniture immediately behind a station's line.
 *
 * "Behind" in the camera's sense: a smaller plan depth, so the desk is drawn
 * further from the viewer than the people at it and they stand in front of it
 * rather than on it. The flat world solved the same problem by nudging decor
 * a little below the station's line; in isometric it is the same idea
 * expressed in the axis that now means depth.
 */
function atStation(
  key: StationKey,
  kind: WorldFixtureKind,
  over: {
    width?: number;
    depth?: number;
    back?: number;
    height?: number;
    ambient?: boolean;
  } = {}
): FixtureSpec {
  const place = station(key);
  const width = over.width ?? 0.16;
  const depth = over.depth ?? 0.08;
  const back = over.back ?? 0.04;
  return at(
    kind,
    place.planX - back - width / 2,
    place.planY - back - depth / 2,
    width,
    depth,
    { height: over.height, ambient: over.ambient }
  );
}

/**
 * A tall piece flat against one of a room's two back walls.
 *
 * Tall furniture goes here and only here, and that is a rule with a reason
 * rather than a preference. Anything over `OCCLUDER_HEIGHT` can hide a figure,
 * and the character layer is DOM above the SVG so the painter's algorithm
 * cannot help — see `occludesStation` in architecture.ts. A back wall is the
 * one place in a room that is behind every station in it.
 */
function alongWall(
  key: RoomKey,
  wall: "x" | "y",
  kind: WorldFixtureKind,
  over: { from?: number; to?: number; thickness?: number; height?: number; ambient?: boolean } = {}
): FixtureSpec {
  const room = roomRect(key);
  const thickness = over.thickness ?? 0.03;
  const from = over.from ?? 0.15;
  const to = over.to ?? 0.85;

  if (wall === "y") {
    // Runs along +x, against the room's low-y edge.
    return at(
      kind,
      room.planX + room.width * from,
      room.planY + 0.01,
      room.width * (to - from),
      thickness,
      { height: over.height, ambient: over.ambient }
    );
  }
  // Runs along +y, against the room's low-x edge.
  return at(
    kind,
    room.planX + 0.01,
    room.planY + room.depth * from,
    thickness,
    room.depth * (to - from),
    { height: over.height, ambient: over.ambient }
  );
}

/** A point inside a room, as a fraction of its rectangle. Keeps props off the walls. */
function inRoom(
  key: RoomKey,
  kind: WorldFixtureKind,
  fx: number,
  fy: number,
  size = 0.035,
  over: { height?: number; ambient?: boolean } = {}
): FixtureSpec {
  const room = roomRect(key);
  return at(
    kind,
    room.planX + room.width * fx - size / 2,
    room.planY + room.depth * fy - size / 2,
    size,
    size,
    over
  );
}

// ---------------------------------------------------------------------------
// The four dressings
// ---------------------------------------------------------------------------

/**
 * Office headquarters.
 *
 * The first reference: a cut-away floor of rooms around a central lobby, each
 * one legible from its furniture alone. Desks and meeting tables, a wall of
 * screens in the command room, shelving in the archive, a server room nobody
 * works in.
 */
const OFFICE_ROOMS: Record<RoomKey, RoomDressing> = {
  exchange: {
    name: "Collaboration Hub",
    purpose: "Where agents meet to hand work over to each other.",
    accent: "command",
    fixtures: [
      atStation("exchange", "table", { width: 0.17, depth: 0.1 }),
      alongWall("exchange", "y", "screen-wall", { from: 0.1, to: 0.6, ambient: true }),
      alongWall("exchange", "x", "whiteboard", { from: 0.1, to: 0.55 }),
      inRoom("exchange", "seat", 0.24, 0.78, 0.04),
      inRoom("exchange", "seat", 0.76, 0.78, 0.04),
      inRoom("exchange", "plant", 0.9, 0.9, 0.035),
    ],
  },
  code: {
    name: "Development Room",
    purpose: "Runs writing, refactoring and fixing code work here.",
    accent: "code",
    fixtures: [
      atStation("work-code", "desk", { width: 0.2, depth: 0.09 }),
      atStation("work-code", "workstation", { width: 0.09, depth: 0.04, back: 0.075 }),
      alongWall("code", "y", "screen-wall", { from: 0.08, to: 0.52, ambient: true }),
      alongWall("code", "x", "shelf", { from: 0.12, to: 0.6 }),
      inRoom("code", "seat", 0.28, 0.72, 0.04),
      inRoom("code", "seat", 0.6, 0.78, 0.04),
      inRoom("code", "plant", 0.9, 0.86, 0.035),
    ],
  },
  analysis: {
    name: "Analysis Room",
    purpose: "Runs measuring, auditing and querying data work here.",
    accent: "analysis",
    fixtures: [
      atStation("work-analysis", "desk", { width: 0.16, depth: 0.08 }),
      alongWall("analysis", "y", "screen-wall", { from: 0.1, to: 0.7, ambient: true }),
      alongWall("analysis", "x", "shelf", { from: 0.15, to: 0.6 }),
      inRoom("analysis", "seat", 0.35, 0.78, 0.04),
      inRoom("analysis", "plant", 0.86, 0.88, 0.035),
    ],
  },
  research: {
    name: "Research Lab",
    purpose: "Runs reading, exploring and looking things up work here.",
    accent: "research",
    fixtures: [
      atStation("work-research", "desk", { width: 0.17, depth: 0.09 }),
      atStation("work-research", "workstation", { width: 0.08, depth: 0.04, back: 0.08 }),
      alongWall("research", "x", "shelf", { from: 0.05, to: 0.55 }),
      alongWall("research", "y", "whiteboard", { from: 0.15, to: 0.75 }),
      inRoom("research", "seat", 0.3, 0.72, 0.04),
      inRoom("research", "lamp", 0.86, 0.2, 0.025),
      inRoom("research", "plant", 0.86, 0.9, 0.035),
    ],
  },
  operations: {
    name: "Operations Floor",
    purpose: "The general floor. Work whose kind has not been reported happens here.",
    accent: "neutral",
    fixtures: [
      atStation("work-general", "desk", { width: 0.13, depth: 0.07, back: 0.035 }),
      inRoom("operations", "seat", 0.3, 0.8, 0.04),
      inRoom("operations", "seat", 0.72, 0.84, 0.04),
      inRoom("operations", "rug", 0.5, 0.6, 0.14),
    ],
  },
  infra: {
    name: "Data Centre",
    purpose: "Infrastructure. No agent works in here; it keeps the rest running.",
    accent: "infra",
    fixtures: [
      alongWall("infra", "y", "server-rack", { from: 0.08, to: 0.92, thickness: 0.04, ambient: true }),
      alongWall("infra", "x", "server-rack", { from: 0.05, to: 0.45, thickness: 0.04 }),
      at("server-rack", 0.64, 0.44, 0.1, 0.035, { ambient: true }),
      inRoom("infra", "crate", 0.8, 0.82, 0.045),
    ],
  },
  done: {
    name: "Archive",
    purpose: "Finished runs, and what they produced.",
    accent: "done",
    fixtures: [
      atStation("done", "counter", { width: 0.14, depth: 0.07 }),
      alongWall("done", "y", "shelf", { from: 0.1, to: 0.72 }),
      alongWall("done", "x", "shelf", { from: 0.15, to: 0.8 }),
      inRoom("done", "crate", 0.35, 0.85, 0.04),
      inRoom("done", "plant", 0.82, 0.9, 0.035),
    ],
  },
  writing: {
    name: "Writing Studio",
    purpose: "Runs drafting, summarising and editing prose work here.",
    accent: "writing",
    fixtures: [
      atStation("work-writing", "desk", { width: 0.16, depth: 0.08 }),
      alongWall("writing", "x", "shelf", { from: 0.08, to: 0.55 }),
      alongWall("writing", "y", "whiteboard", { from: 0.2, to: 0.8 }),
      inRoom("writing", "seat", 0.32, 0.78, 0.04),
      inRoom("writing", "lamp", 0.84, 0.28, 0.025),
      inRoom("writing", "plant", 0.82, 0.88, 0.035),
    ],
  },
  lobby: {
    name: "Central Lobby",
    purpose: "Where connected agents wait between runs.",
    accent: "neutral",
    fixtures: [
      atStation("arrival", "counter", { width: 0.14, depth: 0.06, back: 0.05 }),
      inRoom("lobby", "rug", 0.55, 0.6, 0.13),
      inRoom("lobby", "seat", 0.28, 0.82, 0.04),
      inRoom("lobby", "plant", 0.86, 0.3, 0.04),
      inRoom("lobby", "plant", 0.2, 0.22, 0.035),
    ],
  },
  rest: {
    name: "Break Area",
    purpose: "Runs that are starting up, or stalled waiting on something.",
    accent: "rest",
    fixtures: [
      atStation("waiting", "table", { width: 0.13, depth: 0.07, back: 0.035 }),
      alongWall("rest", "y", "counter", { from: 0.1, to: 0.6, thickness: 0.035 }),
      inRoom("rest", "seat", 0.28, 0.8, 0.04),
      inRoom("rest", "seat", 0.68, 0.86, 0.04),
      inRoom("rest", "plant", 0.9, 0.5, 0.035),
    ],
  },
  alert: {
    name: "Help Desk",
    purpose: "Runs that failed or are blocked, where they can be seen.",
    accent: "alert",
    fixtures: [
      atStation("attention", "counter", { width: 0.13, depth: 0.07, back: 0.035 }),
      alongWall("alert", "y", "screen-wall", { from: 0.12, to: 0.7, ambient: true }),
      alongWall("alert", "x", "whiteboard", { from: 0.2, to: 0.8 }),
      inRoom("alert", "seat", 0.3, 0.82, 0.04),
    ],
  },
};

const OFFICE_BACKDROP: readonly FixtureSpec[] = [
  at("plant", 0.31, 0.62, 0.04, 0.04),
  at("plant", 0.63, 0.31, 0.04, 0.04),
  at("plant", 0.7, 0.72, 0.04, 0.04),
  at("lamp", 0.31, 0.3, 0.025, 0.025),
  at("lamp", 0.7, 0.02, 0.025, 0.025),
];

/**
 * Futuristic AI city.
 *
 * The second reference: a deck in orbit, districts joined by elevated
 * roadways, a skyline standing behind it. The skyline lives in the backdrop
 * at negative plan coordinates — behind the floor, where nothing stands —
 * which is what lets it be as tall as it likes without ever hiding an agent.
 */
const CITY_ROOMS: Record<RoomKey, RoomDressing> = {
  exchange: {
    name: "Comms Relay",
    purpose: "Where agents hand work over. Its dishes carry the traffic between districts.",
    accent: "command",
    fixtures: [
      atStation("exchange", "platform", { width: 0.17, depth: 0.1 }),
      atStation("exchange", "table", { width: 0.13, depth: 0.07 }),
      alongWall("exchange", "y", "screen-wall", { from: 0.1, to: 0.6, ambient: true }),
      inRoom("exchange", "antenna", 0.12, 0.2, 0.025, { ambient: true }),
      inRoom("exchange", "antenna", 0.3, 0.1, 0.02),
      inRoom("exchange", "pillar", 0.88, 0.14, 0.03),
    ],
  },
  code: {
    name: "Fabrication Yard",
    purpose: "Runs writing, refactoring and fixing code work here.",
    accent: "code",
    fixtures: [
      atStation("work-code", "platform", { width: 0.18, depth: 0.1 }),
      atStation("work-code", "workstation", { width: 0.17, depth: 0.07 }),
      alongWall("code", "y", "spire", { from: 0.1, to: 0.3, thickness: 0.05, ambient: true }),
      alongWall("code", "x", "crate", { from: 0.2, to: 0.7, thickness: 0.04 }),
      inRoom("code", "pillar", 0.85, 0.2, 0.03),
      at("roadway", 0.5, 0.3, 0.04, 0.26),
      at("vehicle", 0.505, 0.31, 0.03, 0.03, { travel: { dx: 0, dy: 0.22, seconds: 9 } }),
    ],
  },
  analysis: {
    name: "Analytics Array",
    purpose: "Runs measuring, auditing and querying data work here.",
    accent: "analysis",
    fixtures: [
      atStation("work-analysis", "platform", { width: 0.17, depth: 0.1 }),
      atStation("work-analysis", "workstation", { width: 0.14, depth: 0.06 }),
      alongWall("analysis", "y", "solar-array", { from: 0.1, to: 0.8, thickness: 0.05 }),
      inRoom("analysis", "antenna", 0.2, 0.2, 0.022, { ambient: true }),
      inRoom("analysis", "pillar", 0.85, 0.85, 0.03),
    ],
  },
  research: {
    name: "Research Spire",
    purpose: "Runs reading, exploring and looking things up work here.",
    accent: "research",
    fixtures: [
      atStation("work-research", "platform", { width: 0.17, depth: 0.1 }),
      atStation("work-research", "workstation", { width: 0.14, depth: 0.06 }),
      alongWall("research", "x", "spire", { from: 0.04, to: 0.24, thickness: 0.05, ambient: true }),
      alongWall("research", "y", "screen-wall", { from: 0.3, to: 0.8 }),
      inRoom("research", "antenna", 0.84, 0.18, 0.022),
      at("roadway", 0.3, 0.5, 0.24, 0.04),
      at("vehicle", 0.31, 0.505, 0.03, 0.03, { travel: { dx: 0.2, dy: 0, seconds: 11 } }),
    ],
  },
  operations: {
    name: "Operations Deck",
    purpose: "The general deck. Work whose kind has not been reported happens here.",
    accent: "neutral",
    fixtures: [
      atStation("work-general", "platform", { width: 0.17, depth: 0.1, back: 0.03 }),
      inRoom("operations", "crate", 0.28, 0.82, 0.04),
      inRoom("operations", "pillar", 0.85, 0.85, 0.028),
    ],
  },
  infra: {
    name: "Power Core",
    purpose: "Infrastructure. No agent works here; it powers the deck.",
    accent: "infra",
    fixtures: [
      at("server-rack", 0.62, 0.38, 0.1, 0.1, { height: 44, ambient: true }),
      alongWall("infra", "y", "server-rack", { from: 0.1, to: 0.4, thickness: 0.04 }),
      alongWall("infra", "x", "server-rack", { from: 0.05, to: 0.45, thickness: 0.04, ambient: true }),
      inRoom("infra", "pillar", 0.88, 0.88, 0.03),
    ],
  },
  done: {
    name: "Archive Vault",
    purpose: "Finished runs, and what they produced.",
    accent: "done",
    fixtures: [
      atStation("done", "platform", { width: 0.15, depth: 0.09 }),
      at("spire", 0.88, 0.335, 0.05, 0.05),
      alongWall("done", "x", "crate", { from: 0.25, to: 0.75, thickness: 0.04 }),
      inRoom("done", "pillar", 0.82, 0.88, 0.03),
    ],
  },
  writing: {
    name: "Signal Studio",
    purpose: "Runs drafting, summarising and editing prose work here.",
    accent: "writing",
    fixtures: [
      atStation("work-writing", "platform", { width: 0.17, depth: 0.1 }),
      atStation("work-writing", "workstation", { width: 0.14, depth: 0.06 }),
      alongWall("writing", "x", "screen-wall", { from: 0.1, to: 0.6, ambient: true }),
      inRoom("writing", "antenna", 0.8, 0.22, 0.022),
      inRoom("writing", "pillar", 0.84, 0.86, 0.028),
    ],
  },
  lobby: {
    name: "Central Plaza",
    purpose: "Where connected agents wait between runs.",
    accent: "neutral",
    fixtures: [
      atStation("arrival", "platform", { width: 0.18, depth: 0.1, back: 0.04 }),
      inRoom("lobby", "roadway", 0.5, 0.5, 0.16),
      inRoom("lobby", "pillar", 0.18, 0.2, 0.03),
      inRoom("lobby", "pillar", 0.86, 0.24, 0.03),
    ],
  },
  rest: {
    name: "Transit Platform",
    purpose: "Runs that are starting up, or stalled waiting on something.",
    accent: "rest",
    fixtures: [
      atStation("waiting", "platform", { width: 0.16, depth: 0.09, back: 0.035 }),
      alongWall("rest", "y", "roadway", { from: 0.05, to: 0.95, thickness: 0.045 }),
      at("vehicle", 0.34, 0.775, 0.03, 0.03, { travel: { dx: 0.18, dy: 0, seconds: 7 } }),
      inRoom("rest", "pillar", 0.9, 0.7, 0.028),
    ],
  },
  alert: {
    name: "Beacon Tower",
    purpose: "Runs that failed or are blocked, where they can be seen.",
    accent: "alert",
    fixtures: [
      atStation("attention", "platform", { width: 0.16, depth: 0.09, back: 0.035 }),
      at("spire", 0.93, 0.765, 0.05, 0.05, { ambient: true }),
      inRoom("alert", "antenna", 0.75, 0.2, 0.024),
    ],
  },
};

/**
 * The skyline, and the deck's own edge.
 *
 * At negative plan coordinates, which is to say off the back of the floor. A
 * tower there is further from the camera than every station, so it can be as
 * tall as the stage allows and still never hide anyone — the constraint that
 * makes the reference's scale possible at all without giving up the DOM
 * character layer.
 */
/**
 * A structure standing just outside one of the deck's two far edges.
 *
 * `t` runs along that edge, from the back corner (0) to the side corner (1),
 * and the structure is set back from it by a fixed margin. Which is to say
 * the skyline follows the **rim** rather than a line of constant depth, and
 * that distinction is the whole of it: the deck is a diamond on screen, so a
 * row of towers at one depth touches it only at the back corner and floats
 * further and further above it towards the sides. Following the rim puts
 * every tower immediately behind the deck it overlooks.
 */
function skyline(
  kind: WorldFixtureKind,
  side: "left" | "right",
  t: number,
  size: number,
  height: number,
  ambient = false
): FixtureSpec {
  const back = 0.04 + size;
  return side === "left"
    ? at(kind, -back, t, size, size, { height, ambient })
    : at(kind, t, -back, size, size, { height, ambient });
}

const CITY_BACKDROP: readonly FixtureSpec[] = [
  skyline("tower", "left", 0.02, 0.09, 132, true),
  skyline("tower", "left", 0.2, 0.08, 96),
  skyline("spire", "left", 0.36, 0.06, 186),
  skyline("tower", "left", 0.5, 0.09, 118, true),
  skyline("tower", "left", 0.68, 0.08, 150),
  skyline("tower", "left", 0.84, 0.07, 88),
  skyline("antenna", "left", 0.62, 0.02, 84, true),

  skyline("tower", "right", 0.06, 0.08, 104),
  skyline("tower", "right", 0.22, 0.09, 164, true),
  skyline("tower", "right", 0.4, 0.07, 92),
  skyline("spire", "right", 0.54, 0.06, 176),
  skyline("tower", "right", 0.7, 0.09, 124, true),
  skyline("tower", "right", 0.86, 0.08, 98),
  skyline("antenna", "right", 0.32, 0.02, 76),

  // Solar panels laid flat just off the rim, so the deck reads as a platform
  // with infrastructure attached rather than as a floor with a view.
  skyline("solar-array", "left", 0.26, 0.14, 0),
  skyline("solar-array", "right", 0.58, 0.14, 0),
];

/**
 * Command center.
 *
 * One dark room around an orchestration table, with consoles instead of desks
 * and a wall of boards at the back. The most utilitarian of the four, and the
 * one that reads best at minimal density.
 */
const COMMAND_ROOMS: Record<RoomKey, RoomDressing> = {
  exchange: {
    name: "Briefing Ring",
    purpose: "Where agents hand work over to each other.",
    accent: "command",
    fixtures: [
      atStation("exchange", "table", { width: 0.17, depth: 0.1 }),
      alongWall("exchange", "y", "screen-wall", { from: 0.06, to: 0.9, ambient: true }),
      alongWall("exchange", "x", "screen-wall", { from: 0.1, to: 0.7 }),
      inRoom("exchange", "seat", 0.26, 0.8, 0.04),
      inRoom("exchange", "seat", 0.74, 0.8, 0.04),
    ],
  },
  code: {
    name: "Build Console",
    purpose: "Runs writing, refactoring and fixing code work here.",
    accent: "code",
    fixtures: [
      atStation("work-code", "workstation", { width: 0.2, depth: 0.09 }),
      alongWall("code", "y", "screen-wall", { from: 0.06, to: 0.62, ambient: true }),
      alongWall("code", "x", "server-rack", { from: 0.15, to: 0.55 }),
      inRoom("code", "seat", 0.3, 0.76, 0.04),
      inRoom("code", "seat", 0.62, 0.8, 0.04),
    ],
  },
  analysis: {
    name: "Telemetry Bay",
    purpose: "Runs measuring, auditing and querying data work here.",
    accent: "analysis",
    fixtures: [
      atStation("work-analysis", "workstation", { width: 0.16, depth: 0.08 }),
      alongWall("analysis", "y", "screen-wall", { from: 0.08, to: 0.75, ambient: true }),
      alongWall("analysis", "x", "server-rack", { from: 0.2, to: 0.6 }),
      inRoom("analysis", "seat", 0.36, 0.8, 0.04),
    ],
  },
  research: {
    name: "Intel Desk",
    purpose: "Runs reading, exploring and looking things up work here.",
    accent: "research",
    fixtures: [
      atStation("work-research", "workstation", { width: 0.17, depth: 0.09 }),
      alongWall("research", "x", "screen-wall", { from: 0.05, to: 0.5, ambient: true }),
      alongWall("research", "y", "shelf", { from: 0.2, to: 0.7 }),
      inRoom("research", "seat", 0.32, 0.74, 0.04),
      inRoom("research", "lamp", 0.85, 0.22, 0.025),
    ],
  },
  operations: {
    name: "Main Floor",
    purpose: "The general floor. Work whose kind has not been reported happens here.",
    accent: "neutral",
    fixtures: [
      atStation("work-general", "workstation", { width: 0.13, depth: 0.07, back: 0.035 }),
      inRoom("operations", "rug", 0.5, 0.6, 0.14),
      inRoom("operations", "seat", 0.3, 0.82, 0.04),
    ],
  },
  infra: {
    name: "Core Stack",
    purpose: "Infrastructure. No agent works here; it keeps the boards lit.",
    accent: "infra",
    fixtures: [
      alongWall("infra", "y", "server-rack", { from: 0.08, to: 0.92, thickness: 0.04, ambient: true }),
      alongWall("infra", "x", "server-rack", { from: 0.05, to: 0.45, thickness: 0.04 }),
      at("server-rack", 0.64, 0.45, 0.09, 0.035, { ambient: true }),
    ],
  },
  done: {
    name: "Log Wall",
    purpose: "Finished runs, and what they produced.",
    accent: "done",
    fixtures: [
      atStation("done", "counter", { width: 0.14, depth: 0.07 }),
      alongWall("done", "y", "screen-wall", { from: 0.1, to: 0.72 }),
      alongWall("done", "x", "shelf", { from: 0.2, to: 0.75 }),
      inRoom("done", "crate", 0.35, 0.85, 0.04),
    ],
  },
  writing: {
    name: "Dispatch Desk",
    purpose: "Runs drafting, summarising and editing prose work here.",
    accent: "writing",
    fixtures: [
      atStation("work-writing", "workstation", { width: 0.16, depth: 0.08 }),
      alongWall("writing", "x", "screen-wall", { from: 0.08, to: 0.58, ambient: true }),
      alongWall("writing", "y", "shelf", { from: 0.25, to: 0.8 }),
      inRoom("writing", "seat", 0.34, 0.78, 0.04),
    ],
  },
  lobby: {
    name: "Standby Ring",
    purpose: "Where connected agents wait between runs.",
    accent: "neutral",
    fixtures: [
      atStation("arrival", "counter", { width: 0.14, depth: 0.06, back: 0.05 }),
      inRoom("lobby", "rug", 0.55, 0.6, 0.13),
      inRoom("lobby", "seat", 0.26, 0.8, 0.04),
      inRoom("lobby", "lamp", 0.86, 0.26, 0.025),
    ],
  },
  rest: {
    name: "Holding Bay",
    purpose: "Runs that are starting up, or stalled waiting on something.",
    accent: "rest",
    fixtures: [
      atStation("waiting", "table", { width: 0.13, depth: 0.07, back: 0.035 }),
      alongWall("rest", "y", "counter", { from: 0.1, to: 0.65, thickness: 0.035 }),
      inRoom("rest", "seat", 0.3, 0.82, 0.04),
      inRoom("rest", "seat", 0.7, 0.86, 0.04),
    ],
  },
  alert: {
    name: "Alert Board",
    purpose: "Runs that failed or are blocked, where they can be seen.",
    accent: "alert",
    fixtures: [
      atStation("attention", "counter", { width: 0.13, depth: 0.07, back: 0.035 }),
      alongWall("alert", "y", "screen-wall", { from: 0.08, to: 0.8, ambient: true }),
      alongWall("alert", "x", "screen-wall", { from: 0.25, to: 0.85 }),
    ],
  },
};

const COMMAND_BACKDROP: readonly FixtureSpec[] = [
  at("pillar", 0.31, 0.31, 0.03, 0.03),
  at("pillar", 0.7, 0.3, 0.03, 0.03),
  at("pillar", 0.3, 0.7, 0.03, 0.03),
  at("lamp", 0.7, 0.72, 0.025, 0.025),
];

/**
 * Studio.
 *
 * The lightest of the four: benches, a gallery wall, and plants. Kept from
 * Phase 18 because it is the one environment that does not look like a
 * control room, and somebody watching one agent write a document should not
 * have to sit in a command centre to do it.
 */
const STUDIO_ROOMS: Record<RoomKey, RoomDressing> = {
  exchange: {
    name: "Review Table",
    purpose: "Where agents hand work over to each other.",
    accent: "command",
    fixtures: [
      atStation("exchange", "table", { width: 0.17, depth: 0.1 }),
      alongWall("exchange", "x", "whiteboard", { from: 0.1, to: 0.7 }),
      inRoom("exchange", "seat", 0.26, 0.8, 0.04),
      inRoom("exchange", "seat", 0.74, 0.8, 0.04),
      inRoom("exchange", "plant", 0.9, 0.2, 0.04),
    ],
  },
  code: {
    name: "Build Bench",
    purpose: "Runs writing, refactoring and fixing code work here.",
    accent: "code",
    fixtures: [
      atStation("work-code", "desk", { width: 0.2, depth: 0.09 }),
      alongWall("code", "y", "shelf", { from: 0.1, to: 0.55 }),
      alongWall("code", "x", "whiteboard", { from: 0.15, to: 0.6 }),
      inRoom("code", "seat", 0.3, 0.76, 0.04),
      inRoom("code", "plant", 0.88, 0.84, 0.04),
    ],
  },
  analysis: {
    name: "Proofing Bay",
    purpose: "Runs measuring, auditing and querying data work here.",
    accent: "analysis",
    fixtures: [
      atStation("work-analysis", "desk", { width: 0.16, depth: 0.08 }),
      alongWall("analysis", "y", "whiteboard", { from: 0.1, to: 0.7 }),
      inRoom("analysis", "seat", 0.36, 0.8, 0.04),
      inRoom("analysis", "plant", 0.86, 0.86, 0.04),
    ],
  },
  research: {
    name: "Reading Room",
    purpose: "Runs reading, exploring and looking things up work here.",
    accent: "research",
    fixtures: [
      atStation("work-research", "desk", { width: 0.17, depth: 0.09 }),
      alongWall("research", "x", "shelf", { from: 0.05, to: 0.6 }),
      inRoom("research", "seat", 0.32, 0.74, 0.04),
      inRoom("research", "lamp", 0.85, 0.24, 0.025),
      inRoom("research", "plant", 0.84, 0.88, 0.04),
    ],
  },
  operations: {
    name: "Studio Floor",
    purpose: "The general floor. Work whose kind has not been reported happens here.",
    accent: "neutral",
    fixtures: [
      atStation("work-general", "desk", { width: 0.13, depth: 0.07, back: 0.035 }),
      inRoom("operations", "rug", 0.5, 0.6, 0.14),
      inRoom("operations", "seat", 0.3, 0.82, 0.04),
    ],
  },
  infra: {
    name: "Store Room",
    purpose: "Infrastructure. No agent works in here; it holds the materials.",
    accent: "infra",
    fixtures: [
      alongWall("infra", "y", "shelf", { from: 0.08, to: 0.92, thickness: 0.04 }),
      alongWall("infra", "x", "shelf", { from: 0.05, to: 0.45, thickness: 0.04 }),
      // A work surface, so the store room still reads as a room at minimal
      // detail — where shelves and crates are both dropped.
      inRoom("infra", "counter", 0.62, 0.62, 0.09),
      inRoom("infra", "crate", 0.82, 0.86, 0.045),
    ],
  },
  done: {
    name: "Gallery",
    purpose: "Finished runs, and what they produced.",
    accent: "done",
    fixtures: [
      atStation("done", "counter", { width: 0.14, depth: 0.07 }),
      alongWall("done", "y", "whiteboard", { from: 0.1, to: 0.72 }),
      alongWall("done", "x", "whiteboard", { from: 0.2, to: 0.8 }),
      inRoom("done", "plant", 0.82, 0.88, 0.04),
    ],
  },
  writing: {
    name: "Writing Desk",
    purpose: "Runs drafting, summarising and editing prose work here.",
    accent: "writing",
    fixtures: [
      atStation("work-writing", "desk", { width: 0.16, depth: 0.08 }),
      alongWall("writing", "x", "shelf", { from: 0.08, to: 0.6 }),
      inRoom("writing", "seat", 0.34, 0.78, 0.04),
      inRoom("writing", "lamp", 0.84, 0.3, 0.025),
      inRoom("writing", "plant", 0.82, 0.88, 0.04),
    ],
  },
  lobby: {
    name: "Foyer",
    purpose: "Where connected agents wait between runs.",
    accent: "neutral",
    fixtures: [
      atStation("arrival", "counter", { width: 0.14, depth: 0.06, back: 0.05 }),
      inRoom("lobby", "rug", 0.55, 0.6, 0.13),
      inRoom("lobby", "plant", 0.84, 0.28, 0.04),
      inRoom("lobby", "seat", 0.26, 0.8, 0.04),
    ],
  },
  rest: {
    name: "Green Room",
    purpose: "Runs that are starting up, or stalled waiting on something.",
    accent: "rest",
    fixtures: [
      atStation("waiting", "table", { width: 0.13, depth: 0.07, back: 0.035 }),
      inRoom("rest", "seat", 0.3, 0.82, 0.04),
      inRoom("rest", "seat", 0.7, 0.86, 0.04),
      inRoom("rest", "plant", 0.9, 0.45, 0.04),
    ],
  },
  alert: {
    name: "Notes Board",
    purpose: "Runs that failed or are blocked, where they can be seen.",
    accent: "alert",
    fixtures: [
      atStation("attention", "counter", { width: 0.13, depth: 0.07, back: 0.035 }),
      alongWall("alert", "y", "whiteboard", { from: 0.1, to: 0.8 }),
      inRoom("alert", "seat", 0.32, 0.82, 0.04),
    ],
  },
};

const STUDIO_BACKDROP: readonly FixtureSpec[] = [
  at("plant", 0.31, 0.31, 0.045, 0.045),
  at("plant", 0.7, 0.3, 0.04, 0.04),
  at("plant", 0.3, 0.7, 0.04, 0.04),
  at("lamp", 0.7, 0.71, 0.025, 0.025),
];

// ---------------------------------------------------------------------------
// Assembly
// ---------------------------------------------------------------------------

/** Builds a theme's stations from the shared grid plus its own names. */
function stationsFrom(themeId: WorldThemeId, labels: Record<StationKey, string>): WorldStation[] {
  return STATION_GRID.map((place) => {
    const projected = projectPlanNormalized(place.planX, place.planY);
    return {
      id: `${themeId}-${place.key}`,
      zone: place.zone,
      ...("craft" in place ? { craft: place.craft as WorldCraft } : {}),
      label: labels[place.key as StationKey],
      planX: place.planX,
      planY: place.planY,
      x: projected.x,
      y: projected.y,
      capacity: place.capacity,
    };
  });
}

/** Builds a theme's rooms from the shared plan plus its own dressing. */
function roomsFrom(
  themeId: WorldThemeId,
  dressing: Record<RoomKey, RoomDressing>,
  options: { walls: boolean }
): WorldRoom[] {
  return ROOM_PLAN.map((plan) => {
    const room = dressing[plan.key as RoomKey];
    return {
      id: `${themeId}-${plan.key}`,
      name: room.name,
      purpose: room.purpose,
      accent: room.accent,
      planX: plan.planX,
      planY: plan.planY,
      width: plan.width,
      depth: plan.depth,
      stationIds: plan.stations.map((key) => `${themeId}-${key}`),
      walls: options.walls,
      fixtures: room.fixtures.map((fixture, index) => ({
        ...fixture,
        id: `${themeId}-${plan.key}-${index}`,
      })),
    };
  });
}

function backdropFrom(themeId: WorldThemeId, items: readonly FixtureSpec[]): WorldFixture[] {
  return items.map((fixture, index) => ({ ...fixture, id: `${themeId}-backdrop-${index}` }));
}

const OFFICE: WorldTheme = {
  id: "office",
  name: "Office headquarters",
  description: "A cut-away floor: specialised rooms around a central lobby.",
  setting: "interior",
  spaceLabel: "office headquarters",
  stations: stationsFrom("office", {
    arrival: "Central Lobby",
    "work-general": "Operations Floor",
    "work-research": "Research Lab",
    "work-code": "Development Room",
    "work-writing": "Writing Studio",
    "work-analysis": "Analysis Room",
    exchange: "Collaboration Hub",
    waiting: "Break Area",
    done: "Archive",
    attention: "Help Desk",
  }),
  rooms: roomsFrom("office", OFFICE_ROOMS, { walls: true }),
  backdrop: backdropFrom("office", OFFICE_BACKDROP),
};

const CITY: WorldTheme = {
  id: "city",
  name: "Futuristic AI city",
  description: "An orbital deck: districts, elevated roads, and a skyline behind them.",
  setting: "exterior",
  spaceLabel: "city deck",
  stations: stationsFrom("city", {
    arrival: "Central Plaza",
    "work-general": "Operations Deck",
    "work-research": "Research Spire",
    "work-code": "Fabrication Yard",
    "work-writing": "Signal Studio",
    "work-analysis": "Analytics Array",
    exchange: "Comms Relay",
    waiting: "Transit Platform",
    done: "Archive Vault",
    attention: "Beacon Tower",
  }),
  rooms: roomsFrom("city", CITY_ROOMS, { walls: false }),
  backdrop: backdropFrom("city", CITY_BACKDROP),
};

const COMMAND_CENTER: WorldTheme = {
  id: "command-center",
  name: "Command center",
  description: "Consoles and boards around a central orchestration table.",
  setting: "interior",
  spaceLabel: "command center",
  stations: stationsFrom("command-center", {
    arrival: "Standby Ring",
    "work-general": "Main Floor",
    "work-research": "Intel Desk",
    "work-code": "Build Console",
    "work-writing": "Dispatch Desk",
    "work-analysis": "Telemetry Bay",
    exchange: "Briefing Ring",
    waiting: "Holding Bay",
    done: "Log Wall",
    attention: "Alert Board",
  }),
  rooms: roomsFrom("command-center", COMMAND_ROOMS, { walls: true }),
  backdrop: backdropFrom("command-center", COMMAND_BACKDROP),
};

const STUDIO: WorldTheme = {
  id: "studio",
  name: "Studio",
  description: "Benches, a gallery wall, and room to think.",
  setting: "interior",
  spaceLabel: "studio",
  stations: stationsFrom("studio", {
    arrival: "Foyer",
    "work-general": "Studio Floor",
    "work-research": "Reading Room",
    "work-code": "Build Bench",
    "work-writing": "Writing Desk",
    "work-analysis": "Proofing Bay",
    exchange: "Review Table",
    waiting: "Green Room",
    done: "Gallery",
    attention: "Notes Board",
  }),
  rooms: roomsFrom("studio", STUDIO_ROOMS, { walls: true }),
  backdrop: backdropFrom("studio", STUDIO_BACKDROP),
};

/** In picker order. Office first because it is the most legible at a glance. */
export const WORLD_THEMES: readonly WorldTheme[] = [OFFICE, CITY, COMMAND_CENTER, STUDIO] as const;

export const DEFAULT_WORLD_THEME_ID: WorldThemeId = "office";

const BY_ID = new Map<WorldThemeId, WorldTheme>(WORLD_THEMES.map((theme) => [theme.id, theme]));

/**
 * A theme by id, always.
 *
 * Falls back to the default rather than throwing, because the id can arrive
 * from persisted settings written by a build that shipped a theme this one
 * does not. A world that refused to render because a preference named a
 * retired theme would be a worse outcome than one that renders in the
 * default.
 */
export function getWorldTheme(id: WorldThemeId | string | undefined | null): WorldTheme {
  if (typeof id === "string") {
    const found = BY_ID.get(id as WorldThemeId);
    if (found) return found;
  }
  return BY_ID.get(DEFAULT_WORLD_THEME_ID)!;
}

/** The stations of one zone, in declaration order — which is the order they fill. */
export function stationsInZone(theme: WorldTheme, zone: WorldZoneKind): WorldStation[] {
  return theme.stations.filter((station) => station.zone === zone);
}

/** Total capacity of a zone, before overflow starts stacking. */
export function zoneCapacity(theme: WorldTheme, zone: WorldZoneKind): number {
  return stationsInZone(theme, zone).reduce((total, station) => total + station.capacity, 0);
}

/**
 * Whether a theme can place every zone.
 *
 * Asserted by the theme tests rather than checked at runtime: a theme missing
 * a zone would silently drop every character in that state, which is the kind
 * of bug that only shows up when an agent finally fails. Exported so the test
 * and any future theme author share one definition of "complete".
 */
export function missingZones(theme: WorldTheme): WorldZoneKind[] {
  return WORLD_ZONE_KINDS.filter((zone) => stationsInZone(theme, zone).length === 0);
}

/**
 * The room a station stands in, or null.
 *
 * Derived from the room's own `stationIds` rather than from geometry, so a
 * theme that deliberately places a station outside every rectangle still gets
 * an answer its author chose. `themes.test.ts` checks the two agree.
 */
export function roomForStation(theme: WorldTheme, stationId: string): WorldRoom | null {
  return theme.rooms.find((room) => room.stationIds.includes(stationId)) ?? null;
}

/** A room by id, for the renderer's selection lookups. */
export function roomById(theme: WorldTheme, roomId: string): WorldRoom | null {
  return theme.rooms.find((room) => room.id === roomId) ?? null;
}
