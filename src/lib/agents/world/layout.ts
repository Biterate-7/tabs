import {
  CHARACTER_HEIGHT_UNITS,
  CHARACTER_WIDTH_UNITS,
  STAGE_HEIGHT,
  STAGE_WIDTH,
} from "./projection";
import { stationsInZone } from "./themes";
import type { WorldDensity } from "./settings";
import type { WorldStation, WorldTheme, WorldZoneKind } from "./types";

/**
 * Where everybody stands.
 *
 * A layout engine rather than a physics simulation, and the difference is the
 * whole design. Characters are not bodies that repel each other; they are
 * assigned **numbered slots at named stations**, and a slot is a fixed offset
 * from its station. Two characters cannot be handed the same slot, so two
 * characters cannot overlap — the guarantee is arithmetic rather than
 * emergent, which means it holds at one agent and at fifty without tuning a
 * force constant.
 *
 * Three properties this is built to have, each of which rules something out:
 *
 *   - **Deterministic.** Position is a pure function of (theme, zone,
 *     preference, ordering key). The same set of runs lays out identically on
 *     every poll, every rerender and every reload. Nothing is random, so
 *     nothing drifts.
 *   - **Append-only within a station.** Characters fill a station in
 *     `createdAt` order, so a newly discovered run takes the next free slot
 *     instead of sorting into the middle and pushing its neighbours along.
 *     This is the same rule `spatial/placement.ts` follows, for the same
 *     reason: a layout that rearranges itself on a poll is unreadable.
 *   - **Bounded.** A zone that runs out of stations spills into extra slots
 *     at its last station rather than growing the world, and a scene past the
 *     density cap reports the remainder as a count. Nothing is ever silently
 *     dropped.
 *
 * ## Which space this works in, and why it changed
 *
 * Phase 18 laid out in the same flat space it drew in, so there was only one.
 * The isometric world has two — the floor a room is authored on, and the
 * screen it is drawn to — and slots belong firmly to the second.
 *
 * The reason is that a slot exists to stop two *drawings* touching, and the
 * projection does not preserve distance: a step along the floor's x axis
 * covers half the screen width of the same step taken diagonally. Slot
 * offsets expressed on the floor would therefore guarantee separation in a
 * space nobody looks at, and two figures a comfortable distance apart on the
 * floor would be drawn on top of each other. So a station arrives already
 * projected (see `WorldStation`), and everything below is in normalised
 * stage coordinates, where a unit is a unit whichever way you move.
 */

/** Someone who needs placing. The engine needs nothing else about them. */
export type LayoutSubject = {
  id: string;
  zone: WorldZoneKind;
  /**
   * The ordering key within a zone. Always an immutable creation time.
   *
   * Using `updatedAt` here would be the classic mistake: every poll that
   * touched a run would move it to the end of its zone, and the world would
   * shuffle continuously while nothing meaningful changed.
   */
  createdAt: number;
  /**
   * A station this subject would rather stand at.
   *
   * How a run doing research ends up in the Research Lab. It is a preference
   * and not an instruction: a station that is full, or that belongs to
   * another zone, is ignored and the subject falls back to the zone's
   * ordinary fill order. That fallback is what keeps the craft derivation
   * (craft.ts) from being load-bearing — at worst a figure stands on the
   * general floor, which is where every figure stood before this existed.
   */
  preferredStationId?: string;
};

export type LayoutPlacement = {
  id: string;
  stationId: string;
  stationLabel: string;
  zone: WorldZoneKind;
  slot: number;
  /** Normalised stage coordinates: 0..1 across and down the drawn stage. */
  x: number;
  y: number;
};

export type LayoutResult = {
  placements: LayoutPlacement[];
  /** Subjects the density cap left out. A number, never a silent omission. */
  hiddenCount: number;
  /** Stations with at least one occupant, so the renderer labels only what is in use. */
  occupiedStationIds: string[];
};

export type LayoutInput = {
  theme: WorldTheme;
  subjects: readonly LayoutSubject[];
  density: WorldDensity;
};

/**
 * How many characters a scene draws before it starts counting instead.
 *
 * Tied to density because density is the control that says how much detail
 * the user wants: a minimal world is one someone glances at, and forty
 * figures is not a glance. `detailed` is set well above the twenty the brief
 * asks about, so the cap is a deliberate choice about legibility rather than
 * a limit anyone runs into by accident.
 */
const MAX_CHARACTERS: Record<WorldDensity, number> = {
  minimal: 12,
  balanced: 28,
  detailed: 48,
};

