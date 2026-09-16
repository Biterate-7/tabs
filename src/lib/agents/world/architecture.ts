import { boundsOverlap, planDepth, projectedBounds } from "./projection";
import type { StageBounds } from "./projection";

/**
 * The world's buildings.
 *
 * Phase 18's scenery was eight rectangles behind the figures, chosen to
 * suggest a room without claiming to be one. This replaces it with an
 * architecture: named **rooms** with a stated purpose, containing **fixtures**
 * that say what the room is for, laid out on the same floor plan the stations
 * stand on.
 *
 * Three properties are what make it worth the extra model rather than a
 * bigger list of rectangles:
 *
 *   - **A room is a thing you can ask about.** It has a name, a purpose and a
 *     set of stations, so "what is happening in the Research Lab" has an
 *     answer derived from the same scene the figures come from. The renderer
 *     does not have to guess which desk belongs to which room, because the
 *     theme said.
 *   - **Fixtures are data, not drawings.** A fixture names a `kind`; the
 *     table below says which of six primitives draws it and how tall it
 *     stands. Adding a coffee machine is a line in a theme, not a new
 *     component — the same promise `themes.ts` already made about
 *     environments, extended one level down.
 *   - **The geometry is checkable.** Rooms and fixtures are plan rectangles,
 *     so "do these two rooms overlap", "is this station inside its room" and
 *     "does this tower stand in front of somebody's head" are all arithmetic.
 *     `themes.test.ts` asks all three of every theme.
 */

/**
 * What a room is for, as a palette key rather than a colour.
 *
 * The actual colours live in `globals.css` as `--world-accent-*` custom
 * properties, one set per app theme, so the world re-skins in light and dark
 * without a second palette here and without any component holding a hex code.
 */
export type WorldRoomAccent =
  | "neutral"
  | "research"
  | "code"
  | "writing"
  | "analysis"
  | "command"
  | "infra"
  | "done"
  | "alert"
  | "rest";

export const WORLD_ROOM_ACCENTS: readonly WorldRoomAccent[] = [
  "neutral",
  "research",
  "code",
  "writing",
  "analysis",
  "command",
  "infra",
  "done",
  "alert",
  "rest",
] as const;

/**
 * Everything a theme can put in a room.
 *
 * Semantic names rather than shape names, because a theme author is placing a
 * server rack rather than a 34-unit box, and because renaming what a shape
 * looks like should not mean editing four themes.
 */
export type WorldFixtureKind =
  // Interiors
  | "desk"
  | "workstation"
  | "table"
  | "seat"
  | "counter"
  | "shelf"
  | "server-rack"
  | "screen-wall"
  | "whiteboard"
  | "partition"
  | "rug"
  | "plant"
  | "lamp"
  // Exteriors
  | "tower"
  | "spire"
  | "platform"
  | "roadway"
  | "solar-array"
  | "antenna"
  | "crate"
  | "pillar"
  | "vehicle";

/** The six primitives the renderer knows how to draw. */
export type WorldFixtureShape = "flat" | "box" | "screen" | "post" | "plant" | "vehicle";

/** Which of the world's surface tones a fixture is painted in. */
export type WorldFixtureTone = "structure" | "surface" | "accent" | "glass" | "foliage";

export type WorldFixtureRender = {
  shape: WorldFixtureShape;
  /** Stage units tall. Zero for anything that lies on the floor. */
  height: number;
  tone: WorldFixtureTone;
  /** Whether this kind carries a lit face by default. */
  glow?: boolean;
};

/**
 * How each kind is drawn.
 *
 * One table, consulted by one renderer. A fixture's own `height` overrides
 * this one — a theme with a taller tower says so at the point it places it —
 * and everything else is fixed, so a desk in the office and a desk in the
 * studio are recognisably the same object.
 */
