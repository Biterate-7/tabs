# TabDump Phase 4: Workspace Dashboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the workspace dashboard on real `parseTabInput` output: landing → paste → workspace, with an overview strip, a category grid, tab cards with graceful metadata fallbacks, category expansion, manual category reassignment, search, cleanup, export, and a confirmed clear action.

**Architecture:** `src/app/page.tsx` stays a server component wrapping a new client `AppShell` that holds `workspaceTabs: Tab[] | null` — `null` shows the existing landing view, non-null shows `WorkspaceView`. Pure data-shaping lives in `src/lib/workspace/` (stats, favicon fallback), unit-tested. Everything visual lives in `src/components/workspace/`, composed from existing design tokens and the shadcn primitives already installed (Sheet, DropdownMenu, AlertDialog, Avatar).

**Tech Stack:** TypeScript, React 19, Next.js App Router, shadcn/ui (Sheet, DropdownMenu, AlertDialog, Avatar, ScrollArea, Separator — all added this phase), lucide-react, Vitest.

## Global Constraints

- No new route/persistence: `/` renders either the landing view or the workspace view from client state, per the design doc's YAGNI call.
- Real data only: the workspace consumes `parseTabInput`'s actual `Tab[]` output (Phase 2/3), never fixture/sample data in the shipped UI.
- 8 category cards always render, including categories with 0 tabs (de-emphasized, no "View all").
- Tab titles are absent today — every `TabCard` shows domain as the primary line; this is the normal path, not a rare fallback.
- Favicons: try a real favicon (Google's public `s2/favicons` endpoint) via `AvatarImage`, fall back to a generated letter+color `AvatarFallback` derived from the domain — never a broken-image glyph.
- Category expansion = shadcn `Sheet`. Category reassignment = shadcn `DropdownMenu` (8 category items). Clear-workspace confirmation = shadcn `AlertDialog`. No custom modal implementations.
- Responsive: category grid `grid-cols-1 sm:grid-cols-2 lg:grid-cols-3`, overview `grid-cols-2 sm:grid-cols-4`, zero horizontal overflow at any tested width, Sheet full-width below `sm`.
- Open-tab action uses `window.open(url, "_blank", "noopener,noreferrer")`.
- No excessive cards/dense tables/sidebars — overview stats stay text-first, not KPI-card-heavy.

---

### Task 1: Workspace stats utilities

**Files:**
- Create: `src/lib/workspace/stats.ts`
- Test: `src/lib/workspace/stats.test.ts`

**Interfaces:**
- Consumes: `Tab`, `CategoryId`, `CATEGORY_ORDER` (existing).
- Produces: `computeOverview(tabs): { total, unique, categoriesInUse, duplicates }`, `groupByCategory(tabs): Record<CategoryId, Tab[]>`, `representativeDomains(tabs, limit = 3): string[]` — consumed by `WorkspaceOverview`, `CategoryGrid`, `CategoryCard`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/stats.test.ts
import { describe, expect, it } from "vitest";
import { computeOverview, groupByCategory, representativeDomains } from "./stats";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.url ?? "id",
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("computeOverview", () => {
  it("counts total, unique, categoriesInUse, and duplicates", () => {
    const tabs = [
      makeTab({ id: "1", category: "projects" }),
      makeTab({ id: "2", category: "projects", isDuplicate: true }),
      makeTab({ id: "3", category: "research" }),
    ];
    expect(computeOverview(tabs)).toEqual({
      total: 3,
      unique: 2,
      categoriesInUse: 2,
      duplicates: 1,
    });
  });

  it("handles an empty workspace", () => {
    expect(computeOverview([])).toEqual({
      total: 0,
      unique: 0,
      categoriesInUse: 0,
      duplicates: 0,
    });
  });
});

describe("groupByCategory", () => {
  it("buckets tabs under every one of the 8 categories, including empty ones", () => {
    const tabs = [makeTab({ id: "1", category: "projects" })];
    const groups = groupByCategory(tabs);
    expect(Object.keys(groups)).toHaveLength(8);
    expect(groups.projects).toHaveLength(1);
    expect(groups.research).toHaveLength(0);
  });

  it("falls back tabs with no category to other", () => {
    const tabs = [makeTab({ id: "1", category: undefined })];
    const groups = groupByCategory(tabs);
    expect(groups.other).toHaveLength(1);
  });
});

describe("representativeDomains", () => {
  it("returns up to `limit` unique domains, duplicates excluded first", () => {
    const tabs = [
      makeTab({ id: "1", domain: "a.com" }),
      makeTab({ id: "2", domain: "a.com", isDuplicate: true }),
      makeTab({ id: "3", domain: "b.com" }),
      makeTab({ id: "4", domain: "c.com" }),
      makeTab({ id: "5", domain: "d.com" }),
    ];
    expect(representativeDomains(tabs, 3)).toEqual(["a.com", "b.com", "c.com"]);
  });

  it("returns an empty array for no tabs", () => {
    expect(representativeDomains([], 3)).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/stats.test.ts
```

Expected: FAIL — `stats.ts` does not exist.

- [ ] **Step 3: Implement `stats.ts`**

```ts
// src/lib/workspace/stats.ts
import { CATEGORY_ORDER } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";

export type WorkspaceOverview = {
  total: number;
  unique: number;
  categoriesInUse: number;
  duplicates: number;
};

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other";
}

export function computeOverview(tabs: Tab[]): WorkspaceOverview {
  const duplicates = tabs.filter((t) => t.isDuplicate).length;
  const used = new Set(tabs.map(categoryOf));
  return {
    total: tabs.length,
    unique: tabs.length - duplicates,
    categoriesInUse: used.size,
    duplicates,
  };
}

export function groupByCategory(tabs: Tab[]): Record<CategoryId, Tab[]> {
  const groups = {} as Record<CategoryId, Tab[]>;
  for (const id of CATEGORY_ORDER) groups[id] = [];
  for (const tab of tabs) groups[categoryOf(tab)].push(tab);
  return groups;
}

export function representativeDomains(tabs: Tab[], limit = 3): string[] {
  const ordered = [...tabs].sort(
    (a, b) => Number(!!a.isDuplicate) - Number(!!b.isDuplicate)
  );
  const seen = new Set<string>();
  const result: string[] = [];
  for (const tab of ordered) {
    if (seen.has(tab.domain)) continue;
    seen.add(tab.domain);
    result.push(tab.domain);
    if (result.length >= limit) break;
  }
  return result;
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/workspace/stats.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add workspace stats utilities (overview, grouping, representative domains)"
```

---

### Task 2: Favicon fallback utilities

**Files:**
- Create: `src/lib/workspace/favicon.ts`
- Test: `src/lib/workspace/favicon.test.ts`

**Interfaces:**
- Produces: `faviconUrl(domain: string): string`, `avatarFallback(domain: string): { letter: string; colorVar: string }` — consumed by `TabFavicon`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/favicon.test.ts
import { describe, expect, it } from "vitest";
import { faviconUrl, avatarFallback } from "./favicon";

describe("faviconUrl", () => {
  it("builds a favicon-service URL for the domain", () => {
    expect(faviconUrl("github.com")).toBe(
      "https://www.google.com/s2/favicons?sz=64&domain=github.com"
    );
  });
});

describe("avatarFallback", () => {
  it("uses the first letter of the domain, uppercased", () => {
    expect(avatarFallback("github.com").letter).toBe("G");
    expect(avatarFallback("amazon.in").letter).toBe("A");
  });

  it("is deterministic for the same domain", () => {
    expect(avatarFallback("github.com")).toEqual(avatarFallback("github.com"));
  });

  it("picks a category accent CSS variable as the color", () => {
    const { colorVar } = avatarFallback("github.com");
    expect(colorVar.startsWith("--category-")).toBe(true);
  });

  it("handles an empty domain without throwing", () => {
    expect(() => avatarFallback("")).not.toThrow();
    expect(avatarFallback("").letter).toBe("?");
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/favicon.test.ts
```

Expected: FAIL — `favicon.ts` does not exist.

- [ ] **Step 3: Implement `favicon.ts`**

```ts
// src/lib/workspace/favicon.ts
const PALETTE = [
  "--category-research",
  "--category-school",
  "--category-projects",
  "--category-shopping",
  "--category-creative",
  "--category-news",
  "--category-read-later",
  "--category-other",
];

export function faviconUrl(domain: string): string {
  return `https://www.google.com/s2/favicons?sz=64&domain=${domain}`;
}

export function avatarFallback(domain: string): { letter: string; colorVar: string } {
  if (!domain) return { letter: "?", colorVar: PALETTE[PALETTE.length - 1] };

  let hash = 0;
  for (let i = 0; i < domain.length; i++) {
    hash = (hash * 31 + domain.charCodeAt(i)) >>> 0;
  }

  return {
    letter: domain[0].toUpperCase(),
    colorVar: PALETTE[hash % PALETTE.length],
  };
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/workspace/favicon.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add favicon URL + deterministic letter/color fallback utilities"
```

---

### Task 3: App shell wiring (landing ↔ workspace state)

**Files:**
- Create: `src/components/app-shell.tsx`
- Create: `src/components/landing-view.tsx` (existing landing JSX extracted verbatim from `page.tsx`)
- Modify: `src/app/page.tsx`
- Modify: `src/components/tab-input.tsx` (accept an `onDump` callback)

**Interfaces:**
- Produces: `<AppShell />` (no props) as the new root of `page.tsx`. `TabInput` gains `onDump?: (tabs: Tab[]) => void`, called with the parsed tabs when the CTA is clicked.

- [ ] **Step 1: Extract the current landing markup into `LandingView`**

```tsx
// src/components/landing-view.tsx
import { Header } from "@/components/header"
import { HeroBackground } from "@/components/hero-background"
import { TabInput } from "@/components/tab-input"
import type { Tab } from "@/lib/tabs/types"

export function LandingView({ onDump }: { onDump: (tabs: Tab[]) => void }) {
  return (
    <div className="relative flex min-h-screen flex-1 flex-col">
      <HeroBackground />
      <Header />
      <main className="relative mx-auto flex w-full max-w-3xl flex-1 flex-col items-center px-6 py-20 text-center sm:py-28">
        <h1 className="text-4xl font-semibold tracking-tight text-balance text-foreground sm:text-6xl">
          Your tabs are a mess.
          <br />
          Dump them.
        </h1>
        <p className="mt-5 max-w-xl text-base text-balance text-muted-foreground sm:text-lg">
          Paste your browser tabs and turn the chaos
          <br className="hidden sm:block" /> into an organized workspace.
        </p>

        <div className="mt-10 w-full">
          <TabInput onDump={onDump} />
        </div>
      </main>
    </div>
  )
}
```

- [ ] **Step 2: Add the `onDump` callback to `TabInput`**

In `src/components/tab-input.tsx`, add the prop and wire the button:

```tsx
export function TabInput({ onDump }: { onDump?: (tabs: Tab[]) => void }) {
  // ...unchanged state/derivation...

  return (
    <div className="w-full">
      {/* ...unchanged Textarea and status row... */}
      <Button
        size="lg"
        className="mt-6 w-full sm:w-auto"
        disabled={validCount === 0}
        onClick={() => onDump?.(tabs)}
      >
        {ctaLabel}
      </Button>
    </div>
  )
}
```

Add `import type { Tab } from "@/lib/tabs/types"` alongside the existing imports.

- [ ] **Step 3: Implement `AppShell`**

```tsx
// src/components/app-shell.tsx
"use client"

import { useState } from "react"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import type { Tab } from "@/lib/tabs/types"

export function AppShell() {
  const [workspaceTabs, setWorkspaceTabs] = useState<Tab[] | null>(null)

  if (!workspaceTabs) {
    return <LandingView onDump={setWorkspaceTabs} />
  }

  return (
    <WorkspaceView
      tabs={workspaceTabs}
      onTabsChange={setWorkspaceTabs}
      onClear={() => setWorkspaceTabs(null)}
    />
  )
}
```

(`WorkspaceView` doesn't exist yet — Task 6 creates it. This task compiles once a minimal placeholder exists; add a one-line placeholder now if needed to keep the build green, then let Task 6 replace it.)

- [ ] **Step 4: Add a minimal `WorkspaceView` placeholder so the app builds**

```tsx
// src/components/workspace/workspace-view.tsx (placeholder, replaced in Task 6)
import type { Tab } from "@/lib/tabs/types"

export function WorkspaceView({ tabs }: { tabs: Tab[]; onTabsChange: (tabs: Tab[]) => void; onClear: () => void }) {
  return <div className="p-6 text-foreground">{tabs.length} tabs</div>
}
```

- [ ] **Step 5: Update `page.tsx`**

```tsx
// src/app/page.tsx
import { AppShell } from "@/components/app-shell"

export default function Home() {
  return <AppShell />
}
```

- [ ] **Step 6: Typecheck and manually verify the transition**

```bash
npx tsc --noEmit
```

In the browser: paste 2 valid URLs, click the CTA, confirm the view switches to the placeholder workspace showing "2 tabs".

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: wire landing-to-workspace state transition via AppShell"
```

---

### Task 4: TabFavicon component

**Files:**
- Create: `src/components/workspace/tab-favicon.tsx`

**Interfaces:**
- Consumes: `faviconUrl`, `avatarFallback` (Task 2), shadcn `Avatar`/`AvatarImage`/`AvatarFallback`.
- Produces: `<TabFavicon domain={string} size?: number />` — consumed by `TabCard` (Task 5).

- [ ] **Step 1: Implement**

```tsx
// src/components/workspace/tab-favicon.tsx
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar"
import { faviconUrl, avatarFallback } from "@/lib/workspace/favicon"

export function TabFavicon({ domain, size = 28 }: { domain: string; size?: number }) {
  const { letter, colorVar } = avatarFallback(domain)

  return (
    <Avatar style={{ width: size, height: size }} className="shrink-0 rounded-md">
      <AvatarImage src={faviconUrl(domain)} alt="" />
      <AvatarFallback
        className="rounded-md text-[0.65rem] font-semibold text-white"
        style={{ backgroundColor: `var(${colorVar})` }}
      >
        {letter}
      </AvatarFallback>
    </Avatar>
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
git commit -m "feat: add TabFavicon (real favicon with generated letter/color fallback)"
```

---

### Task 5: TabCard component (favicon, metadata, category reassignment, open, overflow)

**Files:**
- Create: `src/components/workspace/tab-card.tsx`

**Interfaces:**
- Consumes: `TabFavicon` (Task 4), `CATEGORIES`/`CATEGORY_ORDER` (existing), shadcn `Badge`, `DropdownMenu*`, `IconButton`.
- Produces: `<TabCard tab={Tab} onCategoryChange={(id: string, category: CategoryId) => void} />` — consumed by `CategoryCard`'s representative list and `CategorySheet`'s full list.

- [ ] **Step 1: Implement**

```tsx
// src/components/workspace/tab-card.tsx
"use client"

import { ExternalLink, MoreHorizontal } from "lucide-react"
import { Badge } from "@/components/ui/badge"
import { IconButton } from "@/components/ui/icon-button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { TabFavicon } from "@/components/workspace/tab-favicon"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

function openTab(url: string) {
  window.open(url, "_blank", "noopener,noreferrer")
}

export function TabCard({
  tab,
  onCategoryChange,
}: {
  tab: Tab
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const category = (tab.category as CategoryId | undefined) ?? "other"
  const primaryLine = tab.title?.trim() || tab.domain

  return (
    <div className="group flex items-center gap-3 rounded-lg border border-subtle bg-card px-3 py-2.5 transition-colors hover:border-border">
      <TabFavicon domain={tab.domain} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-sm font-medium text-foreground">{primaryLine}</p>
        <p className="truncate text-xs text-tertiary">{tab.domain}</p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Badge
            variant="outline"
            className="hidden shrink-0 cursor-pointer sm:inline-flex"
          >
            {CATEGORIES[category].name}
          </Badge>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {CATEGORY_ORDER.map((id) => (
            <DropdownMenuItem
              key={id}
              onSelect={() => onCategoryChange(tab.id, id)}
            >
              {CATEGORIES[id].name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <IconButton aria-label={`Open ${tab.domain}`} onClick={() => openTab(tab.url)}>
        <ExternalLink />
      </IconButton>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <IconButton aria-label="More actions">
            <MoreHorizontal />
          </IconButton>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem onSelect={() => openTab(tab.url)}>Open</DropdownMenuItem>
          {CATEGORY_ORDER.map((id) => (
            <DropdownMenuItem
              key={id}
              onSelect={() => onCategoryChange(tab.id, id)}
            >
              Move to {CATEGORIES[id].name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
```

Note: the category `Badge` dropdown is hidden below `sm` (space is tight on mobile) — the overflow menu's "Move to..." items are the mobile path for reassignment, so the feature is never lost, only the faster shortcut is desktop-only.

- [ ] **Step 2: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "feat: add TabCard with graceful metadata fallback, open action, and category reassignment"
```

---

### Task 6: WorkspaceOverview, WorkspaceHeader, and the real WorkspaceView

**Files:**
- Create: `src/components/workspace/workspace-overview.tsx`
- Create: `src/components/workspace/workspace-header.tsx`
- Create: `src/components/workspace/clear-workspace-dialog.tsx`
- Modify: `src/components/workspace/workspace-view.tsx` (replace Task 3's placeholder)

**Interfaces:**
- Consumes: `computeOverview` (Task 1), shadcn `AlertDialog*`.
- Produces: `<WorkspaceOverview tabs={Tab[]} />`, `<WorkspaceHeader tabCount={number} onSearch={(q: string) => void} onCleanup={() => void} onExport={() => void} onClearRequest={() => void} />`, `<ClearWorkspaceDialog open onOpenChange onConfirm />` — composed by `WorkspaceView` (Task 7 finishes wiring category grid/search into it, but the shell here is real, not a placeholder).

- [ ] **Step 1: Implement `WorkspaceOverview`**

```tsx
// src/components/workspace/workspace-overview.tsx
import { computeOverview } from "@/lib/workspace/stats"
import type { Tab } from "@/lib/tabs/types"

export function WorkspaceOverview({ tabs }: { tabs: Tab[] }) {
  const { total, unique, categoriesInUse, duplicates } = computeOverview(tabs)
  const stats = [
    { label: "Total tabs", value: total },
    { label: "Unique", value: unique },
    { label: "Categories", value: categoriesInUse },
    { label: "Duplicates", value: duplicates },
  ]

  return (
    <div className="grid grid-cols-2 gap-4 border-b border-subtle pb-6 sm:grid-cols-4">
      {stats.map((stat) => (
        <div key={stat.label}>
          <p className="text-2xl font-semibold tracking-tight text-foreground">
            {stat.value}
          </p>
          <p className="text-xs text-tertiary">{stat.label}</p>
        </div>
      ))}
    </div>
  )
}
```

- [ ] **Step 2: Implement `ClearWorkspaceDialog`**

```tsx
// src/components/workspace/clear-workspace-dialog.tsx
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

export function ClearWorkspaceDialog({
  open,
  onOpenChange,
  onConfirm,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}) {
  return (
    <AlertDialog open={open} onOpenChange={onOpenChange}>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Clear workspace?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes every tab from this workspace. Your original paste
            isn&apos;t saved anywhere, so this can&apos;t be undone.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={onConfirm}>
            Clear workspace
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  )
}
```

- [ ] **Step 3: Implement `WorkspaceHeader`**

```tsx
// src/components/workspace/workspace-header.tsx
"use client"

import { useState } from "react"
import { Search, Sparkles, Download, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"

export function WorkspaceHeader({
  tabCount,
  onSearch,
  onCleanup,
  onExport,
  onClear,
}: {
  tabCount: number
  onSearch: (query: string) => void
  onCleanup: () => void
  onExport: () => void
  onClear: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const [searchOpen, setSearchOpen] = useState(false)

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
        <div className="mr-auto">
          <p className="text-sm font-semibold tracking-tight text-foreground">TabDump</p>
          <p className="text-xs text-tertiary">
            {tabCount} tab{tabCount === 1 ? "" : "s"}
          </p>
        </div>

        {searchOpen && (
          <Input
            autoFocus
            placeholder="Search tabs..."
            className="h-8 w-40 sm:w-56"
            onChange={(e) => onSearch(e.target.value)}
            onBlur={(e) => {
              if (!e.target.value) setSearchOpen(false)
            }}
          />
        )}
        <Button
          variant="ghost"
          size="sm"
          onClick={() => setSearchOpen((v) => !v)}
        >
          <Search /> Search
        </Button>
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

- [ ] **Step 4: Wire the real `WorkspaceView` (category grid comes in Task 7 — for now render the overview + header + a flat tab list so the app stays fully functional at every step)**

```tsx
// src/components/workspace/workspace-view.tsx
"use client"

import { useMemo, useState } from "react"
import { WorkspaceHeader } from "@/components/workspace/workspace-header"
import { WorkspaceOverview } from "@/components/workspace/workspace-overview"
import { TabCard } from "@/components/workspace/tab-card"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

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

  const visibleTabs = useMemo(() => {
    const q = query.trim().toLowerCase()
    if (!q) return tabs
    return tabs.filter(
      (t) =>
        t.domain.toLowerCase().includes(q) ||
        (t.title ?? "").toLowerCase().includes(q)
    )
  }, [tabs, query])

  function handleCategoryChange(id: string, category: CategoryId) {
    onTabsChange(
      tabs.map((t) => (t.id === id ? { ...t, category } : t))
    )
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
        onSearch={setQuery}
        onCleanup={handleCleanup}
        onExport={handleExport}
        onClear={onClear}
      />
      <main className="mx-auto max-w-6xl px-6 py-8">
        <WorkspaceOverview tabs={tabs} />
        <div className="mt-8 space-y-2">
          {visibleTabs.map((tab) => (
            <TabCard key={tab.id} tab={tab} onCategoryChange={handleCategoryChange} />
          ))}
        </div>
      </main>
    </div>
  )
}
```

- [ ] **Step 5: Typecheck and manual verification**

```bash
npx tsc --noEmit
```

In the browser: dump a few tabs, confirm the header shows the count, overview numbers look right, each tab row renders with favicon/domain/category badge, clicking Clear opens the confirmation and only clears on confirm.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add WorkspaceHeader, WorkspaceOverview, ClearWorkspaceDialog, and a functional flat WorkspaceView"
```

---

### Task 7: CategoryCard, CategoryGrid, CategorySheet (the real category-organized layout)

**Files:**
- Create: `src/components/workspace/category-card.tsx`
- Create: `src/components/workspace/category-sheet.tsx`
- Create: `src/components/workspace/category-grid.tsx`
- Modify: `src/components/workspace/workspace-view.tsx` (swap the flat tab list for `CategoryGrid`, keep search filtering the underlying tabs passed in)

**Interfaces:**
- Consumes: `groupByCategory`, `representativeDomains` (Task 1), `TabCard` (Task 5), shadcn `Sheet*`.
- Produces: `<CategoryGrid tabs={Tab[]} onCategoryChange={...} />` — the new body of `WorkspaceView`.

- [ ] **Step 1: Implement `CategoryCard`**

```tsx
// src/components/workspace/category-card.tsx
import { ArrowRight } from "lucide-react"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { representativeDomains } from "@/lib/workspace/stats"

export function CategoryCard({
  categoryId,
  tabs,
  onViewAll,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  onViewAll: () => void
}) {
  const def = CATEGORIES[categoryId]
  const Icon = def.icon
  const isEmpty = tabs.length === 0
  const domains = representativeDomains(tabs, 3)

  return (
    <div
      className={
        "flex flex-col gap-3 rounded-lg border border-subtle bg-card p-4" +
        (isEmpty ? " opacity-50" : "")
      }
    >
      <div className="flex items-center gap-2">
        <Icon
          className="size-4 shrink-0"
          style={{ color: `var(${def.accentColor})` }}
        />
        <span className="text-sm font-medium text-foreground">{def.name}</span>
        <span className="ml-auto text-xs text-tertiary">
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      </div>

      {domains.length > 0 && (
        <ul className="space-y-1">
          {domains.map((domain) => (
            <li key={domain} className="truncate text-xs text-secondary">
              {domain}
            </li>
          ))}
        </ul>
      )}

      {!isEmpty && (
        <button
          type="button"
          onClick={onViewAll}
          className="mt-auto flex items-center gap-1 text-xs font-medium text-primary hover:underline"
        >
          View all <ArrowRight className="size-3" />
        </button>
      )}
    </div>
  )
}
```

- [ ] **Step 2: Implement `CategorySheet`**

```tsx
// src/components/workspace/category-sheet.tsx
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { TabCard } from "@/components/workspace/tab-card"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategorySheet({
  categoryId,
  tabs,
  open,
  onOpenChange,
  onCategoryChange,
}: {
  categoryId: CategoryId | null
  tabs: Tab[]
  open: boolean
  onOpenChange: (open: boolean) => void
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const def = categoryId ? CATEGORIES[categoryId] : null

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-full sm:max-w-md">
        <SheetHeader>
          <SheetTitle>
            {def?.name} · {tabs.length} tab{tabs.length === 1 ? "" : "s"}
          </SheetTitle>
        </SheetHeader>
        <ScrollArea className="h-[calc(100vh-6rem)] px-4">
          <div className="space-y-2 pb-6">
            {tabs.map((tab) => (
              <TabCard key={tab.id} tab={tab} onCategoryChange={onCategoryChange} />
            ))}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 3: Implement `CategoryGrid`**

```tsx
// src/components/workspace/category-grid.tsx
"use client"

import { useState } from "react"
import { CategoryCard } from "@/components/workspace/category-card"
import { CategorySheet } from "@/components/workspace/category-sheet"
import { CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { groupByCategory } from "@/lib/workspace/stats"

export function CategoryGrid({
  tabs,
  onCategoryChange,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null)
  const groups = groupByCategory(tabs)

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {CATEGORY_ORDER.map((id) => (
          <CategoryCard
            key={id}
            categoryId={id}
            tabs={groups[id]}
            onViewAll={() => setOpenCategory(id)}
          />
        ))}
      </div>

      <CategorySheet
        categoryId={openCategory}
        tabs={openCategory ? groups[openCategory] : []}
        open={openCategory !== null}
        onOpenChange={(open) => !open && setOpenCategory(null)}
        onCategoryChange={onCategoryChange}
      />
    </>
  )
}
```

- [ ] **Step 4: Swap `WorkspaceView`'s flat list for `CategoryGrid`**

In `src/components/workspace/workspace-view.tsx`, replace the `<div className="mt-8 space-y-2">...</div>` block with:

```tsx
        <div className="mt-8">
          <CategoryGrid tabs={visibleTabs} onCategoryChange={handleCategoryChange} />
        </div>
```

and swap the `TabCard` import for `CategoryGrid`'s.

- [ ] **Step 5: Typecheck and manual verification**

```bash
npx tsc --noEmit
```

In the browser: confirm all 8 category cards render (including 0-tab ones, de-emphasized, no "View all"), "View all" opens the Sheet with the full list, closing it works, reassigning a tab's category from inside the Sheet moves it to the right card on next open.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add CategoryGrid/CategoryCard/CategorySheet — full category-organized workspace layout"
```

---

### Task 8: Responsive QA and edge cases

**Files:**
- Modify: any workspace component, only as needed to fix issues found.

**Interfaces:**
- None new — this task verifies Tasks 1–7 against the spec's explicit test matrix.

- [ ] **Step 1: Functional edge cases in the browser**

Using the workspace built above, verify each explicitly, fixing any issue found before moving to the next:
- 1 tab: workspace renders, singular "1 tab" in header, overview shows 1/1/1/0.
- 10, 50, 100 tabs: paste realistic mixed dumps of each size, confirm no lag opening/closing Sheets and no dropped tabs.
- Empty workspace: not directly reachable (CTA is disabled at 0 valid tabs) — confirm this stays true, i.e. there's no way to reach an empty `WorkspaceView`.
- Categories with 0 tabs: paste only GitHub URLs, confirm the other 7 category cards render de-emphasized with no "View all".
- Duplicate tabs: paste a URL twice, confirm the overview's Duplicates count is correct and Cleanup removes the extra copy.
- Missing favicons: force a favicon load failure (e.g. an unresolvable domain) and confirm the fallback letter avatar renders, not a broken image icon.
- Missing titles: already the default path — confirm domain renders as the primary line with normal styling, not obviously "fallback"-looking.
- Long titles/domains: paste a URL with a very long path/query on a long subdomain, confirm `truncate` keeps the card from overflowing or breaking layout.

- [ ] **Step 2: Responsive check at each width**

Resize to 375, 768, 1024, 1440 and confirm: category grid is 1/2/3 columns respectively (2 columns starts at `sm` = 640px, so also check ~640-1023 shows 2), overview stats are 2 columns on mobile and 4 above `sm`, header actions wrap sensibly instead of overflowing, Sheet is full-width on mobile, zero horizontal scroll at every width.

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
git commit -m "fix: workspace responsive and edge-case QA polish"
```

(Skip the commit if nothing needed changing.)

- [ ] **Step 5: Report completion**

Summarize the workspace, category UI, tab UI, responsive behavior, tests, and fixes in the `PHASE 4 COMPLETE` format specified by the user.