/**
 * How much of the stage one character takes up.
 *
 * Derived from the projection's own figure size rather than guessed, so the
 * number the layout reserves and the number the renderer draws cannot drift:
 * `characterPixelSize` in components/agents/agent-world.tsx scales the same
 * constant by the same stage.
 *
 * Exported because the layout tests assert *separation*, not mere
 * distinctness. Two placements a thousandth apart are technically different
 * points and visually one figure; only a test that knows the footprint can
 * tell those apart.
 */
export const CHARACTER_FOOTPRINT = {
  width: CHARACTER_WIDTH_UNITS / STAGE_WIDTH,
  height: CHARACTER_HEIGHT_UNITS / STAGE_HEIGHT,
} as const;

/**
 * Slots per row at a station, and the spacing between them.
 *
 * Both exceed the footprint they have to clear, and the row spacing exceeds
 * it in the axis that matters: a figure's body rises a full character height
 * from its own anchor, so rows closer together than that would stack heads
 * onto shoulders.
 */
const SLOTS_PER_ROW = 3;
/*
  38, not 34.

  A figure is 25 units wide, so the old 34 left 9 units between neighbours
  — enough to keep two drawings apart, but only just enough to click
  between them. Measured in a real browser with `elementFromPoint`, the
  three figures in the middle of a full station had 30px of exclusive
  pointer area against the 26.7px (20pt) floor in `accessibility.md`;
  38 takes that to 33px. The composition is unchanged at this distance —
  still a group standing at a desk, not a spaced-out row.

  38 is also the ceiling. At 40 the station spans start intersecting and
  themes.test.ts fails, which is the world telling the truth about how
  much room it has.
*/
const SLOT_DX = 38 / STAGE_WIDTH;
/*
  32, and it cannot go up.

  Row spacing has no headroom at all: at 34 — a mere two units more than
  a figure's own height — themes.test.ts already reports fixtures standing
  in front of somebody's head, which is the one invariant the DOM-over-SVG
  world cannot break (see the note in agent-world.tsx). Vertical crowding
  between rows is therefore a fixed property of this world, and the roster
  beneath the stage is the full-size way to reach a figure that a taller
  neighbour is standing in front of.
*/
const SLOT_DY = 32 / STAGE_HEIGHT;

/** Keeps every character clear of the stage edge, whatever a theme's coordinates say. */
export const EDGE_MARGIN = 0.02;

/**
 * The lowest `y` a character's anchor may take.
 *
 * A placement coordinate is the figure's **feet**: the renderer draws it with
 * `translate(-50%, -100%)`, so the body rises from the anchor. An anchor
 * closer to the top than one character height therefore hangs the figure's
 * head off the stage. The margin makes the requirement explicit rather than
 * leaving it to whoever picks a theme's coordinates, and the station labels
 * are drawn in the space it reserves.
 */
export const TOP_MARGIN = CHARACTER_FOOTPRINT.height + EDGE_MARGIN;

function clampX(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1 - EDGE_MARGIN, Math.max(EDGE_MARGIN, value));
}

function clampY(value: number): number {
  if (!Number.isFinite(value)) return 0.5;
  return Math.min(1 - EDGE_MARGIN, Math.max(TOP_MARGIN, value));
}

/**
 * The offset of one slot from its station.
 *
 * A centred row that wraps. Row 0 sits on the station's own line and later
 * rows stack below it, which reads as a group gathered at a desk rather than
 * as a queue — and, in isometric, as a group standing in front of it, because
 * further down the stage is nearer the camera.
 */
export function slotOffset(slot: number): { dx: number; dy: number } {
  const column = slot % SLOTS_PER_ROW;
  const row = Math.floor(slot / SLOTS_PER_ROW);
  return {
    dx: (column - (SLOTS_PER_ROW - 1) / 2) * SLOT_DX,
    dy: row * SLOT_DY,
  };
}

/**
 * The rectangle a full station's occupants occupy, in normalised stage
 * coordinates.
 *
 * Asymmetric on purpose, and that asymmetry is the whole reason this returns
 * a box rather than a radius. Slots spread sideways symmetrically, but rows
 * grow *downward* from the station's line while each figure's body rises
 * *upward* from its own anchor. A single "half-height" cannot express both.
 *
 * The theme tests intersect these boxes, so changing the slot spacing above
 * re-checks every theme's geometry instead of silently invalidating it.
 */
export function clusterSpan(station: { x: number; y: number; capacity: number }): {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
} {
  const columns = Math.min(Math.max(station.capacity, 1), SLOTS_PER_ROW);
  const rows = Math.ceil(Math.max(station.capacity, 1) / SLOTS_PER_ROW);
  const halfWidth = ((columns - 1) * SLOT_DX) / 2 + CHARACTER_FOOTPRINT.width / 2;

  return {
    minX: station.x - halfWidth,
    maxX: station.x + halfWidth,
    minY: station.y - CHARACTER_FOOTPRINT.height,
    maxY: station.y + (rows - 1) * SLOT_DY,
  };
}

