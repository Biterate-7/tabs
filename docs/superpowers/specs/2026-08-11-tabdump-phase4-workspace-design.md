# TabDump — Phase 4: Workspace Dashboard Design

## Scope
The organized workspace view: landing → paste → workspace, built entirely on real Phase 2/3 data (`parseTabInput`). No backend, no persistence — this is a client-state flow that will gain persistence in a later phase.

## Navigation flow
No new route. `src/app/page.tsx` becomes a thin server component; a new client component `AppShell` owns a single piece of state, `workspaceTabs: Tab[] | null`. `null` renders the existing landing view (Header/Hero/TabInput, untouched visually); once `TabInput`'s CTA is clicked with valid tabs, `AppShell` receives the categorized `Tab[]` and switches to the workspace view. This avoids inventing persistence (sessionStorage, routes) that Phase 4 doesn't ask for and a later phase may replace with something real — YAGNI, and it keeps `parseTabInput`'s existing output shape as the only contract between the two views.

## Component choices (spec left these open)
- **Category expansion → Sheet** (slide-in panel, shadcn `Sheet`, `side="right"` on desktop and full-width on mobile via existing breakpoint classes): fastest to open/close, keeps workspace context visible behind it, and shadcn already ships it.
- **Category reassignment → DropdownMenu** on each tab card, triggered by clicking the category badge or the overflow (`MoreHorizontal`) button. No separate modal — reassignment is a single click plus one selection.
- **Clear workspace confirmation → AlertDialog** (shadcn's purpose-built destructive-confirmation primitive).
- **Favicon → Avatar** (`AvatarImage` pointed at a public favicon service keyed by domain, `AvatarFallback` showing the domain's first letter over a deterministic accent-toned background derived from a hash of the domain — no network dependency for the fallback, and `AvatarImage`'s built-in error handling means a broken/missing favicon silently drops to the fallback, never a broken-image glyph).

## Structure
- `WorkspaceView` — header + overview + category grid, composes everything below
- `WorkspaceHeader` — wordmark, live tab count, Search (filters tab cards by title/domain, client-side, no new page), Cleanup (removes every tab already flagged `isDuplicate` by Phase 2's dedup — a single click, no confirmation needed since it only removes redundant copies of tabs that remain represented once; the overview's own "Duplicates" count goes to 0 and updates live), Export (copies every tab's URL, one per line, to the clipboard via `navigator.clipboard.writeText` — the one lightweight, no-dependency interpretation of "export" that needs no backend), Clear (opens the AlertDialog)
- `WorkspaceOverview` — 4 compact stat pairs (Total, Unique, Categories-with-tabs, Duplicates), text-first per spec ("not giant analytics cards")
- `CategoryGrid` / `CategoryCard` — icon, name, count, up to 3 representative tab domains, "View all →"; categories with 0 tabs are still shown (spec explicitly tests this) but visually de-emphasized (muted, no "View all")
- `CategorySheet` — the expansion panel, full tab list for one category, reuses `TabCard`
- `TabCard` — Avatar, title-or-domain, domain, category badge (opens reassignment dropdown), open button (`window.open(url, "_blank", "noopener,noreferrer")`), overflow menu (Change category submenu + Open)
- `lib/workspace/stats.ts` — pure functions computing overview numbers and per-category grouping from `Tab[]`, unit-tested, so the visual components stay simple mappers over already-correct data

## Metadata fallbacks
`title` is always absent from Phase 2/3 output today (no fetching), so every `TabCard` shows the domain as the primary line — this is the expected common case, not an edge case, and is exercised directly rather than treated as an exotic fallback. `favicon` likewise always falls through to the Avatar's fallback path today; the real favicon service call is included so the product looks finished the moment title/favicon fetching lands in a future phase, without a `TabCard` change.

## Responsive plan
Category grid: `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3` (desktop 3-up, tablet 2-up, mobile 1-up — matches "reduce columns" / "stack intelligently"). Overview stats: `grid-cols-2 sm:grid-cols-4`. Sheet becomes full-width below `sm`. No component introduces horizontal scroll at any tested width.

## Explicitly excluded
Real title/favicon fetching (network scraping), drag-and-drop reordering, persistence across reloads, multi-select bulk actions beyond "Cleanup" as scoped above, undo for Clear workspace (the confirmation step is the safety net).