export const FIXTURE_RENDER: Record<WorldFixtureKind, WorldFixtureRender> = {
  desk: { shape: "box", height: 11, tone: "surface" },
  workstation: { shape: "box", height: 10, tone: "surface", glow: true },
  table: { shape: "box", height: 10, tone: "surface" },
  seat: { shape: "box", height: 8, tone: "structure" },
  counter: { shape: "box", height: 14, tone: "surface" },
  shelf: { shape: "box", height: 26, tone: "structure" },
  "server-rack": { shape: "box", height: 32, tone: "structure", glow: true },
  "screen-wall": { shape: "screen", height: 30, tone: "glass", glow: true },
  whiteboard: { shape: "screen", height: 26, tone: "surface" },
  partition: { shape: "screen", height: 20, tone: "structure" },
  rug: { shape: "flat", height: 0, tone: "structure" },
  plant: { shape: "plant", height: 18, tone: "foliage" },
  lamp: { shape: "post", height: 20, tone: "structure", glow: true },

  tower: { shape: "box", height: 120, tone: "structure", glow: true },
  spire: { shape: "box", height: 80, tone: "structure", glow: true },
  platform: { shape: "box", height: 5, tone: "structure" },
  roadway: { shape: "flat", height: 0, tone: "accent" },
  "solar-array": { shape: "flat", height: 0, tone: "glass" },
  antenna: { shape: "post", height: 46, tone: "structure", glow: true },
  crate: { shape: "box", height: 12, tone: "structure" },
  pillar: { shape: "post", height: 22, tone: "structure" },
  vehicle: { shape: "vehicle", height: 7, tone: "accent", glow: true },
};

/**
 * One object in a room.
 *
 * Plan coordinates like everything else, so a fixture can be checked against
 * a station, a room and another fixture without anything being converted
 * first. `height` overrides the kind's default; `ambient` opts this one piece
 * into the environment's faint movement.
 */
export type WorldFixture = {
  id: string;
  kind: WorldFixtureKind;
  planX: number;
  planY: number;
  width: number;
  depth: number;
  /** Stage units. Defaults to the kind's own height. */
  height?: number;
  /**
   * Whether this piece carries the theme's ambient animation.
   *
   * A minority of fixtures on purpose. The rule is the one Phase 18 set and
   * this phase keeps: the world may look alive, and the working agent must
   * still dominate it. The renderer caps the amplitude; this flag caps the
   * count, and `themes.test.ts` asserts it stays a minority.
   */
  ambient?: boolean;
  /**
   * The plan-space vector a travelling fixture runs along, and how long it
   * takes.
   *
   * Only meaningful for `vehicle`. The renderer projects the vector once and
   * hands the result to one CSS keyframe as two custom properties, exactly as
   * the handoff packet already does — so a dozen vehicles cost a dozen
   * composited transforms and not one JavaScript timer. `seconds` differs per
   * vehicle so that two on the same road stop looking like a train.
   */
  travel?: { dx: number; dy: number; seconds: number };
};

/**
 * How much detail a fixture is.
 *
 * Tier 0 is what a room needs to be that room at all — the desk, the console,
 * the tower. Tier 1 is the furniture that makes it convincing. Tier 2 is the
 * seats, plants and traffic that make it feel inhabited. Visual detail drops
 * them from the top down, which is why "minimal" still reads as an office
 * rather than as an empty floor with people standing on it.
 */
export const FIXTURE_TIER: Record<WorldFixtureKind, 0 | 1 | 2> = {
  desk: 0,
  workstation: 0,
  table: 0,
  counter: 0,
  "screen-wall": 0,
  "server-rack": 0,
  platform: 0,
  tower: 0,
  spire: 0,

  shelf: 1,
  whiteboard: 1,
  partition: 1,
  roadway: 1,
  "solar-array": 1,
  antenna: 1,
  pillar: 1,
  rug: 1,
  vehicle: 1,
  seat: 1,
  plant: 1,

  lamp: 2,
  crate: 2,
};

/**
 * A named part of the world, with a purpose and possibly some stations.
 *
 * A room with no stations is not a mistake. Infrastructure — a data centre, a
 * solar deck — is part of what makes the place read as a working headquarters,
 * and the honest thing is to draw it, let someone click it, and have its card
 * say plainly that no agent works there. The alternative, giving it a station
 * so it looks busy, would be the world telling a small lie to look better.
 */
