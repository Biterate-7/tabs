# TabDump Phase 6: Smart Cleanup Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace Phase 4's instantly-destructive Cleanup button with a reviewed, confirmed, local cleanup flow: summary → duplicate-group review → confirmed removal → toast.

**Architecture:** `src/lib/workspace/cleanup.ts` holds pure, unit-tested grouping/summary/selection/removal logic. `CleanupDialog` is a two-stage modal (summary → review) composed from existing shadcn `Dialog`, `AlertDialog`, and `Checkbox` primitives. `WorkspaceHeader`'s Cleanup button opens it instead of deleting. Feedback via `sonner`.

**Tech Stack:** TypeScript, React 19, shadcn `Dialog`/`AlertDialog`/`Checkbox`/`ScrollArea`, sonner, Vitest + Testing Library.

## Global Constraints

- **Never delete without review + explicit confirmation.** Removal is unreachable from the summary stage.
- Duplicate grouping key is `normalizedUrl` — covers exact, normalized, and tracking-parameter duplicates in one mechanism. Never mutate `url` (the original).
- "Needs review" = `confidence < 0.4` (Phase 3's `MIN_CONFIDENT_SCORE / 100`). Count only.
- Each duplicate group shows: URL, domain, title (falling back to domain), copy count, and which copy is kept.
- Three actions exist and are distinct: **Keep all** (close, no change), **Review manually** (summary → review stage), **Remove selected** (review stage only, behind an `AlertDialog`).
- After removal, re-run `markDuplicates` over survivors so `isDuplicate` and overview counts stay correct.
- Toast copy exactly: title `Removed N duplicate tabs.`, description `M tabs remain.` (singular `tab` when N or M is 1).
- No AI, no backend, no cloud storage, no persistence, no automatic destructive cleanup.

---

### Task 1: Cleanup pure logic

**Files:**
- Create: `src/lib/workspace/cleanup.ts`
- Test: `src/lib/workspace/cleanup.test.ts`

**Interfaces:**
- Consumes: `Tab` (existing), `markDuplicates` (existing, from `@/lib/tabs`).
- Produces: `DuplicateGroup`, `CleanupSummary`, `CleanupSelection`, `NEEDS_REVIEW_CONFIDENCE`, `findDuplicateGroups(tabs)`, `computeCleanupSummary(tabs)`, `defaultSelection(groups)`, `removalIds(groups, selection)`, `removeTabs(tabs, ids)` — consumed by `CleanupDialog` (Task 3) and `WorkspaceView` (Task 4).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/cleanup.test.ts
import { describe, expect, it } from "vitest";
import {
  findDuplicateGroups,
  computeCleanupSummary,
  defaultSelection,
  removalIds,
  removeTabs,
} from "./cleanup";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com/page",
    normalizedUrl: "https://example.com/page",
    domain: "example.com",
    category: "other",
    confidence: 1,
    ...over,
  };
}

describe("findDuplicateGroups", () => {
  it("returns no groups when every tab is unique", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://b.com" }),
    ];
    expect(findDuplicateGroups(tabs)).toEqual([]);
  });

  it("groups exact duplicates and counts copies", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com/x" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com/x" }),
      makeTab({ id: "3", normalizedUrl: "https://a.com/x" }),
    ];
    const groups = findDuplicateGroups(tabs);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(3);
    expect(groups[0].tabs.map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("groups tracking-parameter duplicates together (same normalizedUrl, different original url)", () => {
    const tabs = [
      makeTab({
        id: "1",
        url: "https://a.com/x?utm_source=news",
        normalizedUrl: "https://a.com/x",
      }),
      makeTab({ id: "2", url: "https://a.com/x", normalizedUrl: "https://a.com/x" }),
    ];
    const groups = findDuplicateGroups(tabs);
    expect(groups).toHaveLength(1);
    expect(groups[0].count).toBe(2);
    expect(groups[0].tabs[0].url).toBe("https://a.com/x?utm_source=news");
  });

  it("exposes domain and a title falling back to domain", () => {
    const tabs = [
      makeTab({ id: "1", domain: "a.com", normalizedUrl: "https://a.com/x" }),
      makeTab({ id: "2", domain: "a.com", normalizedUrl: "https://a.com/x", title: "Real Title" }),
    ];
    const [group] = findDuplicateGroups(tabs);
    expect(group.domain).toBe("a.com");
    expect(group.title).toBe("Real Title");
  });

  it("returns multiple independent groups", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com" }),
      makeTab({ id: "3", normalizedUrl: "https://b.com" }),
      makeTab({ id: "4", normalizedUrl: "https://b.com" }),
      makeTab({ id: "5", normalizedUrl: "https://c.com" }),
    ];
    expect(findDuplicateGroups(tabs)).toHaveLength(2);
  });

  it("handles an empty workspace", () => {
    expect(findDuplicateGroups([])).toEqual([]);
  });
});

