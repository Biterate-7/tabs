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
   Graph's slow ambient light (particles along filaments, the core's
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
themselves between saved tabs, a link or a dependency, drawn as gold ties.
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

**The galaxy.** A real perspective camera (`projection.ts`) looks down at a
tilted plane. At the origin is the **core** — the scope being looked at, "All
projects" — a small cube of light inside nested orbital rings, joined to every
project by a spoke. With one project chosen there is no root; that project's
hub is lit as the core instead (and a selection lights its own project's hub).
Each project is a **hub**: a warm-gold point inside two fine hexagons. Its
items fan out *away from the core* as a cone of rose-crimson filaments, one
sub-fan per kind, newest nearest the hub. Fans rise (a few fall) as they reach
out, so the whole reads as a dome; the depth is real geometry (`galaxy.ts`),
derived from ids and positions, never stored. The palette is the Graph's own
light — `--graph-filament / rose / blush / ember / starlight / hub` in
`globals.css` — over the theme's ground; on light themes the canvas derives an
ink-on-paper variant from the same tokens.

**Encoding.** Kind = tint *and* shape (particle conversation — the AI app's
own logo up close — point with a fine cross source, square file, diamond note,
hexagon session), tints mostly starlight so the filaments carry the colour.
Recent items carry a thin rose ring. Unread/failed items are drawn hollow,
never hidden. Relationships between items are **bridges** arching out of the
dome in warm white; containment is a stem of fine parallel strands that leave
their hub together along the fan's axis and part toward their items.

**Layout.** Hubs share the ring around the core: each takes an arc that grows
with its fan and sits as far out as that arc needs, with related projects
(shared sources, sessions) placed side by side. Items take closed-form slots
in their sub-fan. Deterministic, sliced so it never blocks a frame, and
append-only: remembered positions are reused exactly (layout generation 3 in
`persistence.ts`), a new project takes the widest gap and a new item the free
slot nearest its rank, so nothing else moves.

**Level of detail.** Far: the core, hubs and their names. Middle: emphasised
items named. Near: every item that has room is named. Labels are placed
greedily by priority and never overlap; a hub's name sits on a short leader
line with its count beneath in mono.

**Motion.** The opening grows the spokes from the core and each fan from its
hub, systems lighting in order outward, while the camera swings into place.
At rest, sparse particles drift along stems, spokes, bridges and orbits; the
core breathes over eight seconds; the camera leans a little toward the
pointer. A selection lights its relationships with slower, brighter sparks
travelling outward. Arriving and departing nodes (filters, new saves) fade
rather than pop. Reduced motion: no opening, no drift, no sway — the
selection's sparks hold still.

**Interaction.** Hover previews; click selects, quiets the rest, travels the
camera to the selection and its relationships; double-click or Enter opens the
real thing (conversation reader, file preview, project, session restore).
Choosing a project in the filter travels to it. The inspector lists metadata,
relationships (each one a way to travel on) and actions; Back returns to the
previous selection. Search, kind and project filters, zoom/fit, arrow-key
traversal with a live region, and a List view of the same data make the whole
graph usable without the canvas. Panning is bounded to the galaxy.

**Performance.** Strokes are batched into one path per colour and brightness;
glows are pre-rendered sprites, never shadowBlur; device pixel ratio is capped
at 2. Hit-testing runs against the frame just drawn through a spatial grid.
The ambient loop runs at ~30fps (20 past 1,200 nodes), full rate only while
something moves, and stops when the canvas is off screen, the tab is hidden,
the List covers it or motion is reduced. Resize/theme/visibility observers and
every listener and frame are released on unmount.
