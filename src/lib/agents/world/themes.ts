import { WORLD_ZONE_KINDS } from "./types";
import type { WorldDecor, WorldStation, WorldTheme, WorldThemeId, WorldZoneKind } from "./types";

/**
 * The four environments.
 *
 * Every one of them is **data only**. There is no theme-specific component,
 * no theme-specific layout rule and no `switch (theme)` anywhere in the
 * engine: a theme supplies labels and scenery, and the same code places
 * characters, routes handoffs and handles overflow whatever it was handed.
 * Brief §8 asks that the environments not be four separate systems, and this
 * is the mechanical form of that promise — a fifth theme is an entry in this
 * file.
 *
 * ## One grid, four dressings
 *
 * All four share `STATION_GRID` below: the same eight places, at the same
 * coordinates, with the same capacities. Themes differ in what those places
 * are *called* and in what surrounds them.
 *
 * That is not a shortcut. Two things fall out of it that were worth having:
 *
 *   - **Someone who has learnt to read one world can read all of them.**
 *     Arrival is always left, work is always the middle, finished work is
 *     always right, problems are always low-right. Switching theme changes
 *     the scenery, not where to look.
 *   - **The geometry is verified once.** Station clusters must clear one
 *     another or a busy world draws one crowd on top of another, and that
 *     check (see themes.test.ts, which derives the extents from the layout
 *     engine's own slot spacing) now holds for every theme by construction
 *     rather than by four separate rounds of hand-tuning.
 *
 * A theme that genuinely needed its own arrangement can still have one — the
 * type takes a plain `WorldStation[]`, and nothing requires the grid.
 */

/**
 * Where the eight places are.
 *
 * Coordinates are normalised 0..1 against the stage, never pixels. The stage
 * is whatever size the viewport gives it — a panel on a desktop, a strip on a
 * phone — and a layout in pixels would need re-authoring per breakpoint.
 *
 * Capacities sum to 18 across the work zone, which is what keeps twenty
 * simultaneous agents from stacking: the brief asks for that many to remain
 * usable, and a zone that started piling figures at six would not be.
 */
const STATION_GRID: readonly { key: string; zone: WorldZoneKind; x: number; y: number; capacity: number }[] = [
  { key: "arrival", zone: "arrival", x: 0.16, y: 0.4, capacity: 4 },
  { key: "work-a", zone: "work", x: 0.36, y: 0.22, capacity: 6 },
  { key: "work-b", zone: "work", x: 0.36, y: 0.62, capacity: 6 },
  { key: "work-c", zone: "work", x: 0.58, y: 0.42, capacity: 6 },
  // Not higher than this: a placement coordinate is the figure's feet, so an
  // anchor within one character height of the top hangs its head off the
  // stage. See TOP_MARGIN in ./layout.ts.
  { key: "exchange", zone: "exchange", x: 0.58, y: 0.19, capacity: 3 },
  { key: "waiting", zone: "waiting", x: 0.16, y: 0.8, capacity: 3 },
  { key: "done", zone: "done", x: 0.86, y: 0.26, capacity: 6 },
  { key: "attention", zone: "attention", x: 0.86, y: 0.74, capacity: 6 },
] as const;

type StationKey = (typeof STATION_GRID)[number]["key"];

/** Builds a theme's stations from the shared grid plus its own names. */
function stationsFrom(themeId: WorldThemeId, labels: Record<StationKey, string>): WorldStation[] {
  return STATION_GRID.map((place) => ({
    id: `${themeId}-${place.key}`,
    zone: place.zone,
    label: labels[place.key as StationKey],
    x: place.x,
    y: place.y,
    capacity: place.capacity,
  }));
}

/**
 * Scenery.
 *
 * Deliberately sparse, and deliberately aligned to the station grid: a piece
 * of furniture sits *at* a workstation, just below the line its occupants
 * stand on, so a figure reads as working at something rather than beside a
 * decorative rectangle. Everything else is pushed to the margins.
 *
 * Nothing here is interactive and the whole layer is `aria-hidden` — a screen
 * reader announcing "bench, bench, plant, rack" would stand between someone
 * and the agents they came for.
 */
function decor(themeId: WorldThemeId, items: readonly Omit<WorldDecor, "id">[]): WorldDecor[] {
  return items.map((item, index) => ({ ...item, id: `${themeId}-decor-${index}` }));
}

/**
 * A piece of furniture at a workstation, in the grid's own coordinates.
 *
 * Takes the station's key so the two cannot drift apart: moving a station in
 * `STATION_GRID` moves its desk with it, rather than leaving the desk behind
 * for someone to notice in a screenshot.
 */
function atStation(
  key: StationKey,
  kind: WorldDecor["kind"],
  over: { width?: number; height?: number; dy?: number; ambient?: boolean } = {}
): Omit<WorldDecor, "id"> {
  const place = STATION_GRID.find((entry) => entry.key === key)!;
  const width = over.width ?? 0.18;
  const height = over.height ?? 0.03;
  return {
    kind,
    x: place.x - width / 2,
    // Just below the line the occupants stand on, so the figures are in front
    // of it rather than on top of it.
    y: place.y + (over.dy ?? 0.02),
    width,
    height,
    ...(over.ambient ? { ambient: true } : {}),
  };
}

