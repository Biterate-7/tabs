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
5. Nothing loops while the interface is idle. The graph draws only when
   something changed.

## The Graph

`src/lib/knowledge-graph` (data, layout, camera) and
`src/components/knowledge-graph` (canvas, inspector, list).

**What it shows.** Projects, their items (conversations, sources, files,
notes) and saved browser sessions. **Edges are only relationships the
records prove**: an item belongs to a project; the same address
(`sourceKey`) is saved in two projects; an excerpt quotes a saved page; a
session was saved for a project; a session has a saved page open. Nothing is
inferred to make the picture fuller. Saved tabs without content stay in the
**Tab map** (the original graph, under More), which keeps its organizer gate.

**Encoding.** Kind = colour *and* shape (circle conversation, rounded square
source, folded page file, diamond note, hexagon session), so nothing relies on
colour alone. Projects are rings with an inner orbit; each holds a territory —
a faint pool of cool light with a dotted orbit at its edge. Recent items carry
a thin ring. Unread/failed items are drawn hollow and dashed, never hidden.

**Layout.** Golden-angle spiral of project territories relaxed by collision,
with projects that share sources pulled together; items settle by kind sector
and recency inside their territory. Deterministic (hashed seeds), sliced so it
never blocks a frame, and append-only: remembered positions are reused, so a
new conversation finds a place without moving anything else.

**Level of detail.** Far: projects and names. Middle: emphasised items named.
Near (≥115%): every item that has room is named. Labels are placed greedily by
priority and never overlap.

**Interaction.** Hover previews; click selects, quiets the rest, travels the
camera to the selection and its relationships, and sends one signal along
each relationship; double-click or Enter opens the real thing (conversation
reader, file preview, project, session restore). The inspector lists metadata,
relationships (each one a way to travel on) and actions; Back returns to the
previous selection. Search, kind and project filters, zoom/fit, arrow-key
traversal with a live region, and a List view of the same data make the whole
graph usable without the canvas.

**Performance.** Hit-testing through a spatial grid; off-screen nodes are
culled; bloom is skipped past 900 nodes and many-body repulsion past 1,500.
Resize/theme observers and every listener and frame are released on unmount.