describe("computeCleanupSummary", () => {
  it("reports total, unique, duplicates, needsReview and groupCount", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com", isDuplicate: true }),
      makeTab({ id: "3", normalizedUrl: "https://b.com", confidence: 0.1 }),
    ];
    expect(computeCleanupSummary(tabs)).toEqual({
      total: 3,
      unique: 2,
      duplicates: 1,
      needsReview: 1,
      groupCount: 1,
    });
  });

  it("counts a tab with no confidence as needing review", () => {
    const tabs = [makeTab({ id: "1", confidence: undefined })];
    expect(computeCleanupSummary(tabs).needsReview).toBe(1);
  });

  it("handles an empty workspace", () => {
    expect(computeCleanupSummary([])).toEqual({
      total: 0,
      unique: 0,
      duplicates: 0,
      needsReview: 0,
      groupCount: 0,
    });
  });
});

describe("defaultSelection / removalIds", () => {
  const tabs = [
    makeTab({ id: "1", normalizedUrl: "https://a.com" }),
    makeTab({ id: "2", normalizedUrl: "https://a.com" }),
    makeTab({ id: "3", normalizedUrl: "https://a.com" }),
    makeTab({ id: "4", normalizedUrl: "https://b.com" }),
    makeTab({ id: "5", normalizedUrl: "https://b.com" }),
  ];

  it("defaults to keeping the first copy of every group", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = defaultSelection(groups);
    expect(selection.keepIds["https://a.com"]).toBe("1");
    expect(selection.keepIds["https://b.com"]).toBe("4");
    expect(selection.skippedKeys).toEqual([]);
  });

  it("removes every copy except the kept one", () => {
    const groups = findDuplicateGroups(tabs);
    expect(removalIds(groups, defaultSelection(groups)).sort()).toEqual(["2", "3", "5"]);
  });

  it("respects a different kept copy", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = defaultSelection(groups);
    selection.keepIds["https://a.com"] = "3";
    expect(removalIds(groups, selection).sort()).toEqual(["1", "2", "5"]);
  });

  it("removes nothing from a skipped group", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = { ...defaultSelection(groups), skippedKeys: ["https://a.com"] };
    expect(removalIds(groups, selection)).toEqual(["5"]);
  });

  it("removes nothing when every group is skipped", () => {
    const groups = findDuplicateGroups(tabs);
    const selection = {
      ...defaultSelection(groups),
      skippedKeys: ["https://a.com", "https://b.com"],
    };
    expect(removalIds(groups, selection)).toEqual([]);
  });
});

