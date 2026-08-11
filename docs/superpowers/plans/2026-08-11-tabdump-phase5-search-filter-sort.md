# TabDump Phase 5: Search, Filtering & Sorting Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add global search (title/domain/url/category, Cmd/Ctrl+K), category filter pills with counts, and a compact sort control to the workspace, unified into one filtered/sorted results list that replaces the category grid only while search/filter/sort is active.

**Architecture:** `src/lib/workspace/search.ts` holds pure, unit-tested `matchesQuery`/`filterTabs`/`sortTabs`/`categoryCounts`. `WorkspaceView` owns `query`/`categoryFilter`/`sortKey`/`highlightedIndex` state, derives `resultTabs` via `useMemo`, and renders `CategoryGrid` when idle or `FilteredTabList` when any of the three inputs is non-default. `SearchBar`, `CategoryFilterBar`, and `SortControl` are new presentational components; `FilteredTabList` reuses the existing `TabCard`.

**Tech Stack:** TypeScript, React 19, existing shadcn `DropdownMenu`/`Input`/`Button` primitives, Vitest.

## Global Constraints

- Default view (no query, filter = "All", sort = "Recently added") is the existing, unchanged `CategoryGrid` — the dashboard is not redesigned.
- Search matches `title`, `domain`, `url`, and the category's display name, case-insensitive substring.
- `Cmd/Ctrl+K` focuses search globally; `Escape` (while search focused) clears and blurs; `ArrowUp`/`ArrowDown` (while search focused, results showing) move a highlighted index; `Enter` (while search focused) opens the highlighted result when at least one result exists. No other shortcuts.
- Filter pills: `All` + 8 categories, each showing a live count, single wrapping row, no dedicated "giant" styling — same radius/border language as the rest of the app (not `rounded-full`).
- Sort options: Recently added (original array order), Title, Domain, Category — compact control, not a redesign of the header.
- Empty state when a search/filter/sort combination yields zero tabs: exactly `No tabs found.` / `Try a different search.`
- Filtering/sorting must stay fast at 500 tabs — memoize via `useMemo` keyed on `[tabs, query, categoryFilter, sortKey]`.

---

### Task 1: Search/filter/sort pure logic

**Files:**
- Create: `src/lib/workspace/search.ts`
- Test: `src/lib/workspace/search.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES`, `CategoryId` (existing), `Tab` (existing), `groupByCategory` (existing, from `stats.ts`).
- Produces: `type SortKey = "recent" | "title" | "domain" | "category"`, `matchesQuery(tab: Tab, query: string): boolean`, `filterTabs(tabs: Tab[], opts: { query: string; categoryId: CategoryId | "all" }): Tab[]`, `sortTabs(tabs: Tab[], sortKey: SortKey): Tab[]`, `categoryCounts(tabs: Tab[]): Record<CategoryId, number>` — consumed by `WorkspaceView` (Task 6) and `CategoryFilterBar` (Task 3).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/search.test.ts
import { describe, expect, it } from "vitest";
import {
  matchesQuery,
  filterTabs,
  sortTabs,
  categoryCounts,
} from "./search";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("matchesQuery", () => {
  it("matches on title", () => {
    const tab = makeTab({ title: "My Great Article" });
    expect(matchesQuery(tab, "great")).toBe(true);
  });

  it("matches on domain", () => {
    const tab = makeTab({ domain: "github.com" });
    expect(matchesQuery(tab, "GITHUB")).toBe(true);
  });

  it("matches on url", () => {
    const tab = makeTab({ url: "https://example.com/deep/path" });
    expect(matchesQuery(tab, "deep/path")).toBe(true);
  });

  it("matches on category display name", () => {
    const tab = makeTab({ category: "research" });
    expect(matchesQuery(tab, "resea")).toBe(true);
  });

  it("returns false when nothing matches", () => {
    const tab = makeTab({ title: "Foo", domain: "bar.com" });
    expect(matchesQuery(tab, "zzz")).toBe(false);
  });

  it("treats an empty query as matching everything", () => {
    expect(matchesQuery(makeTab({}), "")).toBe(true);
  });
});

