import { describe, expect, it } from "vitest";
import { AGENT_VISUAL_STATES } from "@/lib/agents/visual/types";
import {
  FIXTURE_TIER,
  occludesStation,
  roomContains,
  roomsOverlap,
} from "./architecture";
import { WORLD_CRAFTS } from "./craft";
import { EDGE_MARGIN, TOP_MARGIN, clusterSpan, clustersOverlap } from "./layout";
import { STAGE_HEIGHT, STAGE_WIDTH, isOnFloor } from "./projection";
import {
  DEFAULT_WORLD_THEME_ID,
  WORLD_THEMES,
  getWorldTheme,
  missingZones,
  roomForStation,
  stationKeyForCraft,
  stationsInZone,
} from "./themes";
import { STABLE_ZONE_FOR_STATE, WORLD_THEME_IDS, ZONE_FOR_STATE } from "./types";
import type { WorldFixture, WorldFixtureKind } from "./architecture";
import type { WorldStation, WorldTheme } from "./types";

/** Every fixture a theme places, wherever it placed it. */
function allFixturesOf(theme: WorldTheme): WorldFixture[] {
  return [...theme.backdrop, ...theme.rooms.flatMap((room) => room.fixtures)];
}

/** A station's cluster, in the SVG's own user space. */
function clusterInStageUnits(station: WorldStation) {
  const span = clusterSpan(station);
  return {
    minX: span.minX * STAGE_WIDTH,
    maxX: span.maxX * STAGE_WIDTH,
    minY: span.minY * STAGE_HEIGHT,
    maxY: span.maxY * STAGE_HEIGHT,
  };
}

/** What counts as something you can work at. */
const WORK_SURFACES: readonly WorldFixtureKind[] = [
  "desk",
  "workstation",
  "table",
  "counter",
  "platform",
];

describe("the shipped themes", () => {
  it("ships one theme per declared id, and no more", () => {
    expect(WORLD_THEMES.map((theme) => theme.id).sort()).toEqual([...WORLD_THEME_IDS].sort());
  });

  it("gives every theme a name, a description, a setting and a space label", () => {
    for (const theme of WORLD_THEMES) {
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.description.length).toBeGreaterThan(0);
      // Used as the stage's accessible name — a theme without one would leave
      // the world announced as an unlabelled group.
      expect(theme.spaceLabel.length).toBeGreaterThan(0);
      expect(["interior", "exterior"]).toContain(theme.setting);
    }
  });

  it("can place every zone, in every theme", () => {
    // A theme missing a zone would silently drop every character in that
    // state — the kind of bug that only shows up when an agent finally fails.
    for (const theme of WORLD_THEMES) {
      expect({ theme: theme.id, missing: missingZones(theme) }).toEqual({
        theme: theme.id,
        missing: [],
      });
    }
  });

  it("can place every visual state, under either zone mapping", () => {
    for (const theme of WORLD_THEMES) {
      for (const state of AGENT_VISUAL_STATES) {
        expect(stationsInZone(theme, ZONE_FOR_STATE[state]).length).toBeGreaterThan(0);
        expect(stationsInZone(theme, STABLE_ZONE_FOR_STATE[state]).length).toBeGreaterThan(0);
      }
    }
  });

  it("gives every craft a room to work in", () => {
    // The whole point of the redesign's work zone. A craft with no station
    // would derive correctly and then place its runs on the general floor
    // forever, which is a silent failure rather than a visible one.
    for (const craft of WORLD_CRAFTS) {
      const key = stationKeyForCraft(craft);
      expect({ craft, key: key !== null }).toEqual({ craft, key: true });

      for (const theme of WORLD_THEMES) {
        const station = theme.stations.find((entry) => entry.craft === craft);
        expect({ theme: theme.id, craft, found: Boolean(station) }).toEqual({
          theme: theme.id,
          craft,
          found: true,
        });
        expect(station!.zone).toBe("work");
      }
    }
  });

  it("keeps every station, room and fixture id unique within a theme", () => {
    for (const theme of WORLD_THEMES) {
      const stationIds = theme.stations.map((station) => station.id);
      expect(new Set(stationIds).size).toBe(stationIds.length);

      const roomIds = theme.rooms.map((room) => room.id);
      expect(new Set(roomIds).size).toBe(roomIds.length);

      const fixtureIds = allFixturesOf(theme).map((fixture) => fixture.id);
      expect(new Set(fixtureIds).size).toBe(fixtureIds.length);
    }
  });

  it("keeps every station on the floor and on the stage", () => {
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations) {
        // On the floor: a station outside the projected plan would put an
        // agent in mid-air beside the building.
        expect({ id: station.id, onFloor: isOnFloor(station.planX, station.planY) }).toEqual({
          id: station.id,
          onFloor: true,
        });
        expect(station.x).toBeGreaterThan(0);
        expect(station.x).toBeLessThan(1);
        expect(station.y).toBeGreaterThan(0);
        expect(station.y).toBeLessThan(1);
        expect(station.capacity).toBeGreaterThan(0);
      }
    }
  });

  it("gives every theme room for well over twenty agents at work", () => {
    // The brief asks for twenty simultaneous agents to stay usable. A theme
    // that started stacking figures at six would not be.
    for (const theme of WORLD_THEMES) {
      const workCapacity = stationsInZone(theme, "work").reduce(
        (total, station) => total + station.capacity,
        0
      );
      expect(workCapacity).toBeGreaterThanOrEqual(20);
    }
  });

  it("keeps stations far enough apart that their occupants cannot meet", () => {
    // Two full stations are a cluster of figures each. Distinct coordinates
    // are not enough — the clusters have to clear one another, or a busy
    // theme draws one crowd on top of another. Asked in *projected* space,
    // because the isometric transform does not preserve distance: two
    // stations a comfortable distance apart on the floor can be drawn on top
    // of each other, and only the screen box can tell.
    for (const theme of WORLD_THEMES) {
      for (let i = 0; i < theme.stations.length; i += 1) {
        for (let j = i + 1; j < theme.stations.length; j += 1) {
          const a = theme.stations[i];
          const b = theme.stations[j];
          expect({
            theme: theme.id,
            pair: `${a.id}/${b.id}`,
            overlaps: clustersOverlap(a, b),
          }).toEqual({ theme: theme.id, pair: `${a.id}/${b.id}`, overlaps: false });
        }
      }
    }
  });

  it("keeps every station's cluster inside the stage, clear of the edge clamp", () => {
    // Against the layout's own margins, not against 0. A cluster that ran past
    // one would be silently squashed by the clamp, which pushes two slots onto
    // the same coordinate — the one way a slot-based layout can still produce
    // an overlap.
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations) {
        const span = clusterSpan(station);
        expect({ id: station.id, inside: span.minX >= EDGE_MARGIN }).toEqual({
          id: station.id,
          inside: true,
        });
        expect({ id: station.id, inside: span.maxX <= 1 - EDGE_MARGIN }).toEqual({
          id: station.id,
          inside: true,
        });
        expect({ id: station.id, inside: span.minY >= 0 }).toEqual({
          id: station.id,
          inside: true,
        });
        expect({ id: station.id, inside: span.maxY <= 1 - EDGE_MARGIN }).toEqual({
          id: station.id,
          inside: true,
        });
      }
    }
  });

  it("never places a station above the top margin", () => {
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations) {
        expect({ id: station.id, clear: station.y >= TOP_MARGIN }).toEqual({
          id: station.id,
          clear: true,
        });
      }
    }
  });
});

