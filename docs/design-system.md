# Hubble design system

Hubble's interface is restrained so that one thing can be luminous: the Graph.
Everything else is graphite and paper, hairlines and type.

Tokens are CSS variables. The palette half is written at runtime by
`src/lib/appearance/resolve.ts` from the active theme (43 themes exist, so
**never hard-code a hex in a component**); the fixed half lives on `:root` in
`src/app/globals.css`.

## Colour

| Role | Token / class | Notes |
| --- | --- | --- |
| Ground | `bg-background` | Hubble Dark `#0b0c0f`, Hubble Light `#f6f7f9` |
| Surface | `bg-card` / `bg-surface` | rows, cards, inline panels |
| Elevated | `bg-popover` | menus, dialogs, inspectors, palette |
| Text tiers | `text-foreground` › `text-muted-foreground` › `text-tertiary` › `text-disabled` | `text-secondary` is a *surface*, not text |
| Signal | `text-link` / `--link` | the one chromatic colour: `#8ab4ff` on ink, `#2f5bd3` on paper |
| Kinds | `text-kind-*` / `bg-kind-*` | `conversation`, `source`, `file`, `note`, `session` — identity, not decoration |

Primary buttons are ink on paper (`accent` = foreground). Colour never marks a
control's importance; the kind colours mark what a thing *is*, the link colour
marks where you are and what you chose.

`src/lib/memory/kinds.ts` (`itemKind`) is the one classification of items into
kinds; `KindGlyph` (`components/ui/kind-glyph.tsx`) is the one way to draw it.

## Elevation and light

- `--shadow-sm / md / lg` are polarity-aware: on ink they are cast much deeper,
  because a 14% shadow is invisible on near-black.
- `--surface-highlight` is the lit top edge of a floating panel.
- `surface-panel` (utility) = elevated fill + hairline + `shadow-md` + lit
  edge. Inspectors, hover cards, graph toolbars and the palette use it.
- `--shadow-panel` / `--shadow-window` combine a shadow with the lit edge.

## Type

Two voices: the display face (Geist) for page-opening statements, the
product face (system UI) for everything else. No weight above 500.

| Utility | Size | Use |
| --- | --- | --- |
| `text-display` | 36 | a destination's opening line (Home's greeting) |
| `text-statement` | 26 | a project's name |
| `text-title` | 22 | panel/page titles, the Continue card |
| `text-h1` / `text-h2` | 18 / 13 medium | inspector titles, bar titles |
| `text-body` / `text-body-sm` | 13 / 12 | content |
| `text-meta` | 11 tabular | counts, times |
| `text-eyebrow` | 11 caps | section labels |

New `text-*` utilities must be registered in `TYPE_CLASSES`
(`src/lib/utils.ts`) or `cn()` silently drops them next to a colour class.

## Space, radius, layering

10px grid (`--hb-g`), 22.4px vertical rhythm (`--hb-v`). Radius derives from
the Shape setting: `rounded-xs` rows, `rounded-md` inputs, `rounded-lg` cards
and panels, `rounded-xl` the Continue card. Layers: `--hb-z-sticky` 20 (page
bars), 40 sidebar, 50 overlay, 60 popover, 70 toast.

Every destination opens with a 48px sticky, translucent bar
(`components/ui/page-header.tsx`): content scrolls under it.

## Motion

| Token | Value | For |
| --- | --- | --- |
| `--duration-fast` | 140ms | hover, press, colour |
| `--duration-base` | 200ms | menus, popovers, inline reveals |
| `--duration-slow` | 320ms | panels, page entrances |
| `--duration-focus` | 560ms | the graph camera travelling to a selection |
| `--ease-standard` | decelerate, no overshoot | things arriving, camera |
| `--ease-spring` | critically damped `linear()` | direct manipulation, selection feedback |
| `--ease-color` | material ease | colour and opacity |

Utilities: `animate-enter` (a destination arriving: rise 6px), `animate-rise`
with `--stagger` (a list settling top-down, capped at 10 steps), `animate-fade`,
and the inspector's `hb-panel-in` / `hb-sheet-in`.

Rules:

1. Motion explains a change of state or place. Nothing animates for its own sake.
2. Rows and controls hit hundreds of times a day change colour, never position.
3. Never animate everything at once — stagger, or animate the container.
4. Durations scale with Settings → Motion; Animations: Off and the OS's
   reduced-motion preference reach CSS automatically and script through
   `useReducedMotion()`.
5. Nothing loops while the interface is idle — with one exception: the
   Graph's slow ambient light (the galaxy's twinkling dust, the core's
   breathing), and only while it is on screen, the page is visible and motion
   is allowed. Otherwise it too draws only when something changed.

## The Graph

`src/lib/knowledge-graph` (data, layout, camera) and
`src/components/knowledge-graph` (canvas, inspector, list).

**What it shows.** Projects, their items (conversations, sources, files,
notes), every tab saved into a project (a tab dump or import Hubble holds no
text for is a source drawn hollow, with a "Saved tabs" filter of its own) and
saved browser sessions. **Edges are only relationships the records prove**:
an item belongs to a project; the same address (`sourceKey`) is saved in two
projects; an excerpt quotes a saved page; a session was saved for a project;
a session has a saved page open — and the relationships the person made
themselves between saved tabs, a link or a dependency, drawn in the accent.
Nothing is inferred to make the picture fuller.