describe("filterTabs", () => {
  const tabs = [
    makeTab({ id: "1", domain: "github.com", category: "projects" }),
    makeTab({ id: "2", domain: "arxiv.org", category: "research" }),
    makeTab({ id: "3", domain: "github.io", category: "projects" }),
  ];

  it("filters by query only", () => {
    expect(filterTabs(tabs, { query: "github", categoryId: "all" })).toHaveLength(2);
  });

  it("filters by category only", () => {
    expect(filterTabs(tabs, { query: "", categoryId: "research" })).toEqual([tabs[1]]);
  });

  it("combines query and category", () => {
    expect(
      filterTabs(tabs, { query: "github", categoryId: "projects" })
    ).toHaveLength(2);
    expect(
      filterTabs(tabs, { query: "arxiv", categoryId: "projects" })
    ).toHaveLength(0);
  });

  it("returns everything for an empty query and 'all' category", () => {
    expect(filterTabs(tabs, { query: "", categoryId: "all" })).toHaveLength(3);
  });
});

describe("sortTabs", () => {
  const tabs = [
    makeTab({ id: "1", domain: "zebra.com", title: "Zeta", category: "shopping" }),
    makeTab({ id: "2", domain: "alpha.com", title: "Alpha", category: "research" }),
    makeTab({ id: "3", domain: "middle.com", category: "projects" }), // no title -> falls back to domain
  ];

  it("'recent' preserves original order", () => {
    expect(sortTabs(tabs, "recent").map((t) => t.id)).toEqual(["1", "2", "3"]);
  });

  it("sorts by title (falling back to domain when title is absent)", () => {
    expect(sortTabs(tabs, "title").map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts by domain", () => {
    expect(sortTabs(tabs, "domain").map((t) => t.id)).toEqual(["2", "3", "1"]);
  });

  it("sorts by category display name", () => {
    // Projects, Research, Shopping
    expect(sortTabs(tabs, "category").map((t) => t.id)).toEqual(["3", "2", "1"]);
  });

  it("does not mutate the input array", () => {
    const copy = [...tabs];
    sortTabs(tabs, "title");
    expect(tabs).toEqual(copy);
  });
});

describe("categoryCounts", () => {
  it("counts tabs per category, including zero for unused ones", () => {
    const tabs = [
      makeTab({ id: "1", category: "projects" }),
      makeTab({ id: "2", category: "projects" }),
    ];
    const counts = categoryCounts(tabs);
    expect(counts.projects).toBe(2);
    expect(counts.research).toBe(0);
    expect(Object.keys(counts)).toHaveLength(8);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/search.test.ts
```

Expected: FAIL — `search.ts` does not exist.

- [ ] **Step 3: Implement `search.ts`**

```ts
// src/lib/workspace/search.ts
import { CATEGORIES } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";
import { groupByCategory } from "./stats";

export type SortKey = "recent" | "title" | "domain" | "category";

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other";
}

function categoryName(tab: Tab): string {
  return CATEGORIES[categoryOf(tab)].name;
}

export function matchesQuery(tab: Tab, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return (
    (tab.title ?? "").toLowerCase().includes(q) ||
    tab.domain.toLowerCase().includes(q) ||
    tab.url.toLowerCase().includes(q) ||
    categoryName(tab).toLowerCase().includes(q)
  );
}

export function filterTabs(
  tabs: Tab[],
  opts: { query: string; categoryId: CategoryId | "all" }
): Tab[] {
  return tabs.filter(
    (tab) =>
      matchesQuery(tab, opts.query) &&
      (opts.categoryId === "all" || categoryOf(tab) === opts.categoryId)
  );
}

function titleOrDomain(tab: Tab): string {
  return (tab.title?.trim() || tab.domain).toLowerCase();
}

export function sortTabs(tabs: Tab[], sortKey: SortKey): Tab[] {
  if (sortKey === "recent") return tabs;

  const sorted = [...tabs];
  switch (sortKey) {
    case "title":
      sorted.sort((a, b) => titleOrDomain(a).localeCompare(titleOrDomain(b)));
      break;
    case "domain":
      sorted.sort((a, b) => a.domain.toLowerCase().localeCompare(b.domain.toLowerCase()));
      break;
    case "category":
      sorted.sort((a, b) => {
        const byName = categoryName(a).localeCompare(categoryName(b));
        return byName !== 0 ? byName : a.domain.localeCompare(b.domain);
      });
      break;
  }
  return sorted;
}

export function categoryCounts(tabs: Tab[]): Record<CategoryId, number> {
  const groups = groupByCategory(tabs);
  const counts = {} as Record<CategoryId, number>;
  for (const id of Object.keys(groups) as CategoryId[]) {
    counts[id] = groups[id].length;
  }
  return counts;
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/workspace/search.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Add the 500-tab performance test**

Append to `src/lib/workspace/search.test.ts`:

```ts
describe("performance", () => {
  it("filters and sorts 500 tabs quickly", () => {
    const categories = ["research", "school", "projects", "shopping", "creative", "news", "read-later", "other"] as const;
    const tabs = Array.from({ length: 500 }, (_, i) => ({
      id: String(i),
      url: `https://example${i}.com/page`,
      normalizedUrl: `https://example${i}.com/page`,
      domain: `example${i}.com`,
      category: categories[i % categories.length],
      title: `Page ${i}`,
    }));

    const start = performance.now();
    const filtered = filterTabs(tabs, { query: "page", categoryId: "all" });
    const sorted = sortTabs(filtered, "title");
    const elapsed = performance.now() - start;

    expect(sorted).toHaveLength(500);
    expect(elapsed).toBeLessThan(200);
  });
});
```

- [ ] **Step 6: Run the whole file and confirm everything passes**

```bash
npx vitest run src/lib/workspace/search.test.ts
```

Expected: all tests PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add search/filter/sort pure logic (matchesQuery, filterTabs, sortTabs, categoryCounts)"
```