describe("removeTabs", () => {
  it("removes the given ids and leaves the rest in order", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com" }),
      makeTab({ id: "3", normalizedUrl: "https://b.com" }),
    ];
    expect(removeTabs(tabs, ["2"]).map((t) => t.id)).toEqual(["1", "3"]);
  });

  it("re-marks duplicates so survivors are no longer flagged", () => {
    const tabs = [
      makeTab({ id: "1", normalizedUrl: "https://a.com" }),
      makeTab({ id: "2", normalizedUrl: "https://a.com", isDuplicate: true }),
    ];
    const result = removeTabs(tabs, ["2"]);
    expect(result).toHaveLength(1);
    expect(result[0].isDuplicate).toBe(false);
  });

  it("is a no-op for an empty id list", () => {
    const tabs = [makeTab({ id: "1" })];
    expect(removeTabs(tabs, [])).toHaveLength(1);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/cleanup.test.ts
```

Expected: FAIL — `cleanup.ts` does not exist.

- [ ] **Step 3: Implement `cleanup.ts`**

```ts
// src/lib/workspace/cleanup.ts
import { markDuplicates } from "@/lib/tabs";
import type { Tab } from "@/lib/tabs/types";

/** Matches Phase 3's MIN_CONFIDENT_SCORE (40) / MAX_SCORE (100). */
export const NEEDS_REVIEW_CONFIDENCE = 0.4;

export type DuplicateGroup = {
  key: string;
  domain: string;
  title?: string;
  tabs: Tab[];
  count: number;
};

export type CleanupSummary = {
  total: number;
  unique: number;
  duplicates: number;
  needsReview: number;
  groupCount: number;
};

export type CleanupSelection = {
  keepIds: Record<string, string>;
  skippedKeys: string[];
};

export function findDuplicateGroups(tabs: Tab[]): DuplicateGroup[] {
  const buckets = new Map<string, Tab[]>();
  for (const tab of tabs) {
    const bucket = buckets.get(tab.normalizedUrl);
    if (bucket) bucket.push(tab);
    else buckets.set(tab.normalizedUrl, [tab]);
  }

  const groups: DuplicateGroup[] = [];
  for (const [key, groupTabs] of buckets) {
    if (groupTabs.length < 2) continue;
    groups.push({
      key,
      domain: groupTabs[0].domain,
      title: groupTabs.find((t) => t.title?.trim())?.title,
      tabs: groupTabs,
      count: groupTabs.length,
    });
  }
  return groups;
}

export function computeCleanupSummary(tabs: Tab[]): CleanupSummary {
  const duplicates = tabs.filter((t) => t.isDuplicate).length;
  const needsReview = tabs.filter(
    (t) => (t.confidence ?? 0) < NEEDS_REVIEW_CONFIDENCE
  ).length;
  return {
    total: tabs.length,
    unique: tabs.length - duplicates,
    duplicates,
    needsReview,
    groupCount: findDuplicateGroups(tabs).length,
  };
}

export function defaultSelection(groups: DuplicateGroup[]): CleanupSelection {
  const keepIds: Record<string, string> = {};
  for (const group of groups) keepIds[group.key] = group.tabs[0].id;
  return { keepIds, skippedKeys: [] };
}

export function removalIds(
  groups: DuplicateGroup[],
  selection: CleanupSelection
): string[] {
  const skipped = new Set(selection.skippedKeys);
  const ids: string[] = [];
  for (const group of groups) {
    if (skipped.has(group.key)) continue;
    const keepId = selection.keepIds[group.key] ?? group.tabs[0].id;
    for (const tab of group.tabs) {
      if (tab.id !== keepId) ids.push(tab.id);
    }
  }
  return ids;
}

export function removeTabs(tabs: Tab[], ids: string[]): Tab[] {
  if (ids.length === 0) return tabs;
  const removing = new Set(ids);
  return markDuplicates(tabs.filter((t) => !removing.has(t.id)));
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/workspace/cleanup.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add cleanup pure logic (duplicate grouping, summary, selection, removal)"
```

---

### Task 2: Toast setup

**Files:**
- Modify: `src/components/ui/sonner.tsx` (drop `next-themes`, hardcode dark)
- Modify: `src/app/layout.tsx` (mount `<Toaster />`)

**Interfaces:**
- Produces: a mounted `<Toaster />` so `toast.success(...)` works anywhere — consumed by `WorkspaceView` (Task 4).

- [ ] **Step 1: Simplify `sonner.tsx`**

Replace the `useTheme()` call with a hardcoded `theme="dark"` and drop the `next-themes` import (this app forces the `dark` class on `<html>` and ships no theme switcher, so a theme provider would be dead weight). Keep the icon set and the CSS-variable style block exactly as generated so the toast inherits our design tokens.

- [ ] **Step 2: Mount the Toaster in the root layout**

In `src/app/layout.tsx`, import `{ Toaster }` from `@/components/ui/sonner` and render `<Toaster position="bottom-right" />` as the last child of `<body>`.

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: mount sonner toaster, pinned to the app's dark theme"
```

---

### Task 3: CleanupDialog (two-stage: summary → review)

**Files:**
- Create: `src/components/workspace/cleanup-dialog.tsx`

**Interfaces:**
- Consumes: `findDuplicateGroups`, `computeCleanupSummary`, `defaultSelection`, `removalIds` (Task 1); `Dialog*`, `AlertDialog*`, `Checkbox`, `ScrollArea`, `Button` (existing).
- Produces: `<CleanupDialog open onOpenChange tabs onRemove />` where `onRemove(ids: string[])` is called only after confirmation — consumed by `WorkspaceView` (Task 4).

- [ ] **Step 1: Implement**

```tsx
// src/components/workspace/cleanup-dialog.tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { Button } from "@/components/ui/button"
import { Checkbox } from "@/components/ui/checkbox"
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import {
  computeCleanupSummary,
  defaultSelection,
  findDuplicateGroups,
  removalIds,
} from "@/lib/workspace/cleanup"
import type { CleanupSelection } from "@/lib/workspace/cleanup"
import type { Tab } from "@/lib/tabs/types"

function plural(n: number, word: string) {
  return `${n} ${word}${n === 1 ? "" : "s"}`
}

export function CleanupDialog({
  open,
  onOpenChange,
  tabs,
  onRemove,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  tabs: Tab[]
  onRemove: (ids: string[]) => void
}) {
  const [stage, setStage] = useState<"summary" | "review">("summary")
  const [confirmOpen, setConfirmOpen] = useState(false)

  const groups = useMemo(() => findDuplicateGroups(tabs), [tabs])
  const summary = useMemo(() => computeCleanupSummary(tabs), [tabs])
  const [selection, setSelection] = useState<CleanupSelection>(() =>
    defaultSelection(groups)
  )

  useEffect(() => {
    if (open) {
      setStage("summary")
      setSelection(defaultSelection(groups))
    }
  }, [open, groups])

  const toRemove = removalIds(groups, selection)

  function keepCopy(groupKey: string, tabId: string) {
    setSelection((s) => ({ ...s, keepIds: { ...s.keepIds, [groupKey]: tabId } }))
  }

  function toggleGroup(groupKey: string, skip: boolean) {
    setSelection((s) => ({
      ...s,
      skippedKeys: skip
        ? [...s.skippedKeys, groupKey]
        : s.skippedKeys.filter((k) => k !== groupKey),
    }))
  }

  const stats = [
    { label: "tabs", value: summary.total },
    { label: "unique", value: summary.unique },
    { label: "duplicates", value: summary.duplicates },
    { label: "need review", value: summary.needsReview },
  ]

  return (
    <>
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent className="max-h-[85vh] w-full sm:max-w-lg">
          <DialogHeader>
            <DialogTitle>
              {summary.groupCount === 0
                ? "Nothing to clean up."
                : "Your workspace can be cleaned up."}
            </DialogTitle>
            <DialogDescription>
              {summary.groupCount === 0
                ? "No duplicate tabs found in this workspace."
                : `${plural(summary.groupCount, "duplicate group")} found. Nothing is removed until you confirm.`}
            </DialogDescription>
          </DialogHeader>

          {stage === "summary" ? (
            <div className="grid grid-cols-2 gap-4 py-2 sm:grid-cols-4">
              {stats.map((stat) => (
                <div key={stat.label}>
                  <p className="text-2xl font-semibold tracking-tight text-foreground">
                    {stat.value}
                  </p>
                  <p className="text-xs text-tertiary">{stat.label}</p>
                </div>
              ))}
            </div>
          ) : (
            <ScrollArea className="max-h-[45vh] pr-2">
              <div className="space-y-3">
                {groups.map((group) => {
                  const skipped = selection.skippedKeys.includes(group.key)
                  return (
                    <div
                      key={group.key}
                      className="rounded-lg border border-subtle bg-card p-3"
                    >
                      <div className="flex items-start gap-3">
                        <TabFavicon domain={group.domain} />
                        <div className="min-w-0 flex-1">
                          <p className="truncate text-sm font-medium text-foreground">
                            {group.title?.trim() || group.domain}
                          </p>
                          <p className="truncate text-xs text-tertiary">
                            {group.key}
                          </p>
                          <p className="mt-0.5 text-xs text-muted-foreground">
                            {plural(group.count, "copy").replace("copys", "copies")}
                          </p>
                        </div>
                        <label className="flex shrink-0 items-center gap-1.5 text-xs text-muted-foreground">
                          <Checkbox
                            checked={skipped}
                            onCheckedChange={(v) => toggleGroup(group.key, v === true)}
                          />
                          Keep all
                        </label>
                      </div>

                      <ul className="mt-2 space-y-1 border-t border-subtle pt-2">
                        {group.tabs.map((tab) => {
                          const kept = selection.keepIds[group.key] === tab.id
                          return (
                            <li key={tab.id} className="flex items-center gap-2">
                              <button
                                type="button"
                                disabled={skipped}
                                onClick={() => keepCopy(group.key, tab.id)}
                                className={
                                  "shrink-0 rounded-md border px-1.5 py-0.5 text-[0.65rem] font-medium transition-colors disabled:opacity-50 " +
                                  (kept || skipped
                                    ? "border-primary/30 bg-primary/15 text-primary"
                                    : "border-subtle text-tertiary hover:text-foreground")
                                }
                              >
                                {kept || skipped ? "Keep" : "Remove"}
                              </button>
                              <span className="truncate text-xs text-muted-foreground">
                                {tab.url}
                              </span>
                            </li>
                          )
                        })}
                      </ul>
                    </div>
                  )
                })}
              </div>
            </ScrollArea>
          )}

          <DialogFooter>
            {stage === "summary" ? (
              <>
                <Button variant="ghost" onClick={() => onOpenChange(false)}>
                  Keep all
                </Button>
                <Button
                  disabled={summary.groupCount === 0}
                  onClick={() => setStage("review")}
                >
                  Review manually
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={() => setStage("summary")}>
                  Back
                </Button>
                <Button
                  disabled={toRemove.length === 0}
                  onClick={() => setConfirmOpen(true)}
                >
                  Remove selected ({toRemove.length})
                </Button>
              </>
            )}
          </DialogFooter>
        </DialogContent>
      </Dialog>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              Remove {plural(toRemove.length, "duplicate tab")}?
            </AlertDialogTitle>
            <AlertDialogDescription>
              One copy of each duplicate stays in your workspace. This can&apos;t
              be undone.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                setConfirmOpen(false)
                onOpenChange(false)
                onRemove(toRemove)
              }}
            >
              Remove
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  )
}
```

(Note: the closing tags above must be `</AlertDialogFooter>` then `</AlertDialogContent>` — fix any stray nesting when transcribing, and let `tsc` confirm.)

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add two-stage CleanupDialog (summary -> review) with confirmed removal"
```

---

### Task 4: Wire cleanup into the workspace (replacing the destructive button)

**Files:**
- Modify: `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- Consumes: `CleanupDialog` (Task 3), `removeTabs` (Task 1), `toast` from `sonner`.
- Produces: the finished Phase 6 cleanup flow.

- [ ] **Step 1: Replace `handleCleanup`**

In `WorkspaceView`, add `const [cleanupOpen, setCleanupOpen] = useState(false)`. Change the header's `onCleanup` to `() => setCleanupOpen(true)` (it must no longer delete anything directly). Add:

```tsx
  function handleRemoveDuplicates(ids: string[]) {
    if (ids.length === 0) return
    const remaining = removeTabs(tabs, ids)
    onTabsChange(remaining)
    toast.success(
      `Removed ${ids.length} duplicate tab${ids.length === 1 ? "" : "s"}.`,
      { description: `${remaining.length} tab${remaining.length === 1 ? "" : "s"} remain.` }
    )
  }
```

and render `<CleanupDialog open={cleanupOpen} onOpenChange={setCleanupOpen} tabs={tabs} onRemove={handleRemoveDuplicates} />` inside the root `<div>`.

- [ ] **Step 2: Typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: replace instant-delete Cleanup with the reviewed cleanup flow"
```

---

### Task 5: Interaction tests and QA

**Files:**
- Create: `src/components/workspace/cleanup-dialog.test.tsx`
- Modify: any file, only as needed to fix issues found.

**Interfaces:**
- None new — verifies Tasks 1–4 against the spec's QA list.

- [ ] **Step 1: Write interaction tests covering the QA matrix**

Cover, with Testing Library + `userEvent`: no duplicates (summary says nothing to clean up, "Review manually" disabled); 2 duplicates; many duplicates; tracking-parameter duplicates grouped together; removal only reachable via review; cancelling the confirmation removes nothing; confirming calls `onRemove` with exactly the non-kept ids; "Keep all" closes without removing; per-group opt-out excludes that group.

- [ ] **Step 2: Run the tests**

```bash
npx vitest run src/components/workspace/cleanup-dialog.test.tsx
```

Expected: all PASS.

- [ ] **Step 3: Full automated checks**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all succeed with zero errors.

- [ ] **Step 4: Browser QA**

Dump a set containing exact duplicates, a tracking-parameter duplicate, and unique tabs. Verify: the Cleanup button opens the dialog (and does **not** delete); summary numbers match the workspace; Review manually lists the groups with copy counts and a Keep marker; Remove selected prompts for confirmation; cancelling changes nothing; confirming removes the right tabs, updates the overview counts, and shows the toast with the exact copy. Then reload the page and confirm the app returns cleanly to the landing view (no persistence exists by design).

- [ ] **Step 5: Fix anything found, then commit**

```bash
git add -A
git commit -m "test: cleanup interaction tests; Phase 6 QA polish"
```

- [ ] **Step 6: Report completion**

Report in the format the user specified, then stop.
