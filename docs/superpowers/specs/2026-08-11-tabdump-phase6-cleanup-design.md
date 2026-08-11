# TabDump — Phase 6: Smart Cleanup Design

## Scope
A local, non-destructive-by-default cleanup flow: summary → review duplicate groups → confirmed removal → toast. No dashboard redesign, no AI, no backend, no persistence.

## A spec conflict this phase must fix
Phase 4's header **Cleanup** button currently calls `onTabsChange(tabs.filter(t => !t.isDuplicate))` — it deletes every duplicate instantly, with no review and no confirmation. That directly violates this phase's "Never automatically delete anything." So Phase 6 does not *add* a cleanup entry point beside the old one; it **replaces** that button's behavior with the reviewed flow below. This is a correctness fix, not scope creep.

## Defining "needs review"
The spec's summary block includes `8 need review` but doesn't define it. Rather than invent a new data field, this reuses Phase 3's `confidence`: a tab "needs review" when `confidence < 0.4` — the classifier's own `MIN_CONFIDENT_SCORE` threshold, i.e. exactly the tabs it fell back to **Other** on because no rule matched strongly. That is real, already-computed data and it means something actionable to the user ("we couldn't confidently categorize these"). It is surfaced as a count only; acting on it is category reassignment, which Phase 4 already ships.

## Duplicate grouping — one mechanism, three cases
The spec lists exact / normalized / tracking-parameter duplicates as three requirements. They collapse into **one** grouping key because Phase 2's `normalizeUrl` already lowercases the host, strips the hash and trailing slash, sorts query params, and removes `utm_*`/`fbclid`/`gclid`. So grouping by `normalizedUrl` catches all three by construction — `?utm_source=x` and the bare URL land in the same bucket, as do `/page` and `/page/`. No separate code paths, and the existing normalization tests already cover the hard part. Groups are the buckets with 2+ members; `originalUrl` is never touched, so each copy still displays its real URL.

## Two-stage dialog (why all three actions are distinct)
The spec's three actions — Keep all / Remove selected / Review manually — are redundant if everything sits on one screen. So the cleanup dialog has two stages, which also makes "inspect before removing anything" structurally guaranteed rather than merely offered:

1. **Summary stage** — the stats block (total / unique / duplicates / needs review) and the number of duplicate groups. Actions: **Keep all** (close, nothing changes) and **Review manually** (→ stage 2). There is no removal control here, so removal is unreachable without review.
2. **Review stage** — every duplicate group listed with its URL, domain, title (falling back to domain, as everywhere else), copy count, and which copy is currently marked *Keep*. The user can change which copy is kept, or check "keep all copies" to opt a whole group out. Actions: **Back**, and **Remove selected (N)** → `AlertDialog` confirmation → removal.

## Selection model
Per group: one `keepId` (defaults to the first copy) plus an optional per-group opt-out. The removal set is derived — `removalIds(groups, selection)` returns, for each non-skipped group, every tab except its `keepId`. Nothing is ever removed that the user hasn't seen in stage 2. After removal, `markDuplicates` is re-run over the survivors so `isDuplicate` flags and the workspace overview counts stay truthful.

## Feedback
Sonner toast, exact copy: `Removed 12 duplicate tabs.` with `75 tabs remain.` as the description. The generated `sonner.tsx` is simplified to drop `next-themes` and hardcode `theme="dark"`, since this app forces the `dark` class and ships no theme switcher — adding a theme provider for a theme that never changes would be dead weight.

## Explicitly excluded
AI, backend, cloud storage, automatic/destructive cleanup, persistence across reload (none exists — a refresh returns to the landing page, which the QA pass verifies rather than papers over), merging non-identical URLs, and any "smart" heuristic beyond exact normalized-URL matching.
