# Phase 18.2 — The Isometric Agent World

Phase 18 built the Agent World: figures, states, stations, handoffs, all of it
derived from observed agent work. Phase 18.1 gave it a front door. Both were
correct and the thing they produced was **flat** — a row of figures on a panel,
with eight rectangles behind them standing in for a room.

18.2 replaces the presentation and keeps everything underneath. The world is
now a place: a floor plan, drawn in isometric, with named rooms an agent is
placed into because of what its run has actually said and touched.

```
src/lib/agents/world/
├── projection.ts     plan space → stage space            ← new
├── architecture.ts   rooms, fixtures, occlusion          ← new
├── craft.ts          what kind of work a run is doing    ← new
├── themes.ts         one building, four dressings        ← rewritten
├── layout.ts         slots, now in projected space       ← reworked
└── scene.ts          craft → station → room              ← extended
```

Nothing in `visual/`, `handoffs.ts`, `roster.ts`, `persistence.ts` or the
connector layer changed. The world still cannot start, stop, drive or message
anything, and `visual/security.test.ts` still fails the build if that stops
being true.

---

## 1. Three coordinate spaces, named once

The one idea the whole phase rests on, and the reason it is a small diff
rather than a rewrite.

| space | units | what lives in it |
|---|---|---|
| **plan** | 0..1 × 0..1 | stations, rooms, fixtures — the floor, from above |
| **stage** | 0..1000 × 0..700 | the SVG's user space, after projection |
| **normalised stage** | 0..1 × 0..1 | what a `WorldCharacter` carries |

Authoring stays two-dimensional: a room is a rectangle, a desk is a smaller
one, and a theme author never sees a matrix. `projection.ts` turns that into
an isometric drawing, and the third space exists because the character layer
is **DOM, not SVG** — a figure is a `<button>` positioned in pixels, and it
has to land on the desk the SVG drew. Both layers multiply the same
normalised coordinate by the same measured size, so they cannot disagree.

### Slots moved space, and had to

Phase 18 laid out in the space it drew in, so there was only one. Two now,
and a slot belongs firmly to the screen: the projection does not preserve
distance — a step along the floor's x axis covers half the screen width of the
same step taken diagonally — so slot offsets expressed on the floor would
guarantee separation in a space nobody looks at. A station therefore arrives
already projected, and every constant in `layout.ts` is in stage units.

---

## 2. A world made of rooms

`architecture.ts` adds two types and one table:

- a **room** has a name, a purpose, an accent and a set of stations;
- a **fixture** names a `kind`, and `FIXTURE_RENDER` says which of six
  primitives draws it, how tall it stands and what it is painted in.

Six primitives — a flat polygon, an extruded box, a standing panel, a post, a
plant and a travelling box — draw twenty-two kinds of object across four
environments. Adding a coffee machine is a line in a theme.

Rooms are what make §6 derivable rather than a second table to maintain:
"what is happening in the Research Lab" is answered from the same scene the
figures come from, because the theme said which stations the room contains
and the scene says which characters are at them.

### Eleven rooms, one plan

`ROOM_PLAN` and `STATION_GRID` are shared by all four themes, exactly as the
station grid already was. A theme supplies names, purposes, accents and
furniture. That keeps the four environments readable as one building — arrival
is always the lobby, work is always in the middle, problems are always front
right — and it means the geometry is verified once. `themes.test.ts` asserts
all of it for every theme.

### The occlusion rule

The hardest geometric constraint in the phase, and it exists because the
character layer is DOM above the SVG: a figure always paints over the scenery,
whatever stands between it and the camera. Rather than move the characters
into the SVG and lose every accessibility property that made them DOM, the
themes are authored so the question never arises — **anything tall enough to
hide a figure stands behind every station cluster it overlaps on screen**,
where painting over it is correct.

`occludesStation` states it and `themes.test.ts` checks it across four themes
and ten stations at once, naming every offender. It caught fourteen the first
time it ran, which is fourteen heads that would otherwise have poked through a
wall in a screenshot somebody took later.

Room walls are 22 stage units — deliberately below the 24-unit occluder
threshold. A miniature with full-height walls is a floor plan you cannot see
into; the reference this phase works from is cut away for the same reason.

---

## 3. Which room an agent works in

The placement question Phase 18 could not ask. `craft.ts` derives a **craft** —
research, code, writing or analysis — from a run's own evidence, and the craft
picks a station inside the work zone.

| evidence | weight | why |
|---|---|---|
| a file the run touched | 3, capped at 4 per craft | a record of what happened, and it cannot change its mind |
| the run's title | 2 | stable for the run's whole life |
| a work item's title | 2 | the same |
| the activity line | 1 | the most descriptive signal and the most volatile |

Three things this is careful about:

- **It decides a desk, and nothing else.** It cannot make an agent look busy,
  cannot change its state and is never consulted for a character with no run.
  A run whose evidence says nothing gets **no craft** and stands on the
  general operations floor — a real answer, and the one every run had before
  rooms existed.
- **It cannot see a provider.** Which agent you are has nothing to do with
  what you are doing, and a world that sent one provider to the Development
  Room every time would assert a specialisation the product does not observe.
  The evidence type has no field for it.
- **It is off when the user asked for stillness.** "Rearrange automatically"
  off means a run keeps its desk for its whole working life; a craft can
  change as evidence accumulates, so honouring it would be a second reason for
  a figure to move after the user asked for none.

