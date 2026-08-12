# TabDump Phase 7: Local Persistence, Export & Clipboard Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Persist the workspace's `Tab[]` to `localStorage` so a refresh (or browser close/reopen) restores it; replace the single Export button with Copy all URLs / Copy category URLs / Export TXT; handle clipboard-unavailable, storage-unavailable, and export-failure gracefully.

**Architecture:** `src/lib/workspace/persistence.ts` and `src/lib/workspace/export.ts` hold pure, try/catch-wrapped logic, unit-tested. `AppShell` is the only component that touches storage — it hydrates from it on mount and writes on every `onDump`/`onTabsChange`/`onClear`. `ExportMenu` is a new dropdown replacing the old plain Export button, using existing `DropdownMenuSub` for the category submenu.

**Tech Stack:** TypeScript, React 19, `localStorage`, `navigator.clipboard`, `Blob`/object URLs, existing shadcn `DropdownMenu*`, sonner, Vitest + Testing Library.

## Global Constraints

- One storage key holds `{ version: 1, tabs: Tab[] }` — tabs, categories, user category changes, and post-cleanup state are all the same array; nothing else needs its own storage.
- Refreshing, or closing and reopening the browser, must restore the workspace exactly (localStorage persists across both by spec; the code path is identical either way).
- Clear workspace stays behind its existing two-step confirmation (open dialog → explicit second click) — that already satisfies "impossible with one click." `onClear` must now also clear storage.
- Copy/export always operate on `tab.url` (the original), never `normalizedUrl`.
- Toast copy exactly: `Copied N URLs` (no trailing period, matching the spec block) and `Workspace exported`.
- Clipboard failure, storage unavailability, and export failure must each degrade gracefully with a toast — never throw, never break the rest of the app.
- No cloud sync, no IndexedDB, no deprecated `execCommand` clipboard fallback, no persisting search/filter/sort UI state.

---

### Task 1: Persistence pure logic

**Files:**
- Create: `src/lib/workspace/persistence.ts`
- Test: `src/lib/workspace/persistence.test.ts`

**Interfaces:**
- Consumes: `Tab` (existing).
- Produces: `isStorageAvailable(): boolean`, `loadWorkspace(): Tab[] | null`, `saveWorkspace(tabs: Tab[]): boolean`, `clearWorkspaceStorage(): void` — consumed by `AppShell` (Task 3).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/persistence.test.ts
import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  isStorageAvailable,
  loadWorkspace,
  saveWorkspace,
  clearWorkspaceStorage,
} from "./persistence";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string }): Tab {
  return {
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    category: "other",
    ...over,
  };
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("isStorageAvailable", () => {
  it("returns true when localStorage works normally", () => {
    expect(isStorageAvailable()).toBe(true);
  });

  it("returns false when localStorage throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    expect(isStorageAvailable()).toBe(false);
    window.localStorage.setItem = original;
  });
});

describe("loadWorkspace", () => {
  it("returns null when nothing is stored", () => {
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null for corrupted JSON", () => {
    window.localStorage.setItem("tabdump:workspace:v1", "{not json");
    expect(loadWorkspace()).toBeNull();
  });

  it("returns null when the shape is wrong", () => {
    window.localStorage.setItem("tabdump:workspace:v1", JSON.stringify({ tabs: "nope" }));
    expect(loadWorkspace()).toBeNull();
  });

  it("round-trips tabs saved by saveWorkspace", () => {
    const tabs = [makeTab({ id: "1" }), makeTab({ id: "2", category: "research" })];
    saveWorkspace(tabs);
    expect(loadWorkspace()).toEqual(tabs);
  });
});

describe("saveWorkspace", () => {
  it("returns true on success", () => {
    expect(saveWorkspace([makeTab({ id: "1" })])).toBe(true);
  });

  it("returns false when storage throws", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("quota exceeded");
    };
    expect(saveWorkspace([makeTab({ id: "1" })])).toBe(false);
    window.localStorage.setItem = original;
  });
});