const OFFICE: WorldTheme = {
  id: "office",
  name: "Office",
  description: "A studio floor: desks, a meeting room, and an archive.",
  spaceLabel: "office floor",
  stations: stationsFrom("office", {
    arrival: "Lobby",
    "work-a": "Research desk",
    "work-b": "Engineering desk",
    "work-c": "Writing desk",
    exchange: "Meeting room",
    waiting: "Break area",
    done: "Archive",
    attention: "Help desk",
  }),
  decor: decor("office", [
    atStation("work-a", "bench"),
    atStation("work-b", "bench"),
    atStation("work-c", "bench"),
    atStation("exchange", "block", { width: 0.16 }),
    atStation("arrival", "panel", { width: 0.14, height: 0.025 }),
    { kind: "screen", x: 0.29, y: 0.06, width: 0.1, height: 0.055, ambient: true },
    { kind: "rack", x: 0.78, y: 0.05, width: 0.16, height: 0.06 },
    { kind: "plant", x: 0.72, y: 0.86, width: 0.03, height: 0.08 },
    { kind: "window", x: 0.03, y: 0.06, width: 0.11, height: 0.08 },
  ]),
};

const CITY: WorldTheme = {
  id: "city",
  name: "City",
  description: "A district: labs, a data centre, and a communications hub.",
  spaceLabel: "city district",
  stations: stationsFrom("city", {
    arrival: "City gate",
    "work-a": "Research lab",
    "work-b": "Data centre",
    "work-c": "Workshop",
    exchange: "Comms hub",
    waiting: "Transit stop",
    done: "Archive tower",
    attention: "Signal tower",
  }),
  decor: decor("city", [
    atStation("work-a", "block", { height: 0.035 }),
    atStation("work-b", "rack", { height: 0.035 }),
    atStation("work-c", "block", { height: 0.035 }),
    atStation("exchange", "panel", { width: 0.16 }),
    atStation("arrival", "panel", { width: 0.14, height: 0.025 }),
    { kind: "tower", x: 0.2, y: 0.03, width: 0.055, height: 0.12 },
    { kind: "tower", x: 0.28, y: 0.05, width: 0.045, height: 0.1, ambient: true },
    { kind: "tower", x: 0.79, y: 0.03, width: 0.06, height: 0.14, ambient: true },
    { kind: "window", x: 0.03, y: 0.06, width: 0.1, height: 0.08 },
  ]),
};

const COMMAND_CENTER: WorldTheme = {
  id: "command-center",
  name: "Command center",
  description: "Terminals and dashboards around a central orchestration board.",
  spaceLabel: "command center",
  stations: stationsFrom("command-center", {
    arrival: "Standby",
    "work-a": "Terminal A",
    "work-b": "Terminal B",
    "work-c": "Analysis bay",
    exchange: "Relay",
    waiting: "Holding",
    done: "Log",
    attention: "Alert board",
  }),
  decor: decor("command-center", [
    atStation("work-a", "bench"),
    atStation("work-b", "bench"),
    atStation("work-c", "bench"),
    atStation("exchange", "screen", { width: 0.16, height: 0.035, ambient: true }),
    atStation("arrival", "panel", { width: 0.14, height: 0.025 }),
    { kind: "screen", x: 0.36, y: 0.03, width: 0.18, height: 0.05, ambient: true },
    { kind: "rack", x: 0.76, y: 0.04, width: 0.18, height: 0.06 },
    { kind: "rack", x: 0.76, y: 0.92, width: 0.18, height: 0.05 },
    { kind: "screen", x: 0.03, y: 0.07, width: 0.1, height: 0.06, ambient: true },
  ]),
};

const STUDIO: WorldTheme = {
  id: "studio",
  name: "Studio",
  description: "Writing desks, an editing station, and a wall to pin work on.",
  spaceLabel: "studio",
  stations: stationsFrom("studio", {
    arrival: "Foyer",
    "work-a": "Writing desk",
    "work-b": "Editing station",
    "work-c": "Design wall",
    exchange: "Review table",
    waiting: "Green room",
    done: "Gallery",
    attention: "Notes board",
  }),
  decor: decor("studio", [
    atStation("work-a", "bench"),
    atStation("work-b", "bench"),
    atStation("work-c", "panel", { height: 0.04 }),
    atStation("exchange", "block", { width: 0.16 }),
    atStation("arrival", "panel", { width: 0.14, height: 0.025 }),
    { kind: "window", x: 0.74, y: 0.04, width: 0.2, height: 0.075 },
    { kind: "screen", x: 0.29, y: 0.06, width: 0.09, height: 0.05, ambient: true },
    { kind: "plant", x: 0.7, y: 0.86, width: 0.03, height: 0.08 },
    { kind: "window", x: 0.03, y: 0.06, width: 0.1, height: 0.08 },
  ]),
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