The caption under a figure is still the run's own activity line, and the
detail card still lists the real files and work items. The heuristic is
visible in exactly one place: which room the figure is standing in.

---

## 4. Rooms you can point at

Eleven transparent polygons over the scenery, each a `<button>` with a
complete accessible name — what the room is called, what it is for, how many
agents are in it. Selecting one opens a card listing the occupants and their
real activity lines; selecting an occupant opens that agent's own card.

The opposite half of §6 is guaranteed structurally rather than by restraint:
the interaction layer knows only about rooms, so a desk cannot become a click
target because there is nowhere to write one.

A room with no stations is not a mistake. A data centre is part of what makes
the place read as a working headquarters, and its card says plainly that no
agent works there — rather than being given a station so it looks busy.

### Tab order puts the agents first

The figures are rendered **before** the rooms in the DOM and painted above
them by z-index. Someone who opened the Agent World came for the agents, not
for eleven rooms they have to pass through to reach one.

---

## 5. The camera

`settings.camera` chooses the default framing. On top of it, dragging, the
wheel, a two-finger pinch and the arrow keys work in **every** mode, and taking
hold of the camera parks the automatic framing until Reset view hands it back.
A control called "Static" that refused to be nudged would be a preference
masquerading as a lock.

Four visible controls — zoom in, zoom out, focus the active agents, reset —
because a gesture nobody can see is not a control, and on a touch screen there
is no wheel and no arrow keys.

### Fit, and when not to

A box much wider than the world either letterboxes it or crops it, and which
is right depends entirely on how big that leaves the people in it. So the rule
is stated in those terms:

> If fitting the whole world still leaves a figure at least 22 pixels tall,
> show the whole world. If it does not, start zoomed in far enough to be
> legible and leave the rest a drag away.

That single rule is the responsive story. A laptop sees the entire
headquarters; a phone sees a quarter of it at a readable size, with the
working-now list beside it naming everyone the crop leaves out. Neither is a
special case in the renderer.

### Interiors are cropped, cities are not

The projection reserves a quarter of the stage above the floor for anything
with height. A city needs all of it — a skyline standing behind the deck is
the whole of the second reference's scale — and an office has nothing taller
than a bookshelf, so it would spend that quarter on empty air and draw the
building a third smaller than the screen could carry.

`STAGE_CONTENT_BOX` crops the *view* per setting while the coordinate system
stays one. Layout, separation, occlusion and a character's position are all
still in full-stage terms and none of them knows; the SVG's `viewBox` and the
pixel mapping consult the same value.

---

## 6. The environments

**Office headquarters** — a cut-away floor of eleven rooms around a central
lobby, each legible from its furniture alone: desks and meeting tables, a wall
of screens in the collaboration hub, shelving in the archive, a server room
nobody works in.

**Futuristic AI city** — the same floor plan as an orbital deck. Districts on
raised plinths, elevated roads with traffic on them, and a skyline that
follows the deck's **rim** rather than a line of constant depth. That
distinction is the difference between a city the deck belongs to and buildings
hanging in the sky, which is what the first attempt looked like: the deck is a
diamond on screen, so a row of towers at one depth touches it only at the back
corner and floats further and further above it towards the sides.

**Command center** and **Studio** are the same building dressed as consoles
and as benches.

### Ambient life, and its ceiling

Lit screens, beacons and small vehicles running along the city's roads. Every
one is a CSS keyframe — a vehicle's path is two custom properties handed to
one shared rule, exactly as the handoff packet's endpoints already were — so a
dozen vehicles cost a dozen composited transforms and not one JavaScript
timer. Phase 18's rule holds: the environment may look alive and the working
agent must still dominate it. The renderer caps the amplitude, the `ambient`
flag caps the count, and `themes.test.ts` asserts it stays a minority.

---

## 7. What was measured, in a real browser

Headless Chrome against `next dev`, seeded through the app's own
`localStorage` so every screenshot came through the real code path.

| check | result |
|---|---|
| eight runs across four providers, three viewports | 0 overlapping figures at 1440, 834 and 390 px |
| desktop, 1440×900 | whole world visible, camera at zoom 1, figures 29 px |
| mobile, 390×844 | zoom 2.01 by the legibility rule, figures 48 px, five of seven agents on screen and the rest named in the list |
| idle world, nothing running | eleven rooms drawn, five identities standing in the lobby, no agent in a working state |
| a room selected | highlight, card, occupants, and "No agents here right now" where that was the truth |
| `prefers-reduced-motion: reduce` | 0 of 17 animated elements moving; every state still a word and a mark |

The occlusion and separation rules are checked in tests rather than by eye,
because eyes miss the one figure in the one theme at the one density where a
shelf clips a head.

---

## 8. What did not change

The domain, the connector layer, the visual identity registry, the roster, the
handoff derivation, the settings schema and every accessibility property Phase
18 established. `WorldCharacter` gained two derived fields (`craft`, `roomId`);
`WorldTheme` traded a flat `decor` list for `rooms` and a `backdrop`. The
settings panel gained no new switch — the effect labels now read in the
brief's vocabulary, and each one still turns off something the renderer
actually consults.

The world is still a picture of observed work. A figure exists because a run
exists, it stands where it stands because of what that run has said and
touched, and the lines between figures are transfers the domain recorded.
Nothing here simulates an agent.