---

### Task 2: SearchBar component (always-mounted, keyboard-aware)

**Files:**
- Create: `src/components/workspace/search-bar.tsx`
- Modify: `src/components/workspace/workspace-header.tsx` (replace the toggle-based search with `SearchBar`)

**Interfaces:**
- Produces: `<SearchBar value onChange onArrowDown onArrowUp onEnter />`, rendered with a fixed `id="workspace-search-input"` so Task 6's global shortcut can focus it without ref plumbing.

- [ ] **Step 1: Implement `SearchBar`**

```tsx
// src/components/workspace/search-bar.tsx
"use client"

import { Search, X } from "lucide-react"
import { Input } from "@/components/ui/input"
import { IconButton } from "@/components/ui/icon-button"

export function SearchBar({
  value,
  onChange,
  onArrowDown,
  onArrowUp,
  onEnter,
}: {
  value: string
  onChange: (value: string) => void
  onArrowDown?: () => void
  onArrowUp?: () => void
  onEnter?: () => void
}) {
  return (
    <div className="relative w-40 sm:w-64">
      <Search className="pointer-events-none absolute top-1/2 left-2 size-3.5 -translate-y-1/2 text-tertiary" />
      <Input
        id="workspace-search-input"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Search tabs..."
        className="h-8 pl-7"
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            onChange("")
            e.currentTarget.blur()
          } else if (e.key === "ArrowDown") {
            e.preventDefault()
            onArrowDown?.()
          } else if (e.key === "ArrowUp") {
            e.preventDefault()
            onArrowUp?.()
          } else if (e.key === "Enter") {
            e.preventDefault()
            onEnter?.()
          }
        }}
      />
      {value && (
        <IconButton
          aria-label="Clear search"
          className="absolute top-1/2 right-1 size-6 -translate-y-1/2"
          onClick={() => onChange("")}
        >
          <X className="size-3.5" />
        </IconButton>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Replace the toggle-based search in `WorkspaceHeader`**

Remove the `searchOpen` state and the conditional `Input`/toggle `Button` for search; replace with an always-rendered `<SearchBar value={searchValue} onChange={onSearch} onArrowDown={onArrowDown} onArrowUp={onArrowUp} onEnter={onEnter} />`. `WorkspaceHeader` gains `searchValue`, `onArrowDown`, `onArrowUp`, `onEnter` props (passed straight through from `WorkspaceView`, wired in Task 6) alongside its existing `onSearch`, `onCleanup`, `onExport`, `onClear`.

```tsx
// src/components/workspace/workspace-header.tsx (full file)
"use client"