export type WorldRoom = {
  id: string;
  name: string;
  /** One sentence. Shown when the room is selected, and used as its accessible description. */
  purpose: string;
  accent: WorldRoomAccent;
  planX: number;
  planY: number;
  width: number;
  depth: number;
  /** The stations that stand in this room, in the theme's own ids. */
  stationIds: readonly string[];
  /** Whether the two far edges are drawn as walls. False for open decks and plazas. */
  walls?: boolean;
  fixtures: readonly WorldFixture[];
};

/** A fixture's drawn height, with the theme's override applied. */
export function fixtureHeight(fixture: WorldFixture): number {
  return fixture.height ?? FIXTURE_RENDER[fixture.kind].height;
}

/** Painter's order: furthest from the camera first, so nearer things paint over it. */
export function byDepth<T extends { planX: number; planY: number }>(a: T, b: T): number {
  return planDepth(a.planX, a.planY) - planDepth(b.planX, b.planY);
}

/**
 * How high a room's back edges stand, in stage units.
 *
 * Deliberately below `OCCLUDER_HEIGHT`. A miniature with full-height walls is
 * a floor plan you cannot see into, and the reference this phase works from
 * is cut away for exactly that reason. The cheapest way to guarantee the same
 * thing here is to make the walls too short to hide anybody: they read as the
 * raised edges of an architectural model, which is what the world is.
 */
export const ROOM_WALL_HEIGHT = 22;

/** The screen box a room occupies, walls and all. */
export function roomBounds(room: WorldRoom): StageBounds {
  return projectedBounds(room.planX, room.planY, room.width, room.depth, ROOM_WALL_HEIGHT);
}

/** The screen box a fixture occupies, including its height. */
export function fixtureBounds(fixture: WorldFixture): StageBounds {
  return projectedBounds(
    fixture.planX,
    fixture.planY,
    fixture.width,
    fixture.depth,
    fixtureHeight(fixture)
  );
}

/** Whether a plan point lies inside a room's rectangle. */
export function roomContains(room: WorldRoom, planX: number, planY: number): boolean {
  return (
    planX >= room.planX &&
    planX <= room.planX + room.width &&
    planY >= room.planY &&
    planY <= room.planY + room.depth
  );
}

/** Whether two rooms share any floor. */
export function roomsOverlap(a: WorldRoom, b: WorldRoom): boolean {
  return (
    a.planX < b.planX + b.width &&
    b.planX < a.planX + a.width &&
    a.planY < b.planY + b.depth &&
    b.planY < a.planY + a.depth
  );
}

/**
 * How tall a fixture has to be before it can hide somebody.
 *
 * Below this a figure standing behind a fixture still reads clearly — a desk
 * comes up to its occupant's waist, which is what a desk is supposed to do.
 * Above it, the fixture is an occluder, and the occlusion rule applies.
 */
export const OCCLUDER_HEIGHT = 24;

/**
 * Whether a fixture would draw over a character standing at a station.
 *
 * The isometric world's equivalent of Phase 18's "no two station clusters
 * overlap", and it exists for a harder reason. Characters are DOM buttons
 * layered above the scenery SVG, so the painter's algorithm that orders the
 * scenery cannot order *them*: a figure is always drawn on top, whatever
 * stands between it and the camera.
 *
 * Rather than rebuild the character layer inside the SVG and lose every
 * accessibility property that made it DOM in the first place, the themes are
 * authored so the question never arises — anything tall enough to hide a
 * figure stands **behind** every cluster it overlaps on screen, where the
 * figure legitimately draws over it. `themes.test.ts` checks it, so a theme
 * that puts a tower in front of a desk fails the build rather than shipping a
 * head poking through a wall.
 */
export function occludesStation(
  fixture: WorldFixture,
  station: { planX: number; planY: number },
  clusterBounds: StageBounds
): boolean {
  if (fixtureHeight(fixture) < OCCLUDER_HEIGHT) return false;
  // Behind the figure: the figure paints over it, which is correct.
  if (planDepth(fixture.planX, fixture.planY) <= planDepth(station.planX, station.planY)) {
    return false;
  }
  return boundsOverlap(fixtureBounds(fixture), clusterBounds);
}

/** Every fixture in a theme's rooms, flattened, in painter's order. */
export function allFixtures(rooms: readonly WorldRoom[]): WorldFixture[] {
  return rooms.flatMap((room) => room.fixtures).sort(byDepth);
}