/** Whether two station clusters would draw over one another. */
export function clustersOverlap(
  a: { x: number; y: number; capacity: number },
  b: { x: number; y: number; capacity: number }
): boolean {
  const spanA = clusterSpan(a);
  const spanB = clusterSpan(b);
  return (
    spanA.minX < spanB.maxX &&
    spanB.minX < spanA.maxX &&
    spanA.minY < spanB.maxY &&
    spanB.minY < spanA.maxY
  );
}

/**
 * Oldest first, with id breaking ties.
 *
 * The tiebreak keeps the order total: two runs created in the same
 * millisecond still order deterministically rather than depending on whatever
 * order the domain arrays happened to hold them in.
 */
function byCreation(a: LayoutSubject, b: LayoutSubject): number {
  return a.createdAt - b.createdAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

export function layoutWorld(input: LayoutInput): LayoutResult {
  const { theme, subjects, density } = input;

  const limit = MAX_CHARACTERS[density];

  // Ordered once, globally, before anything is grouped. This is what makes
  // the density cap keep the *oldest* characters rather than an arbitrary
  // slice of whichever zone happened to be iterated first — a scene that
  // dropped whoever it felt like would flicker as states changed.
  const ordered = [...subjects].sort(byCreation);
  const admitted = ordered.slice(0, limit);
  const hiddenCount = ordered.length - admitted.length;

  // Slot counters, one per station, filled in the admitted order.
  const usedSlots = new Map<string, number>();
  const placements: LayoutPlacement[] = [];

  function take(station: WorldStation, subject: LayoutSubject): LayoutPlacement {
    const slot = usedSlots.get(station.id) ?? 0;
    usedSlots.set(station.id, slot + 1);
    const { dx, dy } = slotOffset(slot);

    return {
      id: subject.id,
      stationId: station.id,
      stationLabel: station.label,
      zone: station.zone,
      slot,
      x: clampX(station.x + dx),
      y: clampY(station.y + dy),
    };
  }

  // Everyone fills their own zone's stations, in the theme's declared order,
  // up to each station's capacity.
  const byZone = new Map<WorldZoneKind, LayoutSubject[]>();
  for (const subject of admitted) {
    const bucket = byZone.get(subject.zone);
    if (bucket) bucket.push(subject);
    else byZone.set(subject.zone, [subject]);
  }

  for (const [zone, occupants] of byZone) {
    const stations = stationsInZone(theme, zone);

    // A theme missing a zone is a bug the theme tests catch, but a world that
    // threw here would take down a panel over a missing label. Falling back to
    // the first station keeps everyone on stage and visibly in the wrong
    // place, which is a far easier problem to notice and fix.
    const usable = stations.length > 0 ? stations : theme.stations.slice(0, 1);
    if (usable.length === 0) continue;

    const byId = new Map(usable.map((station) => [station.id, station]));

    let index = 0;
    for (const subject of occupants) {
      // A preference is honoured only while its station has room. The
      // fallback is not an error path: a Research Lab with six agents in it
      // is full, and a seventh researcher standing on the general floor is a
      // better picture than a seventh researcher standing inside the sixth.
      const preferred = subject.preferredStationId
        ? byId.get(subject.preferredStationId)
        : undefined;

      if (preferred && (usedSlots.get(preferred.id) ?? 0) < preferred.capacity) {
        placements.push(take(preferred, subject));
        continue;
      }

      // Advance past any station already at capacity — including capacity
      // taken by a preference, which is why this re-reads the counter rather
      // than tracking its own position.
      while (
        index < usable.length - 1 &&
        (usedSlots.get(usable[index].id) ?? 0) >= usable[index].capacity
      ) {
        index += 1;
      }

      // The last station of a zone absorbs the overflow rather than the zone
      // spilling into a neighbouring one. Extra slots stack downward, so a
      // crowded zone gets visibly crowded — which is the truth — instead of
      // leaking figures into a part of the world that means something else.
      placements.push(take(usable[index], subject));
    }
  }

  const occupiedStationIds = [...usedSlots.entries()]
    .filter(([, count]) => count > 0)
    .map(([stationId]) => stationId);

  return { placements, hiddenCount, occupiedStationIds };
}

/**
 * How long a character takes to walk somewhere.
 *
 * Returns 0 when motion is off, and that is the one layout decision CSS could
 * not have made on its own: with no transition the character is simply *at*
 * its new station on the next render, which is what someone who asked for no
 * movement should get. A transition of zero duration would be the same thing,
 * but going through this function keeps the reason written down.
 */
export function travelDurationMs(policy: "none" | "subtle" | "full"): number {
  if (policy === "none") return 0;
  return policy === "subtle" ? 420 : 900;
}