import { useState } from "react"
import { Sparkles, Download, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { SearchBar } from "@/components/workspace/search-bar"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"

export function WorkspaceHeader({
  tabCount,
  searchValue,
  onSearch,
  onSearchArrowDown,
  onSearchArrowUp,
  onSearchEnter,
  onCleanup,
  onExport,
  onClear,
}: {
  tabCount: number
  searchValue: string
  onSearch: (query: string) => void
  onSearchArrowDown: () => void
  onSearchArrowUp: () => void
  onSearchEnter: () => void
  onCleanup: () => void
  onExport: () => void
  onClear: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
        <div className="mr-auto">
          <p className="text-sm font-semibold tracking-tight text-foreground">TabDump</p>
          <p className="text-xs text-tertiary">
            {tabCount} tab{tabCount === 1 ? "" : "s"}
          </p>
        </div>

        <SearchBar
          value={searchValue}
          onChange={onSearch}
          onArrowDown={onSearchArrowDown}
          onArrowUp={onSearchArrowUp}
          onEnter={onSearchEnter}
        />
        <Button variant="ghost" size="sm" onClick={onCleanup}>
          <Sparkles /> Cleanup
        </Button>
        <Button variant="ghost" size="sm" onClick={onExport}>
          <Download /> Export
        </Button>
        <Button variant="ghost" size="sm" onClick={() => setConfirmOpen(true)}>
          <Trash2 /> Clear
        </Button>
      </div>

      <ClearWorkspaceDialog
        open={confirmOpen}
        onOpenChange={setConfirmOpen}
        onConfirm={() => {
          setConfirmOpen(false)
          onClear()
        }}
      />
    </header>
  )
}
```

- [ ] **Step 3: Typecheck**

```bash
npx tsc --noEmit
```

Expected: errors at this point are limited to `WorkspaceView` not yet passing the new props — expected until Task 6. If this task is implemented standalone, temporarily stub the new props in `WorkspaceView` with no-ops to keep the build green, then let Task 6 replace the stubs.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: replace toggle search with always-mounted, keyboard-aware SearchBar"
```

---

### Task 3: CategoryFilterBar component

**Files:**
- Create: `src/components/workspace/category-filter-bar.tsx`

**Interfaces:**
- Consumes: `categoryCounts` (Task 1), `CATEGORIES`/`CATEGORY_ORDER` (existing).
- Produces: `<CategoryFilterBar tabs={Tab[]} value={CategoryId | "all"} onChange={(v) => void} />` — consumed by `WorkspaceView` (Task 6).

- [ ] **Step 1: Implement**

```tsx
// src/components/workspace/category-filter-bar.tsx
import { cn } from "@/lib/utils"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { categoryCounts } from "@/lib/workspace/search"

function Pill({
  active,
  onClick,
  children,
}: {
  active: boolean
  onClick: () => void
  children: React.ReactNode
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "rounded-md border px-2.5 py-1 text-xs font-medium transition-colors",
        active
          ? "border-primary/30 bg-primary/15 text-primary"
          : "border-subtle bg-card text-muted-foreground hover:border-border hover:text-foreground"
      )}
    >
      {children}
    </button>
  )
}

export function CategoryFilterBar({
  tabs,
  value,
  onChange,
}: {
  tabs: Tab[]
  value: CategoryId | "all"
  onChange: (value: CategoryId | "all") => void
}) {
  const counts = categoryCounts(tabs)

  return (
    <div className="flex flex-wrap gap-2">
      <Pill active={value === "all"} onClick={() => onChange("all")}>
        All ({tabs.length})
      </Pill>
      {CATEGORY_ORDER.map((id) => (
        <Pill key={id} active={value === id} onClick={() => onChange(id)}>
          {CATEGORIES[id].name} ({counts[id]})
        </Pill>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add CategoryFilterBar with live per-category counts"
```

---

### Task 4: SortControl component

**Files:**
- Create: `src/components/workspace/sort-control.tsx`

**Interfaces:**
- Consumes: `SortKey` (Task 1), `DropdownMenu*` (existing).
- Produces: `<SortControl value={SortKey} onChange={(v) => void} />` — consumed by `WorkspaceView` (Task 6).

- [ ] **Step 1: Implement**

```tsx
// src/components/workspace/sort-control.tsx
"use client"

import { ArrowUpDown } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import type { SortKey } from "@/lib/workspace/search"

const LABELS: Record<SortKey, string> = {
  recent: "Recently added",
  title: "Title",
  domain: "Domain",
  category: "Category",
}

const ORDER: SortKey[] = ["recent", "title", "domain", "category"]

export function SortControl({
  value,
  onChange,
}: {
  value: SortKey
  onChange: (value: SortKey) => void
}) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger
        render={
          <Button variant="outline" size="sm">
            <ArrowUpDown className="size-3.5" />
            {LABELS[value]}
          </Button>
        }
      />
      <DropdownMenuContent align="end">
        {ORDER.map((key) => (
          <DropdownMenuItem key={key} onClick={() => onChange(key)}>
            {LABELS[key]}
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

(This mirrors `TabCard`'s existing `DropdownMenuTrigger render={<Button .../>}` pattern — `Button` is already a native `<button>`, so no `nativeButton={false}` override is needed here, unlike the `Badge`-based trigger in `TabCard`.)

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add compact SortControl (recently added / title / domain / category)"
```

---

### Task 5: FilteredTabList component (results list + empty state + keyboard highlight)

**Files:**
- Create: `src/components/workspace/filtered-tab-list.tsx`

**Interfaces:**
- Consumes: `TabCard` (existing).
- Produces: `<FilteredTabList tabs={Tab[]} highlightedIndex={number} onCategoryChange={...} />` — consumed by `WorkspaceView` (Task 6).

- [ ] **Step 1: Implement**

```tsx
// src/components/workspace/filtered-tab-list.tsx
import { cn } from "@/lib/utils"
import { TabCard } from "@/components/workspace/tab-card"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function FilteredTabList({
  tabs,
  highlightedIndex,
  onCategoryChange,
}: {
  tabs: Tab[]
  highlightedIndex: number
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  if (tabs.length === 0) {
    return (
      <div className="flex flex-col items-center gap-1 py-16 text-center">
        <p className="text-sm font-medium text-foreground">No tabs found.</p>
        <p className="text-xs text-tertiary">Try a different search.</p>
      </div>
    )
  }

  return (
    <div className="space-y-2">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={cn(
            "rounded-lg",
            index === highlightedIndex && "ring-2 ring-primary/50"
          )}
        >
          <TabCard tab={tab} onCategoryChange={onCategoryChange} />
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add FilteredTabList with spec-exact empty state and keyboard highlight"
```

---

### Task 6: Wire search/filter/sort into WorkspaceView, including Cmd/Ctrl+K

**Files:**
- Modify: `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- Consumes: `filterTabs`, `sortTabs`, `SortKey` (Task 1), `SearchBar` via `WorkspaceHeader` (Task 2), `CategoryFilterBar` (Task 3), `SortControl` (Task 4), `FilteredTabList` (Task 5).
- Produces: the complete Phase 5 `WorkspaceView` — no further consumers.

- [ ] **Step 1: Implement the full file**

```tsx
// src/components/workspace/workspace-view.tsx
"use client"

import { useEffect, useMemo, useState } from "react"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { WorkspaceOverview } from "@/components/workspace/workspace-overview"
import { CategoryGrid } from "@/components/workspace/category-grid"
import { CategoryFilterBar } from "@/components/workspace/category-filter-bar"
import { SortControl } from "@/components/workspace/sort-control"
import { FilteredTabList } from "@/components/workspace/filtered-tab-list"
import { filterTabs, sortTabs } from "@/lib/workspace/search"
import type { SortKey } from "@/lib/workspace/search"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

export function WorkspaceView({
  tabs,
  onTabsChange,
  onClear,
}: {
  tabs: Tab[]
  onTabsChange: (tabs: Tab[]) => void
  onClear: () => void
}) {
  const [query, setQuery] = useState("")
  const [categoryFilter, setCategoryFilter] = useState<CategoryId | "all">("all")
  const [sortKey, setSortKey] = useState<SortKey>("recent")
  const [highlightedIndex, setHighlightedIndex] = useState(0)

  const isBrowsing = query.trim() === "" && categoryFilter === "all" && sortKey === "recent"

  const resultTabs = useMemo(
    () => sortTabs(filterTabs(tabs, { query, categoryId: categoryFilter }), sortKey),
    [tabs, query, categoryFilter, sortKey]
  )

  useEffect(() => {
    setHighlightedIndex(0)
  }, [query, categoryFilter, sortKey])

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
        e.preventDefault()
        document.getElementById("workspace-search-input")?.focus()
      }
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [])

  function handleCategoryChange(id: string, category: CategoryId) {
    onTabsChange(tabs.map((t) => (t.id === id ? { ...t, category } : t)))
  }

  function handleCleanup() {
    onTabsChange(tabs.filter((t) => !t.isDuplicate))
  }

  function handleExport() {
    const text = tabs.map((t) => t.url).join("\n")
    navigator.clipboard?.writeText(text)
  }

  return (
    <div className="min-h-screen">
      <WorkspaceHeader
        tabCount={tabs.length}
        searchValue={query}
        onSearch={setQuery}
        onSearchArrowDown={() =>
          setHighlightedIndex((i) => Math.min(i + 1, resultTabs.length - 1))
        }
        onSearchArrowUp={() => setHighlightedIndex((i) => Math.max(i - 1, 0))}
        onSearchEnter={() => {
          const target = resultTabs[highlightedIndex]
          if (target) openTab(target.url)
        }}
        onCleanup={handleCleanup}
        onExport={handleExport}
        onClear={onClear}
      />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <WorkspaceOverview tabs={tabs} />

        <div className="mt-8 flex flex-wrap items-center justify-between gap-3">
          <CategoryFilterBar tabs={tabs} value={categoryFilter} onChange={setCategoryFilter} />
          <SortControl value={sortKey} onChange={setSortKey} />
        </div>

        <div className="mt-6">
          {isBrowsing ? (
            <CategoryGrid tabs={tabs} onCategoryChange={handleCategoryChange} />
          ) : (
            <FilteredTabList
              tabs={resultTabs}
              highlightedIndex={highlightedIndex}
              onCategoryChange={handleCategoryChange}
            />
          )}
        </div>
      </main>
    </div>
  )
}
```

Note: `CategoryGrid` now always receives the unfiltered `tabs` (Phase 4 had it receiving a search-filtered `visibleTabs`; that responsibility moves to `FilteredTabList` so the grid stays the untouched default view described in the design doc).

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: wire search/filter/sort into WorkspaceView with Cmd/Ctrl+K and keyboard navigation"
```