**One graph.** The Graph is the only graph: the old Tab map was merged into
it. A saved tab is managed where it is drawn — opened, noted, favourited,
filed in a collection, moved, linked, given a dependency or removed — from
the inspector's More menu or by right-clicking it (`tab-actions.tsx`, one list
for both). Links still live in `tabdump:graph:v1`'s `manualConnections`
(`useTabLinks`), dependencies and collections in their own stores, so nothing
saved before the merge is lost. Up close a source shows its site's favicon, as
the Tab map's nodes did. Every list row that names an item (Home, Library, the
Graph's lists) draws it with `ItemIcon`: its AI app's logo, its site's
favicon, or its kind's glyph only when it has neither.

**The galaxy.** The Graph is drawn as one spiral galaxy, after the miniature
on Home's Continue card. A real perspective camera (`projection.ts`) looks at
a tilted disc. At the origin is the **core** — "All projects" — a brilliant
white nucleus packed with thousands of points. Two logarithmic **arms** wind
out of it (`galaxy.ts`: θ = phase + arm·π + 1.5·ln(r/20)), and every project
is a **star cluster** strung along one of them; its items are the stars in
that cluster. Two faint inclined orbits and a dashed rim circle the disc. The
palette is the Graph's own cool light — `--graph-filament / rose / blush /
ember / starlight / hub` in `globals.css` — with the arms' gas in the theme's
`--link`, `--kind-note` and `--kind-source` hues (indigo, violet, teal) over
the theme's ground; on light themes the canvas derives an ink-on-paper variant.

**Three layers** (`knowledge-graph-canvas.tsx`). Back (2D): the ground, far
stars, gas along the arms, the orbits. Middle (WebGL, `galaxy-gl.ts`): the
galaxy's body — about 15,000 particles of core, arms, disc and a dust knot
round every project's hub (`galaxy-field.ts`), one draw call, projected in
the vertex shader by the same camera maths as `project()`. Without WebGL the
back canvas draws a sparser field instead. Front (2D, takes the pointer):
what the person keeps — every item as one star, relationships, the nucleus,
names. The dust is generated from a fixed seed and the projects' ids and
places, so it is real structure (arms the layout uses, knots on real hubs),
never a backdrop, and the same galaxy every time.

**Encoding.** Kind = tint *and* shape, tints mostly starlight: a conversation
is the brightest star, with a faint four-point flare (its AI app's logo up
close); a source a smaller cool point (its site's favicon up close); a file a
tiny square; a note a diamond; a session a hollow hexagon. Recently touched
items burn a little brighter. Unread/failed items and saved tabs Hubble holds
no text for are a fainter star inside a fine ring, never hidden. A project's
heart is its cluster's brightest point. Belonging to a project needs no line —
the cluster says it — so a cluster's threads to its stars show only while it
is hovered or chosen. Relationships between items are faint arcs lifting out
of the disc; the ones the person made (links, dependencies) are in the accent.

**Layout.** Projects go along the arms largest-first from the core, each next
one on the arm whose outermost project it shares most with (sources,
sessions), so related work is neighbours. Each cluster sits as near the core
as its arm allows while clear of every cluster already placed. Inside a
cluster, items take closed-form slots in one lobe per kind, newest nearest
the heart, drawn out a little along the arm. Sessions for no project drift in
the halo. Deterministic, sliced so it never blocks a frame, and append-only:
remembered positions are reused exactly (layout generation 5 in
`persistence.ts`), a new project takes the first clear place on its arm and a
new item the free slot nearest its rank, so nothing else moves.

**Level of detail.** Far: the core, clusters and their names. Middle:
emphasised items named. Near: every item that has room is named, and the core
resolves into individual points. Labels are placed greedily by priority and
never overlap; a cluster's name sits on a short leader line with its count
beneath in mono.

**Motion.** The opening grows the dust out from the core and lights the
stars outward while the camera swings into place. At rest the dust twinkles,
the core breathes, a sparse light drifts along relationships between
projects, and the camera leans a little toward the pointer. Nothing moves
position: the galaxy does not spin, so what you found stays where it is. A
selection lights its relationships with slower, brighter sparks travelling
outward. Arriving and departing nodes (filters, new saves) fade rather than
pop. Reduced motion: no opening, no twinkle, no sway — the selection's sparks
hold still.

**Interaction.** Hover brightens the star (a project's cluster gains its
outline) and previews its title and type; it never dims the rest. Click
selects, quiets the rest, outlines and lights the chosen project's cluster
while the rest of the galaxy's dust dims, travels the camera to the selection
and its relationships; double-click or Enter opens the real thing
(conversation reader, file preview, project, session restore). Choosing a
project in the filter travels to it. The inspector lists metadata,
relationships (each one a way to travel on) and actions; Back returns to the
previous selection. Search, kind and project filters, zoom/fit, arrow-key
traversal with a live region, and a List view of the same data make the whole
graph usable without the canvas. Panning is bounded to the galaxy's disc.

**Performance.** The dust costs a handful of uniforms a frame, not a loop in
JavaScript; it is rebuilt only when projects, their places or the palette
change. Strokes are batched into one path per colour and brightness; glows
are pre-rendered sprites, never shadowBlur; device pixel ratio is capped at 2.
Hit-testing runs against the frame just drawn through a spatial grid. The
ambient loop runs at ~30fps (20 past 1,200 nodes), full rate only while
something moves, and stops when the canvas is off screen, the tab is hidden,
the List covers it or motion is reduced. Resize/theme/visibility observers,
the WebGL context's resources and every listener and frame are released on
unmount.
