import { describe, expect, it } from "vitest";
import { CHARACTER_FOOTPRINT, layoutWorld, slotOffset, travelDurationMs } from "./layout";
import { WORLD_THEMES, getWorldTheme, zoneCapacity } from "./themes";
import type { LayoutPlacement, LayoutSubject } from "./layout";
import type { WorldZoneKind } from "./types";

const THEME = getWorldTheme("office");
const T0 = 1_700_000_000_000;

function subjects(count: number, zone: WorldZoneKind = "work", offset = 0): LayoutSubject[] {
  return Array.from({ length: count }, (_, index) => ({
    id: `run:${offset + index}`,
    zone,
    createdAt: T0 + (offset + index) * 1000,
  }));
}

function place(count: number, zone: WorldZoneKind = "work", density: "minimal" | "balanced" | "detailed" = "balanced") {
  return layoutWorld({ theme: THEME, subjects: subjects(count, zone), density });
}

describe("placing agents", () => {
  it("places nobody, and reports nothing hidden, for an empty world", () => {
    const result = layoutWorld({ theme: THEME, subjects: [], density: "balanced" });
    expect(result).toEqual({ placements: [], hiddenCount: 0, occupiedStationIds: [] });
  });

  it("places one agent at the first station of its zone", () => {
    const result = place(1);
    expect(result.placements).toHaveLength(1);
    expect(result.placements[0].zone).toBe("work");
    expect(result.placements[0].slot).toBe(0);
  });

  it("gives everybody a position inside the stage", () => {
    for (const count of [1, 5, 10, 20, 28]) {
      for (const placement of place(count).placements) {
        expect(placement.x).toBeGreaterThanOrEqual(0.05);
        expect(placement.x).toBeLessThanOrEqual(0.95);
        expect(placement.y).toBeGreaterThanOrEqual(0.05);
        expect(placement.y).toBeLessThanOrEqual(0.95);
      }
    }
  });
});

/**
 * Whether two placements are far enough apart to read as two figures.
 *
 * Distinctness is not the property that matters: two points a thousandth
 * apart are different coordinates and one drawing. The check is against the
 * character's own footprint, so it fails when figures would visually merge
 * even though the maths said they were elsewhere.
 */
function separated(a: LayoutPlacement, b: LayoutPlacement): boolean {
  return (
    Math.abs(a.x - b.x) >= CHARACTER_FOOTPRINT.width ||
    Math.abs(a.y - b.y) >= CHARACTER_FOOTPRINT.height
  );
}

function firstCollision(placements: readonly LayoutPlacement[]): string | null {
  for (let i = 0; i < placements.length; i += 1) {
    for (let j = i + 1; j < placements.length; j += 1) {
      if (!separated(placements[i], placements[j])) {
        return `${placements[i].id}/${placements[j].id}`;
      }
    }
  }
  return null;
}

describe("never overlapping", () => {
  // The guarantee that makes this a layout engine rather than a physics
  // simulation: two characters cannot be handed the same slot, so two
  // characters cannot occupy the same point. It has to hold at every size.
  it.each([1, 2, 5, 10, 20, 28])("keeps %i agents apart", (count) => {
    const { placements } = place(count);
    const points = placements.map((placement) => `${placement.x.toFixed(4)},${placement.y.toFixed(4)}`);
    expect(new Set(points).size).toBe(points.length);
  });

  it.each([1, 2, 5, 10, 18])("draws %i agents in one zone without them merging", (count) => {
    // Up to the zone's declared capacity, figures are guaranteed not just
    // distinct but visibly separate. Beyond it a zone is deliberately allowed
    // to look crowded — see the overflow note in layout.ts — and the density
    // cap is what bounds that.
    expect(firstCollision(place(count).placements)).toBeNull();
  });

  it("draws a full house across every zone without anyone merging", () => {
    const full: LayoutSubject[] = [
      ...subjects(18, "work", 0),
      ...subjects(3, "waiting", 100),
      ...subjects(6, "done", 200),
      ...subjects(6, "attention", 300),
      ...subjects(4, "arrival", 400),
      ...subjects(3, "exchange", 500),
    ];

    const { placements } = layoutWorld({ theme: THEME, subjects: full, density: "detailed" });
    expect(placements).toHaveLength(full.length);
    expect(firstCollision(placements)).toBeNull();
  });

  it("draws a full house in every theme without anyone merging", () => {
    for (const theme of WORLD_THEMES) {
      const { placements } = layoutWorld({
        theme,
        subjects: subjects(zoneCapacity(theme, "work")),
        density: "detailed",
      });
      expect({ theme: theme.id, collision: firstCollision(placements) }).toEqual({
        theme: theme.id,
        collision: null,
      });
    }
  });

  it("keeps agents apart across every zone at once", () => {
    const mixed: LayoutSubject[] = [
      ...subjects(6, "work", 0),
      ...subjects(4, "waiting", 100),
      ...subjects(5, "done", 200),
      ...subjects(3, "attention", 300),
      ...subjects(4, "arrival", 400),
      ...subjects(2, "exchange", 500),
    ];

    const { placements } = layoutWorld({ theme: THEME, subjects: mixed, density: "detailed" });
    const points = placements.map((placement) => `${placement.x.toFixed(4)},${placement.y.toFixed(4)}`);
    expect(new Set(points).size).toBe(points.length);
    expect(placements).toHaveLength(mixed.length);
  });

  it("keeps agents apart in every theme", () => {
    for (const theme of WORLD_THEMES) {
      const { placements } = layoutWorld({ theme, subjects: subjects(20), density: "detailed" });
      const points = placements.map((p) => `${p.x.toFixed(4)},${p.y.toFixed(4)}`);
      expect({ theme: theme.id, unique: new Set(points).size }).toEqual({
        theme: theme.id,
        unique: points.length,
      });
    }
  });

  it("gives distinct slots distinct offsets", () => {
    const offsets = Array.from({ length: 12 }, (_, slot) => {
      const { dx, dy } = slotOffset(slot);
      return `${dx.toFixed(4)},${dy.toFixed(4)}`;
    });
    expect(new Set(offsets).size).toBe(offsets.length);
  });
});