describe("the architecture", () => {
  it("puts every station in exactly one room, and inside that room's walls", () => {
    // The claim the whole room model rests on. A station outside its room
    // draws a figure standing in the corridor while the card for the room it
    // supposedly belongs to counts it as present.
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations) {
        const owners = theme.rooms.filter((room) => room.stationIds.includes(station.id));
        expect({ id: station.id, owners: owners.length }).toEqual({ id: station.id, owners: 1 });

        const room = owners[0];
        expect({
          id: station.id,
          room: room.id,
          inside: roomContains(room, station.planX, station.planY),
        }).toEqual({ id: station.id, room: room.id, inside: true });
      }
    }
  });

  it("names a room for every station, through the lookup the renderer uses", () => {
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations) {
        expect(roomForStation(theme, station.id)?.stationIds).toContain(station.id);
      }
    }
  });

  it("never overlaps two rooms", () => {
    for (const theme of WORLD_THEMES) {
      for (let i = 0; i < theme.rooms.length; i += 1) {
        for (let j = i + 1; j < theme.rooms.length; j += 1) {
          const a = theme.rooms[i];
          const b = theme.rooms[j];
          expect({
            theme: theme.id,
            pair: `${a.id}/${b.id}`,
            overlaps: roomsOverlap(a, b),
          }).toEqual({ theme: theme.id, pair: `${a.id}/${b.id}`, overlaps: false });
        }
      }
    }
  });

  it("gives every room a name, a purpose and an accent", () => {
    // The purpose is what a room's card says and what its button announces.
    // A room without one is a coloured rectangle you can click.
    for (const theme of WORLD_THEMES) {
      for (const room of theme.rooms) {
        expect({ room: room.id, name: room.name.length > 0 }).toEqual({
          room: room.id,
          name: true,
        });
        expect({ room: room.id, purpose: room.purpose.length > 0 }).toEqual({
          room: room.id,
          purpose: true,
        });
        expect(room.accent.length).toBeGreaterThan(0);
      }
    }
  });

  it("keeps every room on the floor", () => {
    for (const theme of WORLD_THEMES) {
      for (const room of theme.rooms) {
        expect({ room: room.id, onFloor: isOnFloor(room.planX, room.planY) }).toEqual({
          room: room.id,
          onFloor: true,
        });
        expect({
          room: room.id,
          onFloor: isOnFloor(room.planX + room.width, room.planY + room.depth),
        }).toEqual({ room: room.id, onFloor: true });
      }
    }
  });

  it("puts something to work at in every work room", () => {
    // Furniture drifting away from the grid is how a world ends up with
    // figures standing beside desks instead of at them.
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations.filter((entry) => entry.zone === "work")) {
        const room = roomForStation(theme, station.id)!;
        const furnished = room.fixtures.some((fixture) => {
          if (!WORK_SURFACES.includes(fixture.kind)) return false;
          const centreX = fixture.planX + fixture.width / 2;
          const centreY = fixture.planY + fixture.depth / 2;
          return (
            Math.hypot(centreX - station.planX, centreY - station.planY) < 0.14 &&
            // Behind the station: the occupants stand in front of it rather
            // than on top of it.
            centreX + centreY <= station.planX + station.planY
          );
        });

        expect({ theme: theme.id, station: station.id, furnished }).toEqual({
          theme: theme.id,
          station: station.id,
          furnished: true,
        });
      }
    }
  });

  it("never stands anything tall in front of somebody's head", () => {
    // The isometric world's hardest geometric rule, and the reason it exists
    // is the character layer being DOM above the SVG: a figure always paints
    // over the scenery, so anything tall enough to hide it has to be *behind*
    // it, where painting over is correct. See occludesStation.
    // Collected across every theme and every station before asserting, so a
    // failure names every offender at once rather than the first one and then
    // the next one after it is moved.
    const offenders: string[] = [];

    for (const theme of WORLD_THEMES) {
      const fixtures = allFixturesOf(theme);
      for (const station of theme.stations) {
        const cluster = clusterInStageUnits(station);
        for (const fixture of fixtures) {
          if (occludesStation(fixture, station, cluster)) {
            offenders.push(`${fixture.kind} ${fixture.id} hides ${station.id}`);
          }
        }
      }
    }

    expect(offenders).toEqual([]);
  });

  it("keeps ambient scenery to a minority of the fixtures", () => {
    // The world may feel alive, and the active agent must still dominate. The
    // renderer caps the amplitude; this caps the count.
    for (const theme of WORLD_THEMES) {
      const fixtures = allFixturesOf(theme);
      const ambient = fixtures.filter((fixture) => fixture.ambient).length;
      expect({ theme: theme.id, minority: ambient * 2 <= fixtures.length }).toEqual({
        theme: theme.id,
        minority: true,
      });
    }
  });

  it("leaves a recognisable room at every level of visual detail", () => {
    // Minimal keeps tier 0 and nothing else, so a room whose entire contents
    // were seats and plants would empty out at the setting most likely to be
    // chosen on a phone.
    for (const theme of WORLD_THEMES) {
      for (const room of theme.rooms) {
        const essential = room.fixtures.filter((fixture) => FIXTURE_TIER[fixture.kind] === 0);
        expect({ theme: theme.id, room: room.id, essential: essential.length > 0 }).toEqual({
          theme: theme.id,
          room: room.id,
          essential: true,
        });
      }
    }
  });

  it("reads all four environments as one building, differently dressed", () => {
    // Someone who has learnt to read one theme should not have to re-learn
    // where to look in another. Phase 18 asserted this loosely, by checking
    // that arrival was on the left; now that stations and rooms both come
    // from a shared plan it can be asserted exactly.
    const [first, ...rest] = WORLD_THEMES;
    const shape = (theme: WorldTheme) => ({
      stations: theme.stations.map((station) => ({
        zone: station.zone,
        craft: station.craft ?? null,
        planX: station.planX,
        planY: station.planY,
        capacity: station.capacity,
      })),
      rooms: theme.rooms.map((room) => ({
        planX: room.planX,
        planY: room.planY,
        width: room.width,
        depth: room.depth,
        stations: room.stationIds.length,
      })),
    });

    for (const theme of rest) {
      expect({ theme: theme.id, shape: shape(theme) }).toEqual({
        theme: theme.id,
        shape: shape(first),
      });
    }
  });
});

describe("looking a theme up", () => {
  it("returns the one that was asked for", () => {
    for (const theme of WORLD_THEMES) {
      expect(getWorldTheme(theme.id).id).toBe(theme.id);
    }
  });

  it("falls back to the default rather than throwing on a retired id", () => {
    // The id can arrive from settings written by a build that shipped a theme
    // this one does not. Refusing to render would be worse than rendering the
    // default.
    expect(getWorldTheme("a-theme-from-the-future").id).toBe(DEFAULT_WORLD_THEME_ID);
    expect(getWorldTheme(undefined).id).toBe(DEFAULT_WORLD_THEME_ID);
    expect(getWorldTheme(null).id).toBe(DEFAULT_WORLD_THEME_ID);
  });
});
