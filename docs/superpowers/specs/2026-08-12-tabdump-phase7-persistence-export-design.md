# TabDump — Phase 7: Local Persistence, Export & Clipboard Design

## Scope
Make the workspace survive a refresh (localStorage), add copy/export actions, handle the three named failure modes gracefully. No dashboard redesign, no backend, no cloud sync.

## What actually needs persisting
The spec lists tabs / categories / user category changes / cleanup state as four things to persist. They're one thing: **the `Tab[]` array**. `category` is already a mutable field on `Tab` (Phase 4), so "categories" and "user category changes" are the same field. "Cleanup state" isn't a separate concept — `CleanupDialog` computes duplicate groups live from whatever `tabs` currently is (Phase 6); once the user removes duplicates, the *result* is the persisted `tabs` array. There's nothing else to store. One `localStorage` key, one JSON blob: `{ version: 1, tabs: Tab[] }`.

## Where persistence lives
`AppShell` is already the single place `workspaceTabs` state lives (Phase 4) and the single funnel every mutation passes through (`onTabsChange`, `onDump`, `onClear`). Persistence hooks into exactly those three call sites — no other component needs to know storage exists. `src/lib/workspace/persistence.ts` holds pure, try/catch-wrapped read/write/clear functions; `AppShell` calls them.

## Hydration
Next.js SSR can't read `localStorage`, so the server-rendered (and first client) paint must be identical either way — the standard fix is an `useEffect` that runs once after mount: read storage, populate state, then flip a `hydrated` flag. Until `hydrated` is true, `AppShell` renders `null` (the body's own near-black background already shows through, so this is a seamless blank frame, not a white flash) rather than briefly flashing the landing page before swapping to a restored workspace.

## Clear workspace must clear storage too
Phase 4's confirmation flow (open AlertDialog → explicit second click) already makes "impossible to accidentally clear with one click" true — one click alone only opens a dialog. But it currently only resets React state; with persistence added, `onClear` must also call `clearWorkspaceStorage()`, or a refresh would resurrect the "cleared" workspace. The confirmation copy is updated from "isn't saved anywhere" (true pre-persistence) to reflect that a saved workspace is what's being wiped.

## Copy & export
Three actions replace the single Phase 4/5 "Export" button, now a dropdown (`ExportMenu`):
- **Copy all URLs** — `tab.url` (the original, never the tracking-stripped `normalizedUrl`) for every tab, newline-joined, `navigator.clipboard.writeText`.
- **Copy category URLs** — a submenu (shadcn's existing `DropdownMenuSub`) listing all 8 categories with live counts (reusing Phase 5's `categoryCounts`), disabled at 0; copies just that category's URLs. A submenu is used instead of relying on the page's current filter pill so the action works regardless of what view is showing.
- **Export TXT** — `TABDUMP EXPORT` header, then each non-empty category as an uppercase heading followed by its URLs, blank-line separated, per the spec's exact block. Triggered via a `Blob` + object URL + synthetic `<a download>` click (no server involved).

## Error handling
- **Clipboard unavailable/denied**: `navigator.clipboard?.writeText` is optional-chained and wrapped in try/catch; failure shows an error toast (`Couldn't copy to clipboard`) instead of throwing. No deprecated `execCommand` fallback — that's exactly the kind of complexity the spec's "do not overengineer" section warns against, and a failed copy with clear feedback keeps the app usable.
- **localStorage unavailable**: detected once via a feature-test write on mount (`isStorageAvailable`). If unavailable, all persistence calls are skipped for the session (silent no-ops, not repeated failures) and a single informational toast tells the user their workspace won't be saved. The app otherwise works identically, in-memory only.
- **Export failure**: the whole `downloadTextFile` sequence (Blob → object URL → anchor click → revoke) is try/caught; failure shows an error toast (`Couldn't export workspace`).

## Explicitly excluded
Cloud sync, IndexedDB, multiple saved workspaces, undo for Clear, persisting search/filter/sort UI state (that's view state, not workspace data — resetting on reload is expected), a deprecated clipboard fallback.
