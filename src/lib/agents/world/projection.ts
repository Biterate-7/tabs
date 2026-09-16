/**
 * The isometric projection, and the one place the world's geometry is defined.
 *
 * Phase 18 drew the world flat: a station's normalised coordinate *was* its
 * position on the stage, and the scenery was rectangles behind the figures.
 * That was legible and completely without depth — a room read as a diagram of
 * a room rather than as a place.
 *
 * Phase 18.2 puts a floor under it. Everything the world contains is now
 * authored in **plan space** — a unit square, read as a floor seen from
 * above, in which a room is a rectangle and a desk is a smaller one — and
 * projected into **stage space** by the transform below. Authoring stays
 * two-dimensional and obvious; the drawing gains a third axis.
 *
 * ## Three coordinate spaces, named once
 *
 * | space | units | what lives in it |
 * |---|---|---|
 * | **plan** | 0..1 x 0..1 | stations, rooms, fixtures — the floor, from above |
 * | **stage** | 0..1000 x 0..700 | the SVG's user space, after projection |
 * | **normalised stage** | 0..1 x 0..1 | what a `WorldCharacter` carries |
 *
 * The third exists because the character layer is DOM, not SVG: a figure is a
 * `<button>` positioned in pixels, and it has to land on the same spot the
 * SVG drew its desk. Normalised stage coordinates are the contract between
 * the two — the layout engine emits them, the renderer multiplies them by the
 * stage's measured size, and the SVG multiplies them by `STAGE_WIDTH` and
 * `STAGE_HEIGHT`. Both arrive at the same place because both start from here.
 *
 * ## Why 2:1, and why the floor is not the whole stage
 *
 * `HALF_WIDTH / HALF_HEIGHT` is a shade under 2, the ratio both reference
 * images use and the one that keeps a square room reading as square rather
 * than as a lozenge. The projected floor is a diamond inscribed in the stage,
 * and it deliberately does not fill it: the space above the back corner is
 * where anything with height goes, and a projection that used the whole box
 * would have nowhere to put a tower.
 */

/** The SVG user space. 10:7 — wider than tall, with headroom above the floor. */
export const STAGE_WIDTH = 1000;
export const STAGE_HEIGHT = 700;

/** Half the projected floor's width and height, in stage units. */
export const HALF_WIDTH = 450;
export const HALF_HEIGHT = 235;

/** Where plan (0, 0) — the far corner — lands. */
export const ORIGIN_X = 500;
export const ORIGIN_Y = 175;

/**
 * How tall a figure is drawn, in stage units.
 *
 * The number every separation guarantee is calibrated against. A figure is
 * drawn from the 40x48 viewBox in `agent-character.tsx`, so its width follows
 * from its height and neither is chosen independently of the other.
 */
export const CHARACTER_HEIGHT_UNITS = 30;
export const CHARACTER_WIDTH_UNITS = (CHARACTER_HEIGHT_UNITS * 40) / 48;

/**
 * How much of the stage a given kind of world actually uses.
 *
 * The projection reserves a quarter of the stage above the floor's far corner
 * for anything with height, and a city needs all of it — a skyline standing
 * behind the deck is the whole of the second reference's scale. An office
 * has nothing taller than a bookshelf and would spend that quarter on empty
 * air, which on a laptop means drawing the building a third smaller than the
 * screen could carry.
 *
 * So the stage keeps one coordinate system and the *view* of it is cropped
 * per setting. Everything upstream — layout, separation, occlusion, a
 * character's normalised position — stays in full-stage terms and none of it
 * has to know; only the SVG's `viewBox` and the pixel mapping in
 * `AgentWorld` consult this, and they consult the same value.
 */
export type StageContentBox = { y: number; height: number };

export const STAGE_CONTENT_BOX: Record<"interior" | "exterior", StageContentBox> = {
  // Down to just above the exchange room's back wall, and down to just below
  // the deck's skirt.
  interior: { y: 140, height: 545 },
  exterior: { y: 0, height: STAGE_HEIGHT },
};

export function contentBoxFor(setting: "interior" | "exterior"): StageContentBox {
  return STAGE_CONTENT_BOX[setting] ?? STAGE_CONTENT_BOX.exterior;
}

export type StagePoint = { x: number; y: number };

export type StageBounds = { minX: number; maxX: number; minY: number; maxY: number };

/**
 * Plan to stage.
 *
 * `+x` runs right-and-down the screen, `+y` runs left-and-down. Which is to
 * say the camera looks at the floor from the direction of plan (1, 1), so the
 * corner nearest the viewer is the bottom of the stage and plan (0, 0) is the
 * furthest away.
 */