---

### Task 7: QA — search, filter, combined, sort, clear, keyboard, mobile

**Files:**
- Modify: any file, only as needed to fix issues found.

**Interfaces:**
- None new — verifies Tasks 1–6 together.

- [ ] **Step 1: Functional checks in the browser**

Dump a realistic mixed set of ~15-20 tabs across several categories. Verify, fixing anything found before moving on:
- Search alone: typing a domain fragment narrows to matching tabs; typing a category name (e.g. "research") also matches; clearing the query (×  button or deleting text) returns to the grid.
- Filter alone: clicking a category pill shows only that category's tabs as a flat list with a correct count; clicking "All" returns to the grid.
- Combined search + filter: a query plus a category pill narrows to the intersection.
- Sorting: each of the 4 sort options visibly reorders the results list correctly; switching sort back to "Recently added" while query/filter are still active keeps the list (not the grid) but in original order.
- Empty state: search for a nonsense string, confirm the exact copy `No tabs found.` / `Try a different search.` appears.
- `Cmd/Ctrl+K` from anywhere on the page focuses the search input (test with focus elsewhere, e.g. a tab card).
- `Escape` while search is focused with text clears it and returns to the grid.
- `ArrowDown`/`ArrowUp` while search is focused (with results showing) move the highlighted ring between result rows; `Enter` opens the highlighted tab in a new tab.

- [ ] **Step 2: Mobile check**

At 375px: filter pills wrap onto multiple lines without overflow, the sort control and search bar don't collide with header actions, results list and empty state render correctly, no horizontal scroll anywhere.

- [ ] **Step 3: Run full automated checks**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all succeed with zero errors.

- [ ] **Step 4: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: Phase 5 search/filter/sort QA polish"
```

(Skip the commit if nothing needed changing.)

- [ ] **Step 5: Report completion**

Summarize search, filters, sorting, keyboard UX, performance, tests, and fixes in the `PHASE 5 COMPLETE` format specified by the user.
