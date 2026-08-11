# TabDump — Phase 3: Categorization Engine Design

## Scope
A local, deterministic, scoring-based categorization engine for parsed tabs. No UI changes, no dashboard. Wires into the existing `parse → normalize → deduplicate` pipeline (`src/lib/tabs`) as a new final step: `categorize`.

## Categories
Centralized in `src/lib/categories/definitions.ts` as a single source of truth: `id`, `name`, `icon` (a `lucide-react` component reference), `description`, `accentColor` (a CSS variable name added to `globals.css`, following the existing token pattern — e.g. `--category-research`). Eight categories: Research, School, Projects, Shopping, Creative, News, Read Later, Other.

## Scoring architecture
No if/else chains. A flat, data-driven rule table (`src/lib/categories/rules.ts`) of `{ categoryId, score, test(context) }` entries, where `context` is derived once per tab from its `normalizedUrl` (`hostname`, `pathname`, `search`). Domain rules match hostname (exact or suffix, handling multi-TLD brands like `amazon.*`); keyword rules match pathname/query substrings. Rules are additive — a tab accumulates a score per category by summing every matching rule's `score`; nothing short-circuits. This is what lets an ambiguous domain like `figma.com` (Creative-high + Projects-medium) or `medium.com` (Research-medium) resolve by magnitude instead of rule order, per the spec's own overlapping examples.

**Weights**: high-confidence domain match = 90, medium-confidence domain match = 55, keyword/heuristic signal = 15–25 (additive, capped at 100 per category).

## Classification
`classify(tab)` in `src/lib/categories/classify.ts`: computes all category scores, takes the argmax, converts to confidence via `min(1, score / 100)`. If the winning score is below `MIN_CONFIDENT_SCORE` (40 — below even a single medium-confidence match), the result is forced to `Other` with its low raw confidence preserved, so ambiguous/unknown sites never get confidently mislabeled. Ties resolve to whichever category was defined first in `CATEGORY_ORDER` (deterministic, documented, not random).

## Overrides
`Tab.category` (already an optional field from Phase 2) and a new `Tab.confidence?: number` are the only fields the engine touches. Nothing else in the codebase reads engine internals to decide category — a future manual correction is just `tab.category = "School"`, which doesn't require touching `src/lib/categories/*` at all. This satisfies the override requirement without any extra "override" data structure — YAGNI, the plain mutable field already supports it.

## Integration
`src/lib/tabs/index.ts`'s `parseTabInput` gains one more step: `categorizeTabs(markDuplicates(...))`. `categorizeTabs` lives in `src/lib/categories/index.ts` and is a pure `(tabs: Tab[]) => Tab[]` map, imported by `src/lib/tabs`, not the other way around — `src/lib/categories` has no dependency on `src/lib/tabs` beyond the shared `Tab` type, keeping the engine testable in isolation.

## Explicitly excluded
Dashboard/workspace UI, category badges rendered anywhere, page-title-based signals (spec says "later"), external/AI calls (spec forbids), persistence of overrides.
