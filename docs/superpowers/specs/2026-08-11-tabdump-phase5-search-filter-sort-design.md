# TabDump — Phase 5: Search, Filtering & Sorting Design

## Scope
Add global search (Cmd/Ctrl+K), category filter pills, and a sort control to the workspace, without redesigning the dashboard. No new backend, no new data — this operates entirely on the `Tab[]` already held in `WorkspaceView`'s state.

## Reconciling "search" with "filter" with "don't redesign the dashboard"
The spec's own QA list ("search, filter, combined search + filter, sorting") implies one coherent system, not a separate ephemeral command palette bolted onto an unrelated dashboard. The design: `WorkspaceView` keeps its existing `CategoryGrid` as the **default, unchanged view** (this satisfies "do not redesign the dashboard"). The moment the user has a non-empty search query, a non-"All" category filter, or a non-default sort, the view swaps to a single flat, sorted `FilteredTabList` (built from the existing `TabCard`) showing exactly the matching tabs — with the spec's required empty state when nothing matches. Clearing search, resetting the filter to "All", and resetting sort to "Recently added" all together return the view to the grid. One mechanism, three inputs, matching the QA matrix directly.

## Search
- Extends Phase 4's header search from a toggle-to-reveal `Input` into an always-mounted, always-visible input (so `Cmd/Ctrl+K` has something reliable to focus) with a clear (×) affordance once it has a value.
- Matches across `title`, `domain`, `url`, and the category's **display name** (not just the raw id) — a case-insensitive substring match, pure and unit-tested in `src/lib/workspace/search.ts`.
- `Cmd/Ctrl+K` (global `keydown` listener, `preventDefault`) focuses the search input from anywhere on the page. `Escape`, while the input is focused, clears the query and blurs it — "closing" search back to the grid.

## Filters
- A compact, single-row, wrapping strip of pill buttons: `All` plus the 8 categories, each showing a live count (`Research (14)`), rendered above the results/grid. `All` is the implicit default and doesn't need its own dedicated affordance beyond being the reset state.
- Selecting a category pill sets `categoryFilter`; reselecting it (or picking "All") clears it. Purely additive with search — both apply together via the same `filterTabs` function.

## Sorting
- A single compact `Select`-style control (reusing the existing `DropdownMenu` primitive, consistent with `TabCard`'s category picker rather than introducing a new primitive) with 4 options: **Recently added** (default — original array order, i.e. the order tabs were parsed in, since there's no timestamp field yet and nothing currently re-orders the array), **Title**, **Domain**, **Category** (alphabetical by category display name). Only visible/relevant once results are shown as a list — sorting category *cards* isn't meaningful, so the control lives alongside the filter strip, not the grid.

## Keyboard UX
- `Cmd/Ctrl+K`: focus search (global).
- `Escape` (while search focused): clear query, blur.
- `ArrowDown`/`ArrowUp` (while search focused and results are showing as a list): move a highlighted-result index.
- `Enter` (while search focused): open the highlighted result's URL in a new tab (same `window.open` helper `TabCard` already uses) — "where appropriate" is read as: only when there's at least one visible result.
- Nothing beyond this — the spec explicitly says not to overbuild shortcuts.

## Performance
- `filterTabs` and `sortTabs` are pure O(n) / O(n log n) functions; `WorkspaceView` memoizes the combined `resultTabs` on `[tabs, query, categoryFilter, sortKey]` via `useMemo`, exactly like Phase 4's existing `visibleTabs` memo it replaces. A Vitest performance test asserts filtering+sorting 500 tabs stays well under a generous threshold, mirroring the perf-test pattern already used in Phases 2 and 3.

## Explicitly excluded
A separate Cmd+K command-palette overlay (redundant with the inline search + results list here), fuzzy/ranked search (plain substring match is "instant" and sufficient at this scale), persisting search/filter/sort state across a reload (no persistence layer exists yet), sorting the category grid itself.