describe("holding still", () => {
  it("is a pure function of its input", () => {
    const input = { theme: THEME, subjects: subjects(9), density: "balanced" as const };
    expect(layoutWorld(input).placements).toEqual(layoutWorld(input).placements);
  });

  it("does not move anybody when a newcomer arrives", () => {
    // The append-only property. A poll that discovers a run must not shuffle
    // the room, which is the one thing a polling UI must never do.
    const before = place(6);
    const after = place(7);

    const byId = new Map(after.placements.map((placement) => [placement.id, placement]));
    for (const placement of before.placements) {
      const moved = byId.get(placement.id);
      expect(moved).toBeDefined();
      expect({ id: placement.id, x: moved!.x, y: moved!.y }).toEqual({
        id: placement.id,
        x: placement.x,
        y: placement.y,
      });
    }
  });

  it("orders by creation, not by id", () => {
    // Ordering by id would reorder the whole column whenever a freshly minted
    // uuid happened to sort early.
    const reversed: LayoutSubject[] = [
      { id: "zzz", zone: "work", createdAt: T0 },
      { id: "aaa", zone: "work", createdAt: T0 + 1000 },
    ];
    const { placements } = layoutWorld({ theme: THEME, subjects: reversed, density: "balanced" });
    expect(placements.find((p) => p.id === "zzz")!.slot).toBe(0);
    expect(placements.find((p) => p.id === "aaa")!.slot).toBe(1);
  });

  it("breaks a creation-time tie deterministically", () => {
    const tied: LayoutSubject[] = [
      { id: "b", zone: "work", createdAt: T0 },
      { id: "a", zone: "work", createdAt: T0 },
    ];
    const first = layoutWorld({ theme: THEME, subjects: tied, density: "balanced" });
    const second = layoutWorld({ theme: THEME, subjects: [...tied].reverse(), density: "balanced" });
    expect(first.placements).toEqual(second.placements);
  });
});

describe("filling a zone", () => {
  it("moves to the next station once one is at capacity", () => {
    const workStations = THEME.stations.filter((station) => station.zone === "work");
    const first = workStations[0];

    const { placements } = place(first.capacity + 1);
    const used = new Set(placements.map((placement) => placement.stationId));
    expect(used.size).toBeGreaterThan(1);
  });

  it("absorbs the overflow at the zone's last station rather than leaking into another", () => {
    // A crowded zone gets visibly crowded — which is the truth — instead of
    // spilling figures into a part of the world that means something else.
    const workStations = THEME.stations.filter((station) => station.zone === "work");
    const total = workStations.reduce((sum, station) => sum + station.capacity, 0);

    const { placements } = layoutWorld({
      theme: THEME,
      subjects: subjects(total + 3),
      density: "detailed",
    });

    for (const placement of placements) expect(placement.zone).toBe("work");
  });
});

describe("the density cap", () => {
  it("draws fewer at minimal than at detailed", () => {
    expect(place(40, "work", "minimal").placements.length).toBeLessThan(
      place(40, "work", "detailed").placements.length
    );
  });

  it("counts whoever it left out rather than dropping them silently", () => {
    const result = place(40, "work", "minimal");
    expect(result.hiddenCount).toBe(40 - result.placements.length);
    expect(result.hiddenCount).toBeGreaterThan(0);
  });

  it("keeps the oldest rather than an arbitrary slice", () => {
    // A scene that dropped whoever it felt like would flicker as states
    // changed and the iteration order shifted.
    const result = place(40, "work", "minimal");
    const kept = result.placements.map((placement) => placement.id);
    expect(kept).toContain("run:0");
    expect(kept).not.toContain("run:39");
  });

  it("keeps twenty agents visible at the default density", () => {
    const result = place(20);
    expect(result.placements).toHaveLength(20);
    expect(result.hiddenCount).toBe(0);
  });
});

describe("reporting occupied stations", () => {
  it("lists only stations that actually hold somebody", () => {
    const result = place(2);
    expect(result.occupiedStationIds).toHaveLength(1);
    for (const stationId of result.occupiedStationIds) {
      expect(result.placements.some((placement) => placement.stationId === stationId)).toBe(true);
    }
  });
});

describe("how long a walk takes", () => {
  it("is instant when motion is off", () => {
    // The one layout decision CSS could not have made: with no transition the
    // character is simply *at* its new station, which is what someone who
    // asked for no movement should get.
    expect(travelDurationMs("none")).toBe(0);
  });

  it("is quicker at subtle than at full", () => {
    expect(travelDurationMs("subtle")).toBeLessThan(travelDurationMs("full"));
  });
});

describe("performance with many agents", () => {
  it("lays out fifty agents in well under a frame", () => {
    // The world is rebuilt on every poll. If laying it out cost a frame, the
    // graph canvas beside it would stutter every time an agent moved.
    const many = subjects(50);
    const started = performance.now();
    for (let i = 0; i < 20; i += 1) {
      layoutWorld({ theme: THEME, subjects: many, density: "detailed" });
    }
    const perLayout = (performance.now() - started) / 20;
    expect(perLayout).toBeLessThan(16);
  });
});