describe("clearWorkspaceStorage", () => {
  it("removes the stored workspace", () => {
    saveWorkspace([makeTab({ id: "1" })]);
    clearWorkspaceStorage();
    expect(loadWorkspace()).toBeNull();
  });

  it("does not throw when storage is unavailable", () => {
    const original = window.localStorage.removeItem;
    window.localStorage.removeItem = () => {
      throw new Error("unavailable");
    };
    expect(() => clearWorkspaceStorage()).not.toThrow();
    window.localStorage.removeItem = original;
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/persistence.test.ts
```

Expected: FAIL — `persistence.ts` does not exist.

- [ ] **Step 3: Implement `persistence.ts`**

```ts
// src/lib/workspace/persistence.ts
import type { Tab } from "@/lib/tabs/types";

const STORAGE_KEY = "tabdump:workspace:v1";

export function isStorageAvailable(): boolean {
  try {
    const testKey = "__tabdump_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export function loadWorkspace(): Tab[] | null {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed.tabs as Tab[];
  } catch {
    return null;
  }
}

export function saveWorkspace(tabs: Tab[]): boolean {
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify({ version: 1, tabs }));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspaceStorage(): void {
  try {
    window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/workspace/persistence.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add localStorage persistence utilities (load/save/clear, availability check)"
```

---

### Task 2: Export/clipboard pure logic

**Files:**
- Create: `src/lib/workspace/export.ts`
- Test: `src/lib/workspace/export.test.ts`

**Interfaces:**
- Consumes: `CATEGORIES`, `CATEGORY_ORDER` (existing), `groupByCategory` (existing, from `./stats`).
- Produces: `urlsText(tabs)`, `buildExportText(tabs)`, `copyText(text): Promise<boolean>`, `downloadTextFile(filename, text): boolean` — consumed by `ExportMenu` (Task 4).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/export.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { urlsText, buildExportText, copyText, downloadTextFile } from "./export";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string; url: string }): Tab {
  return {
    normalizedUrl: over.url,
    domain: "example.com",
    category: "other",
    ...over,
  };
}

describe("urlsText", () => {
  it("joins tab urls with newlines", () => {
    const tabs = [makeTab({ id: "1", url: "https://a.com" }), makeTab({ id: "2", url: "https://b.com" })];
    expect(urlsText(tabs)).toBe("https://a.com\nhttps://b.com");
  });

  it("returns an empty string for no tabs", () => {
    expect(urlsText([])).toBe("");
  });
});

describe("buildExportText", () => {
  it("matches the spec format exactly", () => {
    const tabs = [
      makeTab({ id: "1", url: "https://arxiv.org/abs/1", category: "research" }),
      makeTab({ id: "2", url: "https://scholar.google.com/x", category: "research" }),
      makeTab({ id: "3", url: "https://classroom.google.com/c/1", category: "school" }),
    ];
    expect(buildExportText(tabs)).toBe(
      "TABDUMP EXPORT\n\nRESEARCH\n\nhttps://arxiv.org/abs/1\n\nhttps://scholar.google.com/x\n\nSCHOOL\n\nhttps://classroom.google.com/c/1\n"
    );
  });

  it("skips categories with no tabs", () => {
    const text = buildExportText([makeTab({ id: "1", url: "https://a.com", category: "projects" })]);
    expect(text).not.toContain("RESEARCH");
    expect(text).toContain("PROJECTS");
  });

  it("handles an empty workspace", () => {
    expect(buildExportText([])).toBe("TABDUMP EXPORT\n");
  });
});

describe("copyText", () => {
  afterEach(() => {
    Object.assign(navigator, { clipboard: undefined });
  });

  it("returns true and calls clipboard.writeText on success", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(true);
    expect(writeText).toHaveBeenCalledWith("hello");
  });

  it("returns false when clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: undefined });
    expect(await copyText("hello")).toBe(false);
  });

  it("returns false when writeText rejects", async () => {
    const writeText = vi.fn().mockRejectedValue(new Error("denied"));
    Object.assign(navigator, { clipboard: { writeText } });
    expect(await copyText("hello")).toBe(false);
  });
});

describe("downloadTextFile", () => {
  it("creates a blob, triggers a download, and cleans up the object URL", () => {
    const createObjectURL = vi.fn().mockReturnValue("blob:mock");
    const revokeObjectURL = vi.fn();
    window.URL.createObjectURL = createObjectURL;
    window.URL.revokeObjectURL = revokeObjectURL;
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});

    expect(downloadTextFile("test.txt", "hello world")).toBe(true);
    expect(createObjectURL).toHaveBeenCalledTimes(1);
    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).toHaveBeenCalledWith("blob:mock");

    clickSpy.mockRestore();
  });

  it("returns false if the download sequence throws", () => {
    window.URL.createObjectURL = () => {
      throw new Error("nope");
    };
    expect(downloadTextFile("test.txt", "hello")).toBe(false);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/export.test.ts
```

Expected: FAIL — `export.ts` does not exist.

- [ ] **Step 3: Implement `export.ts`**

```ts
// src/lib/workspace/export.ts
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories";
import type { Tab } from "@/lib/tabs/types";
import { groupByCategory } from "./stats";

export function urlsText(tabs: Tab[]): string {
  return tabs.map((t) => t.url).join("\n");
}

export function buildExportText(tabs: Tab[]): string {
  const groups = groupByCategory(tabs);
  const lines: string[] = ["TABDUMP EXPORT", ""];

  for (const id of CATEGORY_ORDER) {
    const group = groups[id];
    if (group.length === 0) continue;
    lines.push(CATEGORIES[id].name.toUpperCase());
    lines.push("");
    for (const tab of group) {
      lines.push(tab.url);
      lines.push("");
    }
  }

  return lines.join("\n").replace(/\n+$/, "\n");
}

export async function copyText(text: string): Promise<boolean> {
  try {
    if (!navigator.clipboard?.writeText) return false;
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}

export function downloadTextFile(filename: string, text: string): boolean {
  try {
    const blob = new Blob([text], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = filename;
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);
    URL.revokeObjectURL(url);
    return true;
  } catch {
    return false;
  }
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/workspace/export.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add export/clipboard pure logic (urlsText, buildExportText, copyText, downloadTextFile)"
```

---

### Task 3: Wire persistence into AppShell (hydration, save, clear)

**Files:**
- Modify: `src/components/app-shell.tsx`
- Test: `src/components/app-shell.test.tsx`

**Interfaces:**
- Consumes: `isStorageAvailable`, `loadWorkspace`, `saveWorkspace`, `clearWorkspaceStorage` (Task 1).
- Produces: the finished persisted `AppShell` — no further consumers.

- [ ] **Step 1: Implement `AppShell`**

```tsx
// src/components/app-shell.tsx
"use client"

import { useEffect, useState } from "react"
import { toast } from "sonner"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import {
  clearWorkspaceStorage,
  isStorageAvailable,
  loadWorkspace,
  saveWorkspace,
} from "@/lib/workspace/persistence"
import type { Tab } from "@/lib/tabs/types"

export function AppShell() {
  const [workspaceTabs, setWorkspaceTabs] = useState<Tab[] | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [canPersist, setCanPersist] = useState(true)

  useEffect(() => {
    const available = isStorageAvailable()
    setCanPersist(available)
    if (available) {
      const persisted = loadWorkspace()
      if (persisted && persisted.length > 0) setWorkspaceTabs(persisted)
    } else {
      toast.info("Your workspace won't be saved between visits", {
        description: "Local storage isn't available in this browser.",
      })
    }
    setHydrated(true)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function persist(tabs: Tab[]) {
    if (canPersist) saveWorkspace(tabs)
  }

  function handleDump(tabs: Tab[]) {
    setWorkspaceTabs(tabs)
    persist(tabs)
  }

  function handleTabsChange(tabs: Tab[]) {
    setWorkspaceTabs(tabs)
    persist(tabs)
  }

  function handleClear() {
    setWorkspaceTabs(null)
    clearWorkspaceStorage()
  }

  if (!hydrated) return null

  if (!workspaceTabs) {
    return <LandingView onDump={handleDump} />
  }

  return (
    <WorkspaceView
      tabs={workspaceTabs}
      onTabsChange={handleTabsChange}
      onClear={handleClear}
    />
  )
}
```

- [ ] **Step 2: Write the interaction tests**

```tsx
// src/components/app-shell.test.tsx
import { describe, expect, it, beforeEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";

beforeEach(() => {
  window.localStorage.clear();
});

describe("AppShell persistence", () => {
  it("shows the landing page when nothing is persisted", async () => {
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("persists a dumped workspace and restores it on remount", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    expect(await screen.findByText("github.com")).toBeTruthy();

    unmount();
    render(<AppShell />);

    expect(await screen.findByText("github.com")).toBeTruthy();
  });

  it("persists a category reassignment", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    await user.click(screen.getByRole("button", { name: "Projects" }));
    await user.click(screen.getByText("School"));

    unmount();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText("Search tabs..."),
      "github"
    );
    expect(await screen.findByText("School")).toBeTruthy();
  });

  it("Clear also removes the persisted workspace", async () => {
    const user = userEvent.setup();
    const { unmount } = render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    expect(await screen.findByText("github.com")).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "Clear" }));
    await user.click(await screen.findByRole("button", { name: "Clear workspace" }));
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();

    unmount();
    render(<AppShell />);
    expect(await screen.findByPlaceholderText(/Paste your tabs/)).toBeTruthy();
  });

  it("degrades gracefully when localStorage is unavailable", async () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("unavailable");
    };
    const user = userEvent.setup();
    render(<AppShell />);

    await user.type(
      await screen.findByPlaceholderText(/Paste your tabs/),
      "https://github.com/a"
    );
    await user.click(screen.getByRole("button", { name: /Dump 1 tab/ }));
    expect(await screen.findByText("github.com")).toBeTruthy();

    window.localStorage.setItem = original;
  });
});
```

- [ ] **Step 3: Run and confirm the tests pass**

```bash
npx vitest run src/components/app-shell.test.tsx
```

Expected: all PASS. If "persists a category reassignment" fails on selector mismatch, inspect the rendered DOM (`screen.debug()`) and adjust the query — the underlying mechanism (TabCard's category badge opens a `DropdownMenu` listing all 8 categories) is unchanged from Phase 4/5.

- [ ] **Step 4: Typecheck**

```bash
npx tsc --noEmit
```

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: persist workspace to localStorage across refresh, with hydration and graceful degradation"
```

---

### Task 4: ExportMenu (Copy all / Copy category / Export TXT)

**Files:**
- Create: `src/components/workspace/export-menu.tsx`
- Modify: `src/components/workspace/workspace-header.tsx` (swap the plain Export button for `<ExportMenu tabs={tabs} />`, take `tabs: Tab[]` instead of `tabCount: number` + `onExport`)
- Modify: `src/components/workspace/workspace-view.tsx` (pass `tabs={tabs}` to `WorkspaceHeader`; delete the now-unused `handleExport`)

**Interfaces:**
- Consumes: `categoryCounts` (existing, from `@/lib/workspace/search`), `urlsText`/`buildExportText`/`copyText`/`downloadTextFile` (Task 2), `CATEGORIES`/`CATEGORY_ORDER` (existing), `DropdownMenuSub*` (existing).
- Produces: `<ExportMenu tabs={Tab[]} />` — consumed by `WorkspaceHeader`.

- [ ] **Step 1: Implement `ExportMenu`**

```tsx
// src/components/workspace/export-menu.tsx
"use client"

import { toast } from "sonner"
import { Copy, Download, FileText } from "lucide-react"
import { buttonVariants } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import { categoryCounts } from "@/lib/workspace/search"
import { buildExportText, copyText, downloadTextFile, urlsText } from "@/lib/workspace/export"
import type { Tab } from "@/lib/tabs/types"

function urlsLabel(n: number) {
  return `${n} URL${n === 1 ? "" : "s"}`
}

export function ExportMenu({ tabs }: { tabs: Tab[] }) {
  const counts = categoryCounts(tabs)

  async function handleCopyAll() {
    const ok = await copyText(urlsText(tabs))
    if (ok) toast.success(`Copied ${urlsLabel(tabs.length)}`)
    else toast.error("Couldn't copy to clipboard")
  }

  async function handleCopyCategory(id: CategoryId) {
    const categoryTabs = tabs.filter(
      (t) => ((t.category as CategoryId | undefined) ?? "other") === id
    )
    const ok = await copyText(urlsText(categoryTabs))
    if (ok) toast.success(`Copied ${urlsLabel(categoryTabs.length)}`)
    else toast.error("Couldn't copy to clipboard")
  }

  function handleExportTxt() {
    const ok = downloadTextFile("tabdump-export.txt", buildExportText(tabs))
    if (ok) toast.success("Workspace exported")
    else toast.error("Couldn't export workspace")
  }

  return (
    <DropdownMenu>
      <DropdownMenuTrigger className={buttonVariants({ variant: "ghost", size: "sm" })}>
        <Download /> Export
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end">
        <DropdownMenuItem onClick={handleCopyAll}>
          <Copy /> Copy all URLs
        </DropdownMenuItem>
        <DropdownMenuSub>
          <DropdownMenuSubTrigger>
            <Copy /> Copy category URLs
          </DropdownMenuSubTrigger>
          <DropdownMenuSubContent>
            {CATEGORY_ORDER.map((id) => (
              <DropdownMenuItem
                key={id}
                disabled={counts[id] === 0}
                onClick={() => handleCopyCategory(id)}
              >
                {CATEGORIES[id].name} ({counts[id]})
              </DropdownMenuItem>
            ))}
          </DropdownMenuSubContent>
        </DropdownMenuSub>
        <DropdownMenuItem onClick={handleExportTxt}>
          <FileText /> Export TXT
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
```

(Note: the trigger uses `buttonVariants` classes directly with no `render` prop — this is the pattern Phase 5 established after discovering that nesting the shadcn `Button` component itself as a `Menu.Trigger` render target silently failed to open. Do not "clean this up" to use `<Button>` — it's deliberate.)

- [ ] **Step 2: Update `WorkspaceHeader`**

Read the current file first. Replace the `tabCount: number` and `onExport: () => void` props with `tabs: Tab[]`; remove the plain Export `Button` (and now-unused `Download` icon import) in favor of `<ExportMenu tabs={tabs} />`; compute `tabCount = tabs.length` locally for the existing header text.

- [ ] **Step 3: Update `WorkspaceView`**

Read the current file first. Change the `<WorkspaceHeader ... tabCount={tabs.length} ... onExport={handleExport} .../>` call to pass `tabs={tabs}` instead of `tabCount`, and drop `onExport={handleExport}`. Delete the `handleExport` function entirely (its logic now lives in `ExportMenu`).

- [ ] **Step 4: Write interaction tests**

```tsx
// src/components/workspace/export-menu.test.tsx
import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { toast } from "sonner";
import { ExportMenu } from "./export-menu";
import type { Tab } from "@/lib/tabs/types";

function makeTab(over: Partial<Tab> & { id: string; url: string }): Tab {
  return {
    normalizedUrl: over.url,
    domain: "example.com",
    category: "other",
    ...over,
  };
}

const tabs: Tab[] = [
  makeTab({ id: "1", url: "https://github.com/a", category: "projects" }),
  makeTab({ id: "2", url: "https://arxiv.org/abs/1", category: "research" }),
];

describe("ExportMenu", () => {
  afterEach(() => {
    Object.assign(navigator, { clipboard: undefined });
    vi.restoreAllMocks();
  });

  it("Copy all URLs copies every tab and shows the exact toast copy", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy all URLs"));

    expect(writeText).toHaveBeenCalledWith("https://github.com/a\nhttps://arxiv.org/abs/1");
    expect(toastSpy).toHaveBeenCalledWith("Copied 2 URLs");
  });

  it("Copy category URLs copies only that category's tabs", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.assign(navigator, { clipboard: { writeText } });
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy category URLs"));
    await user.click(await screen.findByText(/^Research/));

    expect(writeText).toHaveBeenCalledWith("https://arxiv.org/abs/1");
    expect(toastSpy).toHaveBeenCalledWith("Copied 1 URL");
  });

  it("disables categories with zero tabs in the submenu", async () => {
    const user = userEvent.setup();
    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy category URLs"));

    expect(await screen.findByText(/^School/)).toHaveProperty("closest");
    const schoolItem = (await screen.findByText(/^School/)).closest('[role="menuitem"]');
    expect(schoolItem).toHaveAttribute("aria-disabled", "true");
  });

  it("Export TXT triggers a download and shows the exact toast copy", async () => {
    window.URL.createObjectURL = vi.fn().mockReturnValue("blob:mock");
    window.URL.revokeObjectURL = vi.fn();
    const clickSpy = vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
    const toastSpy = vi.spyOn(toast, "success");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Export TXT"));

    expect(clickSpy).toHaveBeenCalledTimes(1);
    expect(toastSpy).toHaveBeenCalledWith("Workspace exported");
  });

  it("shows an error toast when clipboard is unavailable", async () => {
    Object.assign(navigator, { clipboard: undefined });
    const toastSpy = vi.spyOn(toast, "error");
    const user = userEvent.setup();

    render(<ExportMenu tabs={tabs} />);
    await user.click(screen.getByRole("button", { name: /Export/ }));
    await user.click(await screen.findByText("Copy all URLs"));

    expect(toastSpy).toHaveBeenCalledWith("Couldn't copy to clipboard");
  });
});
```

- [ ] **Step 5: Run and confirm the tests pass**

```bash
npx vitest run src/components/workspace/export-menu.test.tsx
```

Expected: all PASS. If the submenu's `disabled` assertion doesn't match the real rendered markup, inspect via `screen.debug()` and adjust the selector — the underlying `DropdownMenuItem` `disabled` prop is unchanged from how `TabCard`'s category dropdown already uses it.

- [ ] **Step 6: Full typecheck, lint, and the whole suite**

```bash
npx tsc --noEmit
npm run lint
npx vitest run
```

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: replace single Export button with Copy all / Copy category / Export TXT menu"
```

---

### Task 5: Clear-dialog copy update, error-handling QA, and full report

**Files:**
- Modify: `src/components/workspace/clear-workspace-dialog.tsx`
- Modify: any file, only as needed to fix issues found.

**Interfaces:**
- None new — verifies Tasks 1–4 together and finishes the phase.

- [ ] **Step 1: Update the confirmation copy**

In `clear-workspace-dialog.tsx`, the description currently says the paste "isn't saved anywhere" — no longer accurate now that the workspace persists. Change it to:

```tsx
<AlertDialogDescription>
  This removes every tab from this workspace, including what&apos;s saved
  locally. This can&apos;t be undone.
</AlertDialogDescription>
```

- [ ] **Step 2: Full automated check**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all succeed with zero errors.

- [ ] **Step 3: Browser QA (text/DOM-state checks, not menu-click interactions — see session notes on pane compositing)**

Using `javascript_exec` (plain `.click()` on non-menu buttons works reliably; portal-based `DropdownMenu` interactions do not in this environment and are already covered by Tasks 3–4's RTL tests):
- Dump a small mixed workspace, confirm `localStorage.getItem("tabdump:workspace:v1")` is populated with the right shape.
- Reassign a category via `TabCard`'s dropdown using `userEvent`-equivalent... — for the browser pass, just verify via direct DOM/localStorage inspection after triggering it through already-tested code paths, or skip and rely on Task 3's RTL coverage for this specific interaction.
- Force-reload the page (`navigate` with `force: true`) and confirm the workspace (including the reassigned category) reappears without re-pasting — this is the core "refresh doesn't destroy the workspace" check and does not require any menu interaction.
- Clear the workspace (plain button clicks — `Clear` then the `AlertDialog`'s `Clear workspace` action), reload, and confirm the landing page stays (nothing resurrected).
- Simulate storage unavailable via `javascript_exec` overriding `localStorage.setItem` to throw before the page loads is not possible mid-session; instead rely on Task 3's RTL test for this path, and note that in the exact same way sessionStorage-vs-localStorage can't be distinguished by this tool, "close/reopen the browser" is inherently covered by using `localStorage` (which the Web Storage spec guarantees survives that, unlike `sessionStorage`) plus the remount-based RTL tests already exercising the identical read-on-mount code path.

- [ ] **Step 4: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: Phase 7 persistence/export QA polish"
```

(Skip the commit if nothing needed changing.)

- [ ] **Step 5: Report completion**

Report in the format the user specified, then stop.