export function projectPlan(planX: number, planY: number): StagePoint {
  return {
    x: ORIGIN_X + (planX - planY) * HALF_WIDTH,
    y: ORIGIN_Y + (planX + planY) * HALF_HEIGHT,
  };
}

/** Plan to stage, normalised to 0..1. What a placed character carries. */
export function projectPlanNormalized(planX: number, planY: number): StagePoint {
  const point = projectPlan(planX, planY);
  return { x: point.x / STAGE_WIDTH, y: point.y / STAGE_HEIGHT };
}

/**
 * How far from the camera a point on the floor is.
 *
 * `planX + planY`, which is exactly the projected `y` before scaling — so
 * sorting by depth and sorting by how far down the stage something is drawn
 * are the same sort. That is what makes the painter's algorithm in the
 * scenery renderer correct rather than approximately correct: a thing drawn
 * lower is nearer, and nearer things are painted last.
 */
export function planDepth(planX: number, planY: number): number {
  return planX + planY;
}

/** The four corners of a plan rectangle, projected, in draw order. */
export function projectRect(
  planX: number,
  planY: number,
  width: number,
  depth: number
): [StagePoint, StagePoint, StagePoint, StagePoint] {
  return [
    projectPlan(planX, planY),
    projectPlan(planX + width, planY),
    projectPlan(planX + width, planY + depth),
    projectPlan(planX, planY + depth),
  ];
}

/** An SVG `points` string for a projected plan rectangle, optionally raised. */
export function rectPoints(
  planX: number,
  planY: number,
  width: number,
  depth: number,
  lift = 0
): string {
  return projectRect(planX, planY, width, depth)
    .map((point) => `${round(point.x)},${round(point.y - lift)}`)
    .join(" ");
}

/**
 * The two visible side faces of a box standing on a plan rectangle.
 *
 * Only two of the four are ever drawn, and which two is a property of the
 * projection rather than of the box: the camera sits over plan (1, 1), so it
 * sees the `+x` face and the `+y` face and never the other pair. Drawing all
 * four would cost twice the nodes to paint two of them underneath.
 */
export function boxFaces(
  planX: number,
  planY: number,
  width: number,
  depth: number,
  height: number
): { top: string; right: string; left: string } {
  const [farCorner, xCorner, nearCorner, yCorner] = projectRect(planX, planY, width, depth);

  return {
    top: [farCorner, xCorner, nearCorner, yCorner]
      .map((point) => `${round(point.x)},${round(point.y - height)}`)
      .join(" "),
    // The face at x + width, seen from the right of the screen.
    right: [
      `${round(xCorner.x)},${round(xCorner.y - height)}`,
      `${round(nearCorner.x)},${round(nearCorner.y - height)}`,
      `${round(nearCorner.x)},${round(nearCorner.y)}`,
      `${round(xCorner.x)},${round(xCorner.y)}`,
    ].join(" "),
    // The face at y + depth, seen from the left of the screen.
    left: [
      `${round(yCorner.x)},${round(yCorner.y - height)}`,
      `${round(nearCorner.x)},${round(nearCorner.y - height)}`,
      `${round(nearCorner.x)},${round(nearCorner.y)}`,
      `${round(yCorner.x)},${round(yCorner.y)}`,
    ].join(" "),
  };
}

/**
 * The screen-space box a projected plan rectangle occupies.
 *
 * Used for the overlap rules the theme tests enforce. A plan rectangle
 * projects to a diamond, and its bounding box is what matters for "would
 * these two draw over each other", which is a question about pixels rather
 * than about floor plans.
 */
export function projectedBounds(
  planX: number,
  planY: number,
  width: number,
  depth: number,
  height = 0
): StageBounds {
  const corners = projectRect(planX, planY, width, depth);
  const xs = corners.map((corner) => corner.x);
  const ys = corners.map((corner) => corner.y);

  return {
    minX: Math.min(...xs),
    maxX: Math.max(...xs),
    minY: Math.min(...ys) - height,
    maxY: Math.max(...ys),
  };
}

export function boundsOverlap(a: StageBounds, b: StageBounds): boolean {
  return a.minX < b.maxX && b.minX < a.maxX && a.minY < b.maxY && b.minY < a.maxY;
}

/**
 * Whether a point in plan space is on the floor at all.
 *
 * Scenery is allowed outside it — a skyline stands behind the deck it
 * overlooks, which is to say at negative plan coordinates — but a *station*
 * outside the floor would put an agent in mid-air, and the theme tests say so.
 */
export function isOnFloor(planX: number, planY: number): boolean {
  return planX >= 0 && planX <= 1 && planY >= 0 && planY <= 1;
}

/** Two decimal places. SVG path data does not need more, and shorter strings diff better. */
function round(value: number): number {
  return Math.round(value * 100) / 100;
}
