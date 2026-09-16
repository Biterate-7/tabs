import { describe, expect, it } from "vitest";
import { AGENT_VISUAL_STATES } from "@/lib/agents/visual/types";
import { EDGE_MARGIN, TOP_MARGIN, clusterSpan, clustersOverlap } from "./layout";
import {
  DEFAULT_WORLD_THEME_ID,
  WORLD_THEMES,
  getWorldTheme,
  missingZones,
  stationsInZone,
} from "./themes";
import { STABLE_ZONE_FOR_STATE, WORLD_THEME_IDS, ZONE_FOR_STATE } from "./types";

describe("the shipped themes", () => {
  it("ships one theme per declared id, and no more", () => {
    expect(WORLD_THEMES.map((theme) => theme.id).sort()).toEqual([...WORLD_THEME_IDS].sort());
  });

  it("gives every theme a name, a description and a space label", () => {
    for (const theme of WORLD_THEMES) {
      expect(theme.name.length).toBeGreaterThan(0);
      expect(theme.description.length).toBeGreaterThan(0);
      // Used as the stage's accessible name — a theme without one would leave
      // the world announced as an unlabelled group.
      expect(theme.spaceLabel.length).toBeGreaterThan(0);
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

  it("keeps every station and decor id unique within a theme", () => {
    for (const theme of WORLD_THEMES) {
      const stationIds = theme.stations.map((station) => station.id);
      expect(new Set(stationIds).size).toBe(stationIds.length);

      const decorIds = theme.decor.map((item) => item.id);
      expect(new Set(decorIds).size).toBe(decorIds.length);
    }
  });

  it("keeps every station inside the stage", () => {
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations) {
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
      expect(workCapacity).toBeGreaterThanOrEqual(12);
    }
  });

  it("keeps stations far enough apart that their occupants cannot meet", () => {
    // Two full stations are a cluster of figures each. Distinct coordinates
    // are not enough — the clusters have to clear one another, or a busy
    // theme draws one crowd on top of another. Derived from the layout's own
    // slot spacing, so changing that re-checks every theme rather than
    // silently invalidating this.
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
    // an overlap. The top margin is the strict one: a placement coordinate is
    // the figure's feet, so a cluster reaches a whole character height above
    // the line its station sits on.
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

  it("puts each workstation's furniture at the station it belongs to", () => {
    // Scenery drifting away from the grid is how a world ends up with figures
    // standing beside desks instead of at them — which is what the first pass
    // looked like.
    for (const theme of WORLD_THEMES) {
      for (const station of theme.stations.filter((entry) => entry.zone === "work")) {
        const nearby = theme.decor.some(
          (item) =>
            Math.abs(item.x + item.width / 2 - station.x) < 0.02 &&
            item.y > station.y &&
            item.y - station.y < 0.08
        );
        expect({ theme: theme.id, station: station.id, furnished: nearby }).toEqual({
          theme: theme.id,
          station: station.id,
          furnished: true,
        });
      }
    }
  });

  it("keeps ambient scenery to a minority of the decor", () => {
    // §25: the world may feel alive, but the active agent must dominate. The
    // renderer caps the amplitude; this caps the count.
    for (const theme of WORLD_THEMES) {
      const ambient = theme.decor.filter((item) => item.ambient).length;
      expect(ambient * 2).toBeLessThanOrEqual(theme.decor.length);
    }
  });

  it("reads all four environments as variations on one arrangement", () => {
    // Someone who has learnt to read one theme should not have to re-learn
    // where to look in another: arrival left, work centre, done right.
    for (const theme of WORLD_THEMES) {
      const arrival = stationsInZone(theme, "arrival")[0];
      const done = stationsInZone(theme, "done")[0];
      expect(arrival.x).toBeLessThan(0.3);
      expect(done.x).toBeGreaterThan(0.7);
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
