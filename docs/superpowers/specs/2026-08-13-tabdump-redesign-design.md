# TabDump Full Product Redesign — Design

## Product & goal

TabDump: paste a mess of browser tabs, get back an organized workspace. It already works end-to-end (parsing, normalization, dedup, categorization, persistence, export, cleanup) on a dark-first Next.js/Tailwind/shadcn stack. This is **not** a rebuild — it's a systemization and interaction-model upgrade so the product reads as a deliberately designed, premium SaaS tool ("could launch publicly tomorrow") instead of a functional-but-ad-hoc UI.

**Preserved, not touched by this redesign:** URL parsing/normalization/dedup logic, categorization heuristics, localStorage persistence format, export file formats, and the existing copy voice (blunt, confident, slightly irreverent — "Your tabs are a mess. Dump them." stays verbatim).

**Explicit non-goals:** no light mode build-out (tokens stay structured so it isn't precluded later), no auth/backend/AI/network changes, no new categorization logic, no dependencies beyond one addition (`cmdk`).

## Direction

Anchor: **Linear × Arc**, used as an interaction/quality bar, not a visual template — dense-but-calm, monochrome canvas, one accent used sparingly, information over decoration, keyboard-first. TabDump keeps its own personality (fast, technical, slightly irreverent, confident) expressed through **copy, interaction design, motion, and detail** — not through loud visual decoration, gradients, or generic SaaS card grids.

The workspace is the hero of this redesign, not the landing page. Landing should be polished; the workspace gets the majority of design attention because it's the actual product surface.

## Design tokens

### Typography

Geist Sans for UI text, Geist Mono reserved for counts, timestamps, keyboard-shortcut hints, and other tabular/numeric data — this is a deliberate personality choice (numbers get a distinct, technical rhythm from prose).

| Step | Size / line-height | Weight | Tracking | Use |
|---|---|---|---|---|
| display | 3.5rem/1.05 (clamp to 2.25rem mobile) | semibold | -0.02em | landing hero headline only |
| h1 | 1.5rem/1.3 | semibold | -0.01em | dialog/sheet/palette section titles |
| h2 | 1.125rem/1.4 | semibold | normal | category group headers |
| body | 0.9375rem/1.5 | normal | normal | tab titles, menu items, primary UI text |
| body-sm | 0.8125rem/1.4 | normal | normal | domains, descriptions, secondary text |
| label | 0.75rem/1.3 | medium | 0.01em | pills, filters, section labels |
| meta-mono | 0.75rem/1.2 (Geist Mono, tabular-nums) | normal | normal | counts, shortcuts, timestamps |

Every component's text sizing is audited against this table during implementation — no more ad hoc `text-2xl`/`text-sm` picks per component.

### Spacing

Tailwind's default scale is already 4px-based (1=4px, 2=8px, 3=12px, 4=16px, 6=24px, 8=32px, 12=48px, 16=64px) — no new CSS variables needed. The fix is discipline, not a new scale: implementation restricts spacing utilities to `{1,2,3,4,6,8,12,16}` and removes arbitrary values (`gap-3.5`, magic px) found during the component pass.

### Color

Keep the existing token set — it's already sound — but document and consistently enforce it (this corrects the actual bug: inconsistent *application*, not a flawed token design):

- **Text hierarchy (3 tiers, already AA-verified):** `--foreground` (primary: titles, primary values) → `--muted-foreground` (secondary: descriptions, labels) → `--text-tertiary` (tertiary: metadata, counts, timestamps — deliberately dimmer, already contrast-tuned). Document this as the rule and audit every component against it.
- **Elevation (3 tiers):** `--background` (base canvas) → `--card` (surface: tab rows, category groups, inline panels) → `--popover` (elevated: menus, dialogs, sheets, command palette). No more flat `bg-card` everywhere regardless of layer.
- **Accent:** `--primary` (#4361ff, solid fills) / `--accent-text` (#8a9dff, text/icon on dark — already split for contrast). Used sparingly: primary actions, active/selected state, focus ring.
- **Category colors:** the 8 existing `--category-*` vars stay. Usage rule: small icon/dot only, never a large fill — this is what keeps 8 categories from reading as a loud rainbow grid.
- **Selection/active state:** formalize the `bg-primary/15` + `border-primary/30` pattern already used ad hoc (filter pills, category badge) into one documented pattern, applied consistently to: selected rows, active palette item, active filter pill, highlighted search result.
- **New:** `--danger`/`--danger-foreground` mapped from the existing (currently unused in UI) `--destructive` token, for bulk-remove and other destructive affordances outside dialogs.

### Motion

New tokens (not currently defined): `--ease-standard: cubic-bezier(0.16, 1, 0.3, 1)`, `--duration-fast: 120ms` (hover/press), `--duration-base: 160ms` (menus, dropdowns, filter changes), `--duration-slow: 220ms` (sheet/dialog/palette entrance, category stagger, count-up). All non-essential motion (stagger, count-up, transitional loading beat) is disabled under `prefers-reduced-motion: reduce`; state changes remain instant, never blocked.

## Component system

Restyled in place (logic untouched): Button, Input, Badge, DropdownMenu/ContextMenu, Dialog/AlertDialog/Sheet, Checkbox, toasts (sonner).

**IconButton** — gets a visible rest-state boundary (currently invisible until hover, flagged directly in the brief as looking non-interactive): subtle border/background at rest, clear hover/active states, paired with a tooltip.

**New primitives:**
- `Tooltip` (built on the already-installed `@base-ui/react`, no new dependency) — wraps every icon-only button.
- `Kbd` — small monospace shortcut-key chip, used in the command palette and tooltips.
- `CommandPalette` (built on new `cmdk` dependency) — see below.
- `SelectionToolbar` — contextual bar shown only while selection mode is active.
- `EmptyState` — one reusable component (icon/illustration slot, headline, subtext, optional action) used everywhere an empty state appears, so copy stays personality-driven and consistent instead of ad hoc "No results found" strings.
- `AttentionStrip` — conditional single-line banner on the workspace home.

## Flows

### Landing (polished, but secondary focus)

Existing hero copy, layout, and live-parsing status line are kept verbatim. On submit, instead of an instant hard cut to the workspace, a short deliberate transition plays: the CTA becomes a brief "Organizing 47 tabs…" state (categorization is already synchronous/instant — this introduces an intentional minimum-duration beat, capped short, so it reads as purposeful rather than laggy), then the workspace mounts with its entrance animation (stat count-up, category stagger). This is the "chaos → organized" payoff moment called for in the brief — subtle, not gimmicky, skippable under reduced motion (cuts straight to the end state).

### Workspace home — the hero screen

Top to bottom:
1. **Header** — wordmark + tab count (mono), search, Cmd+K hint chip on desktop, action menu.
2. **Attention strip** (conditional, only when relevant — e.g. duplicates found, one category holding a disproportionate share of tabs) — one line, subtle tinted background, inline action button wired to the existing Cleanup/category flows. Never shown when there's nothing to flag.
3. **Stats row** — same 4 metrics, restyled as a lighter/denser divided row rather than 4 equal-weight cards, numbers in mono with a count-up on first mount.
4. **Category hierarchy** — categories are no longer 8 visually identical cards. Sorted by tab count descending (with "Other" always pinned last regardless of count, since it's a residual bucket, not a real destination). Three presence tiers: populated top categories get more visual weight (wider, more preview rows), mid-count categories get the standard treatment, empty/near-empty categories collapse into a single compact line rather than a full card — directly answers "8 identical cards" and "here's where your tabs actually are."
5. **Tab list** (search/filter/sort results, category detail Sheet) — redesigned away from bordered-card-per-row toward a dense, divider-separated list (hairline `border-b`, no per-row card chrome) closer to a premium file/productivity list than a grid of SaaS cards. Row actions (open, more, category) reveal on hover/focus rather than sitting as permanent chrome; a selection affordance appears per-row only in selection mode.

### Command palette (Cmd+K) — the power-user command center

Not a styled search box — a real command center via `cmdk`, grouped, searchable, keyboard-navigable:

- **Navigation:** Search tabs (default typing mode), Go to category → (submenu of the 8 categories), Show all tabs, Show duplicates.
- **Selection:** Toggle selection mode, Select all visible.
- **Actions:** Cleanup duplicates (opens the existing CleanupDialog), Export all / Export current category (wraps the existing ExportMenu actions), Clear workspace (opens the existing confirm dialog — the palette never bypasses a destructive confirmation).
- **Sort:** by title / domain / category / recently added.
- **Help:** Keyboard shortcuts reference.

Each item: icon, label, optional shortcut chip (`Kbd`), grouped by category, fuzzy-ranked by `cmdk`'s built-in scoring, Enter activates immediately where the action is non-destructive. "Change theme" is intentionally **not** included — the product is dark-only by design in this redesign (see non-goals); a theme command would advertise a capability that doesn't exist.

### Bulk selection & toolbar

Entering selection mode (via the palette, an explicit affordance in the list, or selecting a row) morphs the interface into a contextual state: a `SelectionToolbar` appears with a live "N selected" count (mono), and actions — Recategorize (submenu of 8), Export selected, Open selected (confirms first above a sane threshold, since opening many tabs at once is disruptive), Remove selected (routes through a confirm, consistent with existing destructive-action patterns), Clear selection. Checkboxes on rows are only present while selection mode is active — not permanent chrome. Escape exits selection mode.

### Empty states

Every major empty state (zero search results, empty category, no duplicates, cleared workspace) uses the new `EmptyState` component with TabDump's actual voice and a concrete next action — not generic "No results found" text. Examples: no search results → "Nothing matches "asdf". Try another word, or clear your filters." with a Clear-filters action.

### Mobile — its own interaction model, not a squeeze

- Header becomes two rows: wordmark/count, then a full-width search plus one overflow action button (Cleanup/Export/Clear/Command-menu live inside it) — replaces today's cramped single-row `flex-wrap` fight.
- Command palette renders as a full-screen sheet on mobile instead of a floating centered panel.
- Selection toolbar becomes a bottom-fixed, thumb-reachable bar (no hover affordances exist on touch, so selection mode is entered via an explicit toggle/long-press rather than a hover-revealed checkbox).
- Tab rows hit ≥44px touch targets on mobile/tablet breakpoints specifically (a genuine mobile-UX target, distinct from — and stricter than — the WCAG 24px minimum already satisfied on desktop).
- Category browsing collapses empty/near-empty categories more aggressively on small screens to reclaim vertical space.

### Keyboard shortcuts

`Cmd/Ctrl+K` → command palette · `/` → focus search (when no input is focused) · `Escape` → context-sensitive close (palette → dialog/sheet → selection mode → clear search) · `↑`/`↓` → navigate list/palette results · `Enter` → open highlighted tab / run palette command · `Cmd/Ctrl+A` → select all visible (only meaningful once selection mode or a list is focused). No shortcuts invented without a real action behind them. All shortcuts are discoverable via the palette's Help entry and via tooltips where relevant.

### Accessibility

Every icon-only button ships an accessible label, a visible tooltip, a visible rest-state boundary (not hover-only), and a real touch target per breakpoint. Selection state is never color-only (checkbox, not just a tint). The command palette gets correct listbox/combobox semantics and focus trapping (via `cmdk`), returning focus on close. New tokens (attention-strip tint, selection tint) are contrast-checked before shipping. All existing AA fixes are preserved.

## Delivery approach

No framework or major library changes. One new dependency: `cmdk`. Delivered in 8 phases (tokens → primitives → landing → workspace → power-user UX → responsive → motion/polish → QA), each independently committable and verifiable in the browser, detailed in the accompanying implementation plan. Implementation proceeds through all phases without pausing for design re-approval, per direction; a stop is warranted only for a genuine architectural blocker.
