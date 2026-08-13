# TabDump Full Product Redesign Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task (this plan is highly sequential — nearly every task depends on tokens/components established by earlier tasks — so a fresh subagent per task via subagent-driven-development would lose shared context; execute inline instead). Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Redesign TabDump's entire UI/UX into a premium, restrained, keyboard-first SaaS product (Linear × Arc as interaction/quality bar, TabDump's own blunt/technical voice preserved) without changing parsing, normalization, dedup, categorization, persistence, or export logic.

**Architecture:** Same Next.js 16 App Router + TypeScript + Tailwind v4 + shadcn/ui-on-`@base-ui/react` + lucide-react + sonner + Vitest stack. All work is additive/restyle within `src/app`, `src/components`, `src/lib`. One new dependency: `cmdk` (command palette). Everything else — token layer, new primitives, new lib functions — builds directly on the existing `globals.css` token system and `src/lib/workspace`/`src/lib/categories` modules already in place.

**Tech Stack:** Next.js 16, React 19, TypeScript, Tailwind CSS v4, shadcn/ui, `@base-ui/react`, `class-variance-authority`, `lucide-react`, `sonner`, `cmdk` (new), Vitest + Testing Library.

## Global Constraints

- Preserve exactly, do not modify the logic (styling/wrapper changes only) of: `src/lib/tabs/*`, `src/lib/categories/classify.ts`, `src/lib/categories/rules.ts`, `src/lib/categories/definitions.ts` category set, `src/lib/workspace/persistence.ts`, `src/lib/workspace/export.ts` file/text formats.
- Preserve verbatim: hero headline "Your tabs are a mess." / "Dump them.", subtext, textarea placeholder, helper text, dynamic CTA label pattern, "TabDump" wordmark, status-line pattern (`N tabs detected · M invalid`).
- Dark-only. Do not build a light theme. Keep `:root` OKLCH light tokens and `.dark` class structure as-is (already dark-locked via `html` `className="dark"` in `src/app/layout.tsx`) — do not add a theme toggle or a "change theme" command.
- Text hierarchy is 3-tier and already AA-contrast-verified: `text-foreground` (primary) → `text-muted-foreground` (secondary) → `text-tertiary` (tertiary/metadata). Every task that touches text color picks from this table — never introduce a fourth ad hoc gray.
- Spacing utilities are restricted to Tailwind's `{1,2,3,4,6,8,12,16}` scale for padding/margin/gap. Icon sizing (`size-3`, `size-3.5`, `size-4`, ets.) is a separate scale and is not in scope for this restriction.
- All new/changed transitions use the motion tokens added in Task 3 (`--ease-standard`, `--duration-fast/base/slow`) and must no-op under `prefers-reduced-motion: reduce`.
- No new dependencies beyond `cmdk`. No network calls added anywhere.
- Every task ends with `npx vitest run`, `npx tsc --noEmit` passing before commit (already-passing suites must stay green — this is a redesign, not a rewrite, existing tests are the regression net).
- Commit after every task, using the message style already in this repo's history (`feat:`/`fix:`/`chore:`/`refactor:` + short imperative summary).

---

## Phase 1 — Design system tokens

### Task 1: Typography scale utilities

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: utility classes `.text-display`, `.text-h1`, `.text-h2`, `.text-body`, `.text-body-sm`, `.text-label`, `.text-meta` — consumed by every component task from Phase 2 onward.

- [ ] **Step 1: Add the type-scale layer to `globals.css`**

Add after the `@layer base { ... }` block (before the final `:focus-visible` rule) in `src/app/globals.css`:

```css
@layer components {
  .text-display {
    font-size: clamp(2.25rem, 1.6rem + 2.5vw, 3.5rem);
    line-height: 1.05;
    letter-spacing: -0.02em;
    font-weight: 600;
  }
  .text-h1 {
    font-size: 1.5rem;
    line-height: 1.3;
    letter-spacing: -0.01em;
    font-weight: 600;
  }
  .text-h2 {
    font-size: 1.125rem;
    line-height: 1.4;
    font-weight: 600;
  }
  .text-body {
    font-size: 0.9375rem;
    line-height: 1.5;
    font-weight: 400;
  }
  .text-body-sm {
    font-size: 0.8125rem;
    line-height: 1.4;
    font-weight: 400;
  }
  .text-label {
    font-size: 0.75rem;
    line-height: 1.3;
    letter-spacing: 0.01em;
    font-weight: 500;
  }
  .text-meta {
    font-family: var(--font-geist-mono);
    font-size: 0.75rem;
    line-height: 1.2;
    font-variant-numeric: tabular-nums;
    font-weight: 400;
  }
}
```

- [ ] **Step 2: Verify the classes compile**

Run: `npm run dev` in the background is already available via the preview tooling used later in this plan; for this task, just run `npx tsc --noEmit` (CSS isn't type-checked, so this step only confirms nothing else broke) and visually confirm in the browser tool that `text-display` on a scratch element renders a large, tight-tracking heading (temporarily add `<p className="text-display">Test</p>` to `src/app/page.tsx`, check it in the browser tool at `http://localhost:3000`, then remove it).

- [ ] **Step 3: Commit**

```bash
git add src/app/globals.css
git commit -m "feat: add typography scale utility classes"
```

---

### Task 2: Elevation/text-hierarchy documentation + new color tokens

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: `--danger`, `--danger-foreground` CSS variables and documented (comment-only) elevation/text-hierarchy rules — consumed by Task 4 (IconButton), Task 23 (bulk remove), Task 27 (selection styling).

- [ ] **Step 1: Add danger tokens to the `.dark` block**

In `src/app/globals.css`, inside the existing `.dark { ... }` block, immediately after the `--warning-foreground: #ffffff;` line, add:

```css
  /* destructive/remove actions outside confirm dialogs (bulk remove, etc.) */
  --danger: var(--destructive);
  --danger-foreground: #ffffff;
```

- [ ] **Step 2: Document the 3-tier text hierarchy and 3-tier elevation model**

Immediately above the `.dark {` line, add a comment block (this is documentation for future edits, not new CSS):

```css
/*
 * Text hierarchy (3 tiers — do not add a 4th ad hoc gray):
 *   text-foreground        primary   — titles, primary values, active state
 *   text-muted-foreground  secondary — descriptions, body copy, labels
 *   text-tertiary          tertiary  — metadata, counts, timestamps (dimmer, still AA)
 *
 * Elevation (3 tiers — match surface to layer, don't default everything to bg-card):
 *   bg-background  base    — page canvas
 *   bg-card        surface — tab rows, category groups, inline panels
 *   bg-popover     elevated — menus, dialogs, sheets, command palette
 */
```

- [ ] **Step 3: Verify and commit**

Run `npx tsc --noEmit` (no TS surface changed, this just confirms the app still builds/type-checks). Then:

```bash
git add src/app/globals.css
git commit -m "feat: add danger color tokens, document text/elevation hierarchy"
```

---

### Task 3: Motion tokens + reduced-motion rule

**Files:**
- Modify: `src/app/globals.css`

**Interfaces:**
- Produces: `--ease-standard`, `--duration-fast`, `--duration-base`, `--duration-slow` CSS variables, and a global `prefers-reduced-motion` rule — consumed by every animated component from Task 4 onward.

- [ ] **Step 1: Add motion tokens to `:root`**

In `src/app/globals.css`, inside the existing top-level `:root { ... }` block (the one with `--background`, `--radius`, etc.), add:

```css
  --ease-standard: cubic-bezier(0.16, 1, 0.3, 1);
  --duration-fast: 120ms;
  --duration-base: 160ms;
  --duration-slow: 220ms;
```

- [ ] **Step 2: Add a global reduced-motion override**

At the end of the file, after the existing `:focus-visible` rule, add:

```css
@media (prefers-reduced-motion: reduce) {
  *,
  *::before,
  *::after {
    animation-duration: 0.001ms !important;
    animation-iteration-count: 1 !important;
    transition-duration: 0.001ms !important;
    scroll-behavior: auto !important;
  }
}
```

- [ ] **Step 3: Verify and commit**

`npx tsc --noEmit`, then in the browser tool set `resize_window` with `colorScheme` unaffected — reduced motion can't be toggled via this tool, so just confirm visually nothing regressed (existing dropdown/dialog animations still play).

```bash
git add src/app/globals.css
git commit -m "feat: add motion tokens and global prefers-reduced-motion rule"
```

---

### Task 4: Spacing-scale audit pass

**Files:**
- Modify: `src/components/workspace/tab-card.tsx`, `src/components/workspace/cleanup-dialog.tsx`, `src/components/workspace/category-filter-bar.tsx`, `src/components/workspace/search-bar.tsx`, `src/components/workspace/workspace-header.tsx`

**Interfaces:**
- None new — this task only normalizes existing arbitrary spacing values found during the codebase read. Off-scale icon-sizing utilities (`size-3`, `size-3.5`) are explicitly out of scope (see Global Constraints) and are left untouched.

- [ ] **Step 1: Fix `tab-card.tsx`**

In `src/components/workspace/tab-card.tsx`, the root row div uses `gap-3 px-3 py-2.5` — `py-2.5` (10px) is off-scale. Change to `py-2` (Task 16 will redo this component's structure entirely; this task is a minimal, mechanical fix so the audit is complete before the bigger redesign lands):

```tsx
<div className="group flex items-center gap-3 rounded-lg border border-subtle bg-card px-3 py-2 transition-colors hover:border-border">
```

- [ ] **Step 2: Fix `cleanup-dialog.tsx`**

In `src/components/workspace/cleanup-dialog.tsx`, the "Keep"/"Remove" pill button uses `px-1.5 py-0.5` and `gap-1.5`/`gap-2` mixed with a `text-[0.65rem]` arbitrary size. Replace the pill's className with:

```tsx
className={
  "shrink-0 rounded-md border px-2 py-1 text-label transition-colors disabled:cursor-not-allowed " +
  (keeping
    ? "border-primary/30 bg-primary/15 text-accent-text"
    : "border-subtle text-tertiary hover:text-foreground")
}
```

(this also adopts the new `.text-label` utility from Task 1 in place of the arbitrary `text-[0.65rem]`).

- [ ] **Step 3: Fix `category-filter-bar.tsx`**

In `src/components/workspace/category-filter-bar.tsx`, the `Pill` component uses `px-2.5 py-1` — `px-2.5` (10px) is off-scale. Change to `px-2`:

```tsx
"rounded-md border px-2 py-1 text-xs font-medium transition-colors",
```

- [ ] **Step 4: Fix `search-bar.tsx`**

In `src/components/workspace/search-bar.tsx`, the clear `IconButton` uses `size-6` positioning classes and `right-1` — these are icon-button sizing, not spacing, leave as-is. The wrapper `w-40 sm:w-64` is a width constraint, not spacing scale — leave as-is. No change needed; confirm during Step 5 build that nothing else in this file is off-scale.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
git add src/components/workspace/tab-card.tsx src/components/workspace/cleanup-dialog.tsx src/components/workspace/category-filter-bar.tsx
git commit -m "fix: normalize off-scale spacing values to the 4px spacing scale"
```

---

## Phase 2 — Core primitives

### Task 5: Tooltip primitive

**Files:**
- Create: `src/components/ui/tooltip.tsx`
- Test: `src/components/ui/tooltip.test.tsx`

**Interfaces:**
- Consumes: `@base-ui/react/tooltip` (already available — same package family as the other `@base-ui/react` primitives already in `src/components/ui/*`), `cn` from `@/lib/utils`.
- Produces: `Tooltip`, `TooltipTrigger`, `TooltipContent`, `TooltipProvider` — consumed by Task 6 (IconButton).

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ui/tooltip.test.tsx
import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from "./tooltip"

describe("Tooltip", () => {
  it("shows its content on hover and exposes it accessibly", async () => {
    const user = userEvent.setup()
    render(
      <TooltipProvider>
        <Tooltip>
          <TooltipTrigger render={<button>Open</button>} />
          <TooltipContent>Opens the thing</TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )

    expect(screen.queryByText("Opens the thing")).not.toBeInTheDocument()
    await user.hover(screen.getByRole("button", { name: "Open" }))
    await waitFor(() =>
      expect(screen.getByText("Opens the thing")).toBeInTheDocument()
    )
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/components/ui/tooltip.test.tsx
```

Expected: FAIL — `./tooltip` does not exist.

- [ ] **Step 3: Implement `tooltip.tsx`**

```tsx
// src/components/ui/tooltip.tsx
"use client"

import * as React from "react"
import { Tooltip as TooltipPrimitive } from "@base-ui/react/tooltip"

import { cn } from "@/lib/utils"

function TooltipProvider({
  delay = 400,
  ...props
}: TooltipPrimitive.Provider.Props) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delay={delay}
      {...props}
    />
  )
}

function Tooltip({ ...props }: TooltipPrimitive.Root.Props) {
  return (
    <TooltipProvider>
      <TooltipPrimitive.Root data-slot="tooltip" {...props} />
    </TooltipProvider>
  )
}

function TooltipTrigger({ ...props }: TooltipPrimitive.Trigger.Props) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 6,
  children,
  ...props
}: TooltipPrimitive.Popup.Props &
  Pick<TooltipPrimitive.Positioner.Props, "sideOffset">) {
  return (
    <TooltipPrimitive.Portal>
      <TooltipPrimitive.Positioner sideOffset={sideOffset}>
        <TooltipPrimitive.Popup
          data-slot="tooltip-content"
          className={cn(
            "z-50 rounded-md bg-popover px-2 py-1 text-label text-foreground shadow-md ring-1 ring-foreground/10",
            "origin-(--transform-origin) transition-[transform,opacity] duration-(--duration-fast) ease-(--ease-standard)",
            "data-starting-style:scale-95 data-starting-style:opacity-0 data-ending-style:scale-95 data-ending-style:opacity-0",
            className
          )}
          {...props}
        >
          {children}
        </TooltipPrimitive.Popup>
      </TooltipPrimitive.Positioner>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/components/ui/tooltip.test.tsx
```

Expected: PASS. If `@base-ui/react/tooltip`'s hover-open timing doesn't resolve under `userEvent.hover` in jsdom, reduce `TooltipProvider`'s test-time delay by passing `delay={0}` in the test's `TooltipProvider` — adjust the test, not the component's default.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/tooltip.tsx src/components/ui/tooltip.test.tsx
git commit -m "feat: add Tooltip primitive on @base-ui/react"
```

---

### Task 6: IconButton — visible rest-state + built-in tooltip

**Files:**
- Modify: `src/components/ui/icon-button.tsx`
- Test: create `src/components/ui/icon-button.test.tsx`

**Interfaces:**
- Consumes: `Tooltip`/`TooltipTrigger`/`TooltipContent` from Task 5.
- Produces: `IconButton` now accepts an optional `tooltip?: string` prop (defaults to the value of `aria-label`) and renders with a visible rest-state boundary — consumed by every existing call site (`tab-card.tsx`, `search-bar.tsx`, `sheet.tsx`'s close button usage stays a `Button`, unaffected) without requiring call-site changes beyond the new optional prop.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ui/icon-button.test.tsx
import { describe, expect, it } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { ExternalLink } from "lucide-react"
import { IconButton } from "./icon-button"

describe("IconButton", () => {
  it("renders an accessible label and shows a tooltip with the same text by default", async () => {
    const user = userEvent.setup()
    render(
      <IconButton aria-label="Open example.com">
        <ExternalLink />
      </IconButton>
    )
    const button = screen.getByRole("button", { name: "Open example.com" })
    await user.hover(button)
    await waitFor(() =>
      expect(screen.getByText("Open example.com")).toBeInTheDocument()
    )
  })

  it("uses a distinct tooltip prop when given", async () => {
    const user = userEvent.setup()
    render(
      <IconButton aria-label="More actions for example.com" tooltip="More actions">
        <ExternalLink />
      </IconButton>
    )
    await user.hover(
      screen.getByRole("button", { name: "More actions for example.com" })
    )
    await waitFor(() =>
      expect(screen.getByText("More actions")).toBeInTheDocument()
    )
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/components/ui/icon-button.test.tsx
```

Expected: FAIL — no tooltip is rendered yet.

- [ ] **Step 3: Implement the new `icon-button.tsx`**

```tsx
// src/components/ui/icon-button.tsx
import * as React from "react"

import { cn } from "@/lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip"

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string
  /** Tooltip text; defaults to aria-label so most call sites need nothing extra. */
  tooltip?: string
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, tooltip, "aria-label": ariaLabel, ...props }, ref) => (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            ref={ref}
            type="button"
            data-slot="icon-button"
            aria-label={ariaLabel}
            className={cn(
              "inline-flex size-8 shrink-0 items-center justify-center rounded-lg border border-transparent",
              "text-muted-foreground transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none",
              "hover:border-border hover:bg-muted hover:text-foreground",
              "active:not-aria-[haspopup]:translate-y-px",
              "focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50",
              "disabled:pointer-events-none disabled:opacity-50",
              "[&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
              className
            )}
            {...props}
          />
        }
      />
      <TooltipContent>{tooltip ?? ariaLabel}</TooltipContent>
    </Tooltip>
  )
)
IconButton.displayName = "IconButton"
```

Note the rest state now has `border border-transparent` (reserves the border's layout space) that becomes `border-border` on hover — this gives a visible boundary change on hover while never shifting layout, and the button reads as a bounded, clickable control even at rest because of the size/padding/rounded-lg treatment rather than floating icon-only.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/components/ui/icon-button.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Run the full suite (existing IconButton consumers) and confirm no regressions**

```bash
npx vitest run
npx tsc --noEmit
```

Expected: all PASS — `tab-card.tsx` and `search-bar.tsx` already pass `aria-label` to every `IconButton`, so no call-site changes are required.

- [ ] **Step 6: Commit**

```bash
git add src/components/ui/icon-button.tsx src/components/ui/icon-button.test.tsx
git commit -m "feat: give IconButton a visible rest state and a built-in tooltip"
```

---

### Task 7: `Kbd` component

**Files:**
- Create: `src/components/ui/kbd.tsx`

**Interfaces:**
- Produces: `<Kbd>K</Kbd>`, `<Kbd keys={["⌘", "K"]} />` — consumed by Task 20 (command palette hint chip) and Task 22 (palette shortcut display).

- [ ] **Step 1: Implement `kbd.tsx`**

```tsx
// src/components/ui/kbd.tsx
import { cn } from "@/lib/utils"

export function Kbd({
  keys,
  children,
  className,
}: {
  keys?: string[]
  children?: React.ReactNode
  className?: string
}) {
  const parts = keys ?? (children ? [String(children)] : [])
  return (
    <kbd
      className={cn(
        "inline-flex items-center gap-0.5 rounded-md border border-subtle bg-card px-1.5 py-0.5 text-meta text-tertiary",
        className
      )}
    >
      {parts.map((key, i) => (
        <span key={i}>{key}</span>
      ))}
    </kbd>
  )
}
```

- [ ] **Step 2: Verify and commit**

`npx tsc --noEmit` (no consumers yet, this is a pure addition — a render smoke test isn't meaningful until Task 20 wires it in, where it gets exercised by that task's own test).

```bash
git add src/components/ui/kbd.tsx
git commit -m "feat: add Kbd shortcut-chip component"
```

---

### Task 8: `EmptyState` component

**Files:**
- Create: `src/components/ui/empty-state.tsx`
- Test: `src/components/ui/empty-state.test.tsx`

**Interfaces:**
- Produces: `<EmptyState icon={LucideIcon} title={string} description={string} action={{ label: string; onClick: () => void }} />` — consumed by Task 19 (filtered-tab-list, category-sheet) and reused by Task 33's QA pass to check every empty-state call site uses this component.

- [ ] **Step 1: Write the failing test**

```tsx
// src/components/ui/empty-state.test.tsx
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Search } from "lucide-react"
import { EmptyState } from "./empty-state"

describe("EmptyState", () => {
  it("renders title, description, and an optional action", async () => {
    const user = userEvent.setup()
    const onClick = vi.fn()
    render(
      <EmptyState
        icon={Search}
        title='Nothing matches "asdf".'
        description="Try another word, or clear your filters."
        action={{ label: "Clear filters", onClick }}
      />
    )
    expect(screen.getByText('Nothing matches "asdf".')).toBeInTheDocument()
    expect(
      screen.getByText("Try another word, or clear your filters.")
    ).toBeInTheDocument()
    await user.click(screen.getByRole("button", { name: "Clear filters" }))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it("omits the action button when none is given", () => {
    render(<EmptyState icon={Search} title="Nothing here." />)
    expect(screen.queryByRole("button")).not.toBeInTheDocument()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/components/ui/empty-state.test.tsx
```

Expected: FAIL — `./empty-state` does not exist.

- [ ] **Step 3: Implement `empty-state.tsx`**

```tsx
// src/components/ui/empty-state.tsx
import type { LucideIcon } from "lucide-react"
import { Button } from "@/components/ui/button"

export function EmptyState({
  icon: Icon,
  title,
  description,
  action,
}: {
  icon: LucideIcon
  title: string
  description?: string
  action?: { label: string; onClick: () => void }
}) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Icon className="size-6 text-tertiary" aria-hidden />
      <div className="space-y-1">
        <p className="text-body font-medium text-foreground">{title}</p>
        {description && (
          <p className="text-body-sm text-muted-foreground">{description}</p>
        )}
      </div>
      {action && (
        <Button variant="secondary" size="sm" onClick={action.onClick}>
          {action.label}
        </Button>
      )}
    </div>
  )
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/components/ui/empty-state.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/components/ui/empty-state.tsx src/components/ui/empty-state.test.tsx
git commit -m "feat: add reusable EmptyState component"
```

---

### Task 9: Button restyle pass — typography tokens

**Files:**
- Modify: `src/components/ui/button.tsx`

**Interfaces:**
- None new — applies Task 1's typography tokens and Task 3's motion tokens to the existing `buttonVariants` without changing its variant/size API (`variant`/`size` props and their names are unchanged, so no call site in the app needs edits).

- [ ] **Step 1: Update the base `buttonVariants` string**

In `src/components/ui/button.tsx`, change the base class string's `text-sm font-medium` and `transition-all` to use the new tokens:

```tsx
const buttonVariants = cva(
  "group/button inline-flex shrink-0 items-center justify-center rounded-lg border border-transparent bg-clip-padding text-body font-medium whitespace-nowrap transition-all duration-(--duration-fast) ease-(--ease-standard) outline-none select-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 active:not-aria-[haspopup]:translate-y-px disabled:pointer-events-none disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
```

(only the `text-sm` → `text-body` swap and the added `duration-(--duration-fast) ease-(--ease-standard)` are new; every other class on that line is unchanged from the current file.)

- [ ] **Step 2: Verify and commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

Then in the browser tool, load `http://localhost:3000`, confirm the "Dump my tabs →" CTA still renders correctly (same size, slightly refined text rendering from the type-scale line-height).

```bash
git add src/components/ui/button.tsx
git commit -m "feat: apply typography and motion tokens to Button"
```

---

### Task 10: Input/Badge restyle pass — typography tokens

**Files:**
- Modify: `src/components/ui/input.tsx`, `src/components/ui/badge.tsx`, `src/components/ui/textarea.tsx`

**Interfaces:**
- None new — token application only, no API changes.

- [ ] **Step 1: Update `input.tsx`**

Change `text-base` / `md:text-sm` to the new scale — in `src/components/ui/input.tsx`, replace:

```tsx
"h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-base transition-colors outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 md:text-sm dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
```

with:

```tsx
"h-8 w-full min-w-0 rounded-lg border border-input bg-transparent px-2.5 py-1 text-body transition-colors duration-(--duration-fast) ease-(--ease-standard) outline-none file:inline-flex file:h-6 file:border-0 file:bg-transparent file:text-body-sm file:font-medium file:text-foreground placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50 disabled:pointer-events-none disabled:cursor-not-allowed disabled:bg-input/50 disabled:opacity-50 aria-invalid:border-destructive aria-invalid:ring-3 aria-invalid:ring-destructive/20 dark:bg-input/30 dark:disabled:bg-input/80 dark:aria-invalid:border-destructive/50 dark:aria-invalid:ring-destructive/40",
```

(dropped the redundant `md:text-sm` now that `text-body` is already a fixed, non-Tailwind-breakpoint-dependent size — this matches current visual size closely enough that no layout shift results, since 0.9375rem ≈ the previous 14px `text-sm` at desktop widths.)

- [ ] **Step 2: Update `badge.tsx`**

In `src/components/ui/badge.tsx`, change the base `text-xs` to `text-label` in the `badgeVariants` base string:

```tsx
"group/badge inline-flex h-5 w-fit shrink-0 items-center justify-center gap-1 overflow-hidden rounded-md border border-transparent px-2 py-0.5 text-label whitespace-nowrap transition-all duration-(--duration-fast) focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 has-data-[icon=inline-end]:pr-1.5 has-data-[icon=inline-start]:pl-1.5 aria-invalid:border-destructive aria-invalid:ring-destructive/20 dark:aria-invalid:ring-destructive/40 [&>svg]:pointer-events-none [&>svg]:size-3!",
```

- [ ] **Step 3: Check `textarea.tsx` for the same pattern and align it**

Read `src/components/ui/textarea.tsx` first (not yet inspected in this plan's research — it mirrors `input.tsx`'s shape per the existing codebase pattern). Apply the same `text-base`/`text-sm` → `text-body` substitution found there, keeping every other class unchanged.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

```bash
git add src/components/ui/input.tsx src/components/ui/badge.tsx src/components/ui/textarea.tsx
git commit -m "feat: apply typography tokens to Input, Badge, Textarea"
```

---

### Task 11: Dialog/AlertDialog/Sheet/DropdownMenu — motion + elevation pass

**Files:**
- Modify: `src/components/ui/dialog.tsx`, `src/components/ui/alert-dialog.tsx`, `src/components/ui/sheet.tsx`, `src/components/ui/dropdown-menu.tsx`

**Interfaces:**
- None new — replaces each file's ad hoc `duration-100`/`duration-200 ease-in-out` with the shared motion tokens.

- [ ] **Step 1: `dialog.tsx`**

In `src/components/ui/dialog.tsx`, `DialogOverlay`'s className: replace `duration-100` with `duration-(--duration-fast)`. `DialogContent`'s className: replace `duration-100` with `duration-(--duration-base) ease-(--ease-standard)`.

- [ ] **Step 2: `alert-dialog.tsx`**

Read `src/components/ui/alert-dialog.tsx` (mirrors `dialog.tsx`'s structure) and apply the identical `duration-100` → `duration-(--duration-fast)` / `duration-(--duration-base) ease-(--ease-standard)` substitutions to its overlay/content classNames.

- [ ] **Step 3: `sheet.tsx`**

In `src/components/ui/sheet.tsx`, `SheetOverlay`'s className: replace `duration-150` with `duration-(--duration-fast)`. `SheetContent`'s className: replace `duration-200 ease-in-out` with `duration-(--duration-slow) ease-(--ease-standard)`.

- [ ] **Step 4: `dropdown-menu.tsx`**

In `src/components/ui/dropdown-menu.tsx`, both `DropdownMenuContent` and `DropdownMenuSubContent` classNames use `duration-100`; replace with `duration-(--duration-base) ease-(--ease-standard)`.

- [ ] **Step 5: Verify and commit**

```bash
npx vitest run
npx tsc --noEmit
```

In the browser tool, open a dropdown (e.g. the sort control on a populated workspace) and the cleanup dialog, confirm they still open/close smoothly with no visual regression, just the updated timing curve.

```bash
git add src/components/ui/dialog.tsx src/components/ui/alert-dialog.tsx src/components/ui/sheet.tsx src/components/ui/dropdown-menu.tsx
git commit -m "feat: apply shared motion tokens to overlay components"
```

---

### Task 12: Toast restyle

**Files:**
- Modify: `src/components/ui/sonner.tsx`

**Interfaces:**
- None new.

- [ ] **Step 1: Read the current file and align its theme/tokens**

Read `src/components/ui/sonner.tsx`. It wraps `sonner`'s `Toaster` — confirm it already passes `theme` and CSS-variable overrides consistent with `--popover`/`--popover-foreground`/`--border`. If it hardcodes colors instead of referencing the token CSS variables, replace those hardcoded values with `var(--popover)`, `var(--popover-foreground)`, `var(--border)`, `var(--success)`, `var(--warning)`, `var(--danger)` (from Task 2) so success/error toasts pick up the new danger token instead of sonner's default red.

- [ ] **Step 2: Verify visually**

In the browser tool, trigger a toast (e.g. clear the workspace to see the storage-unavailable info toast, or run a cleanup to see a success toast) and confirm it uses the app's surface/border tokens rather than sonner's defaults.

- [ ] **Step 3: Commit**

```bash
git add src/components/ui/sonner.tsx
git commit -m "feat: align toast theme with design tokens"
```

---

## Phase 3 — Landing

### Task 13: TabInput status line — mono counts and refined focus

**Files:**
- Modify: `src/components/tab-input.tsx`

**Interfaces:**
- None new — visual-only change to the existing `TabInput` component; `onDump` prop signature is untouched here (Task 14 changes the submit flow).

- [ ] **Step 1: Apply the meta-mono token to the count status line**

In `src/components/tab-input.tsx`, change the status line's className from `text-xs text-tertiary` to use the mono metadata style for the count itself while keeping the helper text in body-sm:

```tsx
<div className="mt-2 flex min-h-5 items-center justify-between gap-4 text-tertiary">
  <span className="text-meta">
    {hasInput &&
      `${validCount} tab${validCount === 1 ? "" : "s"} detected${
        invalidCount > 0 ? ` · ${invalidCount} invalid` : ""
      }`}
  </span>
  <span className="text-right text-body-sm">
    Paste 20, 50, or even 100 tabs at once.
  </span>
</div>
```

- [ ] **Step 2: Verify and commit**

In the browser tool, paste a few URLs into the landing textarea and confirm the count now renders in the monospace numeral style while the helper text stays regular body text.

```bash
npx vitest run
npx tsc --noEmit
git add src/components/tab-input.tsx
git commit -m "feat: use monospace metadata style for the live tab count"
```

---

### Task 14: Organizing transition beat

**Files:**
- Modify: `src/components/tab-input.tsx`, `src/components/app-shell.tsx`

**Interfaces:**
- Consumes: nothing new.
- Produces: `TabInput` now shows a brief loading state on submit before calling `onDump`; `AppShell`'s `handleDump` is unchanged in signature but is now called after the deliberate delay rather than synchronously on click.

- [ ] **Step 1: Write the failing test**

```tsx
// Add to a new file: src/components/tab-input.test.tsx
import { describe, expect, it, vi } from "vitest"
import { render, screen, waitFor } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { TabInput } from "./tab-input"

describe("TabInput", () => {
  it("shows an Organizing state before calling onDump", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true })
    const user = userEvent.setup({
      advanceTimers: vi.advanceTimersByTime,
    })
    const onDump = vi.fn()
    render(<TabInput onDump={onDump} />)

    await user.type(
      screen.getByLabelText("Paste your tabs"),
      "https://github.com/a\nhttps://arxiv.org/b"
    )
    await user.click(screen.getByRole("button", { name: /Dump 2 tabs/ }))

    expect(screen.getByText(/Organizing 2 tabs/)).toBeInTheDocument()
    expect(onDump).not.toHaveBeenCalled()

    vi.advanceTimersByTime(600)
    await waitFor(() => expect(onDump).toHaveBeenCalledOnce())
    vi.useRealTimers()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/components/tab-input.test.tsx
```

Expected: FAIL — no "Organizing" state exists yet, `onDump` fires synchronously.

- [ ] **Step 3: Implement the transition beat**

```tsx
// src/components/tab-input.tsx
"use client"

import { useDeferredValue, useMemo, useState } from "react"
import { Textarea } from "@/components/ui/textarea"
import { Button } from "@/components/ui/button"
import { parseTabInput } from "@/lib/tabs"
import type { Tab } from "@/lib/tabs/types"

const ORGANIZING_DELAY_MS = 550

export function TabInput({ onDump }: { onDump?: (tabs: Tab[]) => void }) {
  const [raw, setRaw] = useState("")
  const [organizing, setOrganizing] = useState(false)
  const deferredRaw = useDeferredValue(raw)

  const { tabs, invalidCount } = useMemo(
    () => parseTabInput(deferredRaw),
    [deferredRaw]
  )

  const validCount = tabs.length
  const hasInput = raw.trim().length > 0

  const ctaLabel = organizing
    ? `Organizing ${validCount} tab${validCount === 1 ? "" : "s"}…`
    : validCount === 0
      ? "Dump my tabs →"
      : validCount === 1
        ? "Dump 1 tab →"
        : `Dump ${validCount} tabs →`

  function handleSubmit() {
    if (validCount === 0 || organizing) return
    setOrganizing(true)
    window.setTimeout(() => {
      onDump?.(tabs)
    }, ORGANIZING_DELAY_MS)
  }

  return (
    <div className="w-full">
      <Textarea
        aria-label="Paste your tabs"
        placeholder={
          "Paste your tabs here...\n\nhttps://github.com/...\nhttps://arxiv.org/...\nhttps://amazon.in/..."
        }
        rows={8}
        value={raw}
        onChange={(e) => setRaw(e.target.value)}
        disabled={organizing}
        className={
          "w-full resize-none text-left text-sm sm:text-base" +
          (validCount > 0 ? " border-primary/60" : "")
        }
      />

      <div className="mt-2 flex min-h-5 items-center justify-between gap-4 text-tertiary">
        <span className="text-meta">
          {hasInput &&
            `${validCount} tab${validCount === 1 ? "" : "s"} detected${
              invalidCount > 0 ? ` · ${invalidCount} invalid` : ""
            }`}
        </span>
        <span className="text-right text-body-sm">
          Paste 20, 50, or even 100 tabs at once.
        </span>
      </div>

      <Button
        size="lg"
        className="mt-6 w-full sm:w-auto"
        disabled={validCount === 0 || organizing}
        onClick={handleSubmit}
      >
        {ctaLabel}
      </Button>
    </div>
  )
}
```

`AppShell`'s `handleDump` needs no change — it already just receives the final `Tab[]` array via the `onDump` prop; the delay is entirely internal to `TabInput`.

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/components/tab-input.test.tsx
```

Expected: PASS.

- [ ] **Step 5: Manual verification in the browser tool**

Paste several URLs, click the CTA, confirm the button label switches to "Organizing N tabs…", the textarea disables, and after ~550ms the workspace view mounts.

- [ ] **Step 6: Run the full suite and commit**

```bash
npx vitest run
npx tsc --noEmit
git add src/components/tab-input.tsx src/components/tab-input.test.tsx
git commit -m "feat: add a brief Organizing transition beat before entering the workspace"
```

---

### Task 15: Landing responsive/motion verification

**Files:**
- Modify: `src/components/landing-view.tsx`, `src/components/hero-background.tsx` (only as needed to fix issues found)

**Interfaces:**
- None new — verification-only task closing out Phase 3.

- [ ] **Step 1: Resize-test the landing page**

Using the browser tool's `resize_window`, check 320, 375, 390, 768, 1024, 1440px widths on `http://localhost:3000`. Confirm: no horizontal scroll, headline wraps sensibly, textarea stays comfortably usable, CTA reachable, `HeroBackground`'s glow/grid never overlaps interactive text.

- [ ] **Step 2: Keyboard-navigation check**

Tab through the page: focus should move Header → Textarea → Button, each with a visible ring.

- [ ] **Step 3: Fix anything found, then commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
git add -A
git commit -m "fix: landing responsive and accessibility polish"
```

(Skip the commit if nothing needed changing.)

---

## Phase 4 — Workspace (primary focus)

### Task 16: Category hierarchy — sort/tier logic

**Files:**
- Create: `src/lib/workspace/hierarchy.ts`
- Test: `src/lib/workspace/hierarchy.test.ts`

**Interfaces:**
- Consumes: `CategoryId`, `CATEGORY_ORDER` from `@/lib/categories`, `Tab` from `@/lib/tabs/types`, `groupByCategory` from `./stats`.
- Produces: `type CategoryPresence = "large" | "standard" | "compact"`, `type CategoryHierarchyEntry = { id: CategoryId; tabs: Tab[]; presence: CategoryPresence }`, `orderCategoriesByPresence(tabs: Tab[]): CategoryHierarchyEntry[]` — consumed by Task 17 (`CategoryGrid`/`CategoryCard`).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/workspace/hierarchy.test.ts
import { describe, expect, it } from "vitest"
import { orderCategoriesByPresence } from "./hierarchy"
import type { Tab } from "@/lib/tabs/types"

function makeTabs(category: string, count: number): Tab[] {
  return Array.from({ length: count }, (_, i) => ({
    id: `${category}-${i}`,
    url: `https://example.com/${category}/${i}`,
    normalizedUrl: `https://example.com/${category}/${i}`,
    domain: "example.com",
    category,
  }))
}

describe("orderCategoriesByPresence", () => {
  it("sorts categories by tab count descending", () => {
    const tabs = [
      ...makeTabs("research", 2),
      ...makeTabs("projects", 8),
      ...makeTabs("news", 1),
    ]
    const result = orderCategoriesByPresence(tabs)
    const nonEmptyIds = result.filter((e) => e.tabs.length > 0).map((e) => e.id)
    expect(nonEmptyIds[0]).toBe("projects")
    expect(nonEmptyIds[1]).toBe("research")
    expect(nonEmptyIds[2]).toBe("news")
  })

  it("always pins other last regardless of count", () => {
    const tabs = [...makeTabs("other", 20), ...makeTabs("research", 1)]
    const result = orderCategoriesByPresence(tabs)
    expect(result[result.length - 1].id).toBe("other")
  })

  it("marks the highest-count categories as large, empty ones as compact", () => {
    const tabs = [...makeTabs("projects", 10), ...makeTabs("research", 9)]
    const result = orderCategoriesByPresence(tabs)
    const byId = Object.fromEntries(result.map((e) => [e.id, e.presence]))
    expect(byId.projects).toBe("large")
    expect(byId.research).toBe("large")
    expect(byId["read-later"]).toBe("compact")
  })

  it("includes every category exactly once, even with no tabs", () => {
    const result = orderCategoriesByPresence([])
    expect(result).toHaveLength(8)
    expect(result.every((e) => e.presence === "compact")).toBe(true)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/lib/workspace/hierarchy.test.ts
```

Expected: FAIL — `./hierarchy` does not exist.

- [ ] **Step 3: Implement `hierarchy.ts`**

```ts
// src/lib/workspace/hierarchy.ts
import { CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import { groupByCategory } from "./stats"

export type CategoryPresence = "large" | "standard" | "compact"

export type CategoryHierarchyEntry = {
  id: CategoryId
  tabs: Tab[]
  presence: CategoryPresence
}

const LARGE_SHARE_THRESHOLD = 0.2
const COMPACT_MAX_COUNT = 1

export function orderCategoriesByPresence(tabs: Tab[]): CategoryHierarchyEntry[] {
  const groups = groupByCategory(tabs)
  const total = tabs.length

  const ordered = CATEGORY_ORDER.filter((id) => id !== "other").sort(
    (a, b) => groups[b].length - groups[a].length
  )
  ordered.push("other")

  return ordered.map((id): CategoryHierarchyEntry => {
    const categoryTabs = groups[id]
    const count = categoryTabs.length
    const share = total > 0 ? count / total : 0

    let presence: CategoryPresence = "standard"
    if (count <= COMPACT_MAX_COUNT) presence = "compact"
    else if (share >= LARGE_SHARE_THRESHOLD) presence = "large"

    return { id, tabs: categoryTabs, presence }
  })
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/lib/workspace/hierarchy.test.ts
```

Expected: all PASS. (The 10-vs-9 test case: total is 19 tabs across 2 non-empty categories since all others are empty/compact; 10/19 ≈ 0.53 and 9/19 ≈ 0.47, both above the 0.2 threshold, so both land on `"large"` as asserted.)

- [ ] **Step 5: Commit**

```bash
git add src/lib/workspace/hierarchy.ts src/lib/workspace/hierarchy.test.ts
git commit -m "feat: add category presence hierarchy (sort by count, tier by share)"
```

---

### Task 17: CategoryGrid/CategoryCard — tiered redesign

**Files:**
- Modify: `src/components/workspace/category-grid.tsx`, `src/components/workspace/category-card.tsx`

**Interfaces:**
- Consumes: `orderCategoriesByPresence`, `CategoryHierarchyEntry` from Task 16.
- Produces: `CategoryCard` now takes a `presence: CategoryPresence` prop in addition to its existing `categoryId`/`tabs`/`onViewAll` props.

- [ ] **Step 1: Update `CategoryGrid` to use the hierarchy**

```tsx
// src/components/workspace/category-grid.tsx
"use client"

import { useState } from "react"
import { CategoryCard } from "@/components/workspace/category-card"
import { CategorySheet } from "@/components/workspace/category-sheet"
import { orderCategoriesByPresence } from "@/lib/workspace/hierarchy"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategoryGrid({
  tabs,
  onCategoryChange,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null)
  const entries = orderCategoriesByPresence(tabs)
  const groupsById = Object.fromEntries(entries.map((e) => [e.id, e.tabs]))

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry) => (
          <CategoryCard
            key={entry.id}
            categoryId={entry.id}
            tabs={entry.tabs}
            presence={entry.presence}
            onViewAll={() => setOpenCategory(entry.id)}
          />
        ))}
      </div>

      <CategorySheet
        categoryId={openCategory}
        tabs={openCategory ? groupsById[openCategory] : []}
        open={openCategory !== null}
        onOpenChange={(open) => !open && setOpenCategory(null)}
        onCategoryChange={onCategoryChange}
      />
    </>
  )
}
```

- [ ] **Step 2: Update `CategoryCard` for the three presence tiers**

```tsx
// src/components/workspace/category-card.tsx
import { ArrowRight } from "lucide-react"
import { cn } from "@/lib/utils"
import { CATEGORIES } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"
import type { CategoryPresence } from "@/lib/workspace/hierarchy"
import { representativeDomains } from "@/lib/workspace/stats"

export function CategoryCard({
  categoryId,
  tabs,
  presence,
  onViewAll,
}: {
  categoryId: CategoryId
  tabs: Tab[]
  presence: CategoryPresence
  onViewAll: () => void
}) {
  const def = CATEGORIES[categoryId]
  const Icon = def.icon
  const isEmpty = tabs.length === 0
  const domainLimit = presence === "large" ? 5 : presence === "standard" ? 3 : 0
  const domains = representativeDomains(tabs, domainLimit)

  if (presence === "compact") {
    return (
      <button
        type="button"
        onClick={isEmpty ? undefined : onViewAll}
        disabled={isEmpty}
        aria-label={
          isEmpty
            ? `${def.name}: no tabs`
            : `View all ${tabs.length} ${def.name} tab${tabs.length === 1 ? "" : "s"}`
        }
        className={cn(
          "flex items-center gap-2 rounded-lg border border-subtle px-3 py-2 text-left transition-colors",
          isEmpty
            ? "cursor-default opacity-45"
            : "bg-card hover:border-border"
        )}
      >
        <Icon
          className="size-3.5 shrink-0"
          style={{ color: `var(${def.accentColor})` }}
        />
        <span className="text-body-sm text-foreground">{def.name}</span>
        <span className="ml-auto text-meta text-tertiary">{tabs.length}</span>
      </button>
    )
  }

  return (
    <div
      className={cn(
        "flex flex-col gap-3 rounded-lg border border-subtle bg-card p-4",
        presence === "large" && "sm:col-span-2 lg:col-span-1 lg:row-span-1"
      )}
    >
      <div className="flex items-center gap-2">
        <Icon
          className="size-4 shrink-0"
          style={{ color: `var(${def.accentColor})` }}
        />
        <span className="text-body font-medium text-foreground">{def.name}</span>
        <span className="ml-auto text-meta text-tertiary">
          {tabs.length} tab{tabs.length === 1 ? "" : "s"}
        </span>
      </div>

      {domains.length > 0 && (
        <ul className="space-y-1">
          {domains.map((domain) => (
            <li key={domain} className="truncate text-body-sm text-muted-foreground">
              {domain}
            </li>
          ))}
        </ul>
      )}

      <button
        type="button"
        onClick={onViewAll}
        aria-label={`View all ${tabs.length} ${def.name} tab${tabs.length === 1 ? "" : "s"}`}
        className="mt-auto flex min-h-6 w-fit items-center gap-1 py-1 text-label text-accent-text hover:underline"
      >
        View all <ArrowRight className="size-3" />
      </button>
    </div>
  )
}
```

Empty (`presence === "compact"` with `tabs.length === 0`) categories now render as a single low-emphasis row with no click affordance, instead of a full card at 50% opacity — this directly answers "empty categories should be subdued or collapsed."

- [ ] **Step 3: Update the `CategoryGrid` test if one exists**

Check for `src/components/workspace/category-grid.test.tsx` — none was found in the initial codebase read, so no existing test needs updating. If `workspace-view.test.tsx` renders a populated `CategoryGrid` and asserts on card structure, run it now and adjust only assertions that reference the old fixed 8-card grid (e.g. an assertion counting exactly 8 identically-structured cards) to account for the compact-row variant; do not change assertions about tab counts/category names, only about DOM shape if they break.

- [ ] **Step 4: Verify and commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool, paste ~15 mixed URLs (as used in the audit) and confirm: populated categories are visually larger/more prominent, "Other" is always last, and any category with 0–1 tabs collapses to the compact row style.

```bash
git add src/components/workspace/category-grid.tsx src/components/workspace/category-card.tsx
git commit -m "feat: give categories visual hierarchy based on actual content"
```

---

### Task 18: AttentionStrip

**Files:**
- Create: `src/lib/workspace/attention.ts`
- Test: `src/lib/workspace/attention.test.ts`
- Create: `src/components/workspace/attention-strip.tsx`
- Modify: `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- Produces: `type Attention = { kind: "duplicates"; count: number } | { kind: "uncategorized"; count: number; share: number } | null`, `computeAttention(tabs: Tab[]): Attention` — consumed by `AttentionStrip`.
- Produces: `<AttentionStrip attention={Attention} onCleanup={() => void} onViewOther={() => void} />` — consumed by `WorkspaceView`.

- [ ] **Step 1: Write the failing lib tests**

```ts
// src/lib/workspace/attention.test.ts
import { describe, expect, it } from "vitest"
import { computeAttention } from "./attention"
import type { Tab } from "@/lib/tabs/types"

function makeTab(overrides: Partial<Tab>): Tab {
  return {
    id: overrides.id ?? Math.random().toString(),
    url: "https://example.com",
    normalizedUrl: "https://example.com",
    domain: "example.com",
    ...overrides,
  }
}

describe("computeAttention", () => {
  it("returns null when there is nothing to flag", () => {
    const tabs = [
      makeTab({ id: "1", category: "research" }),
      makeTab({ id: "2", category: "projects" }),
    ]
    expect(computeAttention(tabs)).toBeNull()
  })

  it("flags duplicates when present, taking priority over uncategorized share", () => {
    const tabs = [
      makeTab({ id: "1", isDuplicate: true }),
      makeTab({ id: "2", isDuplicate: true }),
      makeTab({ id: "3" }),
    ]
    expect(computeAttention(tabs)).toEqual({ kind: "duplicates", count: 2 })
  })

  it("flags a disproportionate other/uncategorized share when no duplicates exist", () => {
    const tabs = [
      makeTab({ id: "1", category: "other" }),
      makeTab({ id: "2", category: "other" }),
      makeTab({ id: "3", category: "other" }),
      makeTab({ id: "4", category: "research" }),
    ]
    const result = computeAttention(tabs)
    expect(result?.kind).toBe("uncategorized")
    expect(result).toMatchObject({ kind: "uncategorized", count: 3 })
  })

  it("does not flag a small other share", () => {
    const tabs = [
      makeTab({ id: "1", category: "other" }),
      makeTab({ id: "2", category: "research" }),
      makeTab({ id: "3", category: "research" }),
      makeTab({ id: "4", category: "research" }),
    ]
    expect(computeAttention(tabs)).toBeNull()
  })
})
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/workspace/attention.test.ts
```

Expected: FAIL — `./attention` does not exist.

- [ ] **Step 3: Implement `attention.ts`**

```ts
// src/lib/workspace/attention.ts
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export type Attention =
  | { kind: "duplicates"; count: number }
  | { kind: "uncategorized"; count: number; share: number }
  | null

const UNCATEGORIZED_SHARE_THRESHOLD = 0.5
const UNCATEGORIZED_MIN_COUNT = 3

function categoryOf(tab: Tab): CategoryId {
  return (tab.category as CategoryId | undefined) ?? "other"
}

export function computeAttention(tabs: Tab[]): Attention {
  const duplicateCount = tabs.filter((t) => t.isDuplicate).length
  if (duplicateCount > 0) {
    return { kind: "duplicates", count: duplicateCount }
  }

  const total = tabs.length
  if (total === 0) return null

  const otherCount = tabs.filter((t) => categoryOf(t) === "other").length
  const share = otherCount / total

  if (otherCount >= UNCATEGORIZED_MIN_COUNT && share >= UNCATEGORIZED_SHARE_THRESHOLD) {
    return { kind: "uncategorized", count: otherCount, share }
  }

  return null
}
```

- [ ] **Step 4: Run and confirm the lib tests pass**

```bash
npx vitest run src/lib/workspace/attention.test.ts
```

Expected: PASS.

- [ ] **Step 5: Build the `AttentionStrip` component**

```tsx
// src/components/workspace/attention-strip.tsx
import { AlertCircle } from "lucide-react"
import { Button } from "@/components/ui/button"
import type { Attention } from "@/lib/workspace/attention"

export function AttentionStrip({
  attention,
  onCleanup,
  onViewOther,
}: {
  attention: Attention
  onCleanup: () => void
  onViewOther: () => void
}) {
  if (!attention) return null

  const { message, actionLabel, onAction } =
    attention.kind === "duplicates"
      ? {
          message: `${attention.count} duplicate tab${attention.count === 1 ? "" : "s"} found.`,
          actionLabel: "Clean up",
          onAction: onCleanup,
        }
      : {
          message: `${attention.count} tabs landed in "Other" — TabDump wasn't confident where they belong.`,
          actionLabel: "Review Other",
          onAction: onViewOther,
        }

  return (
    <div className="flex items-center gap-2 rounded-lg border border-subtle bg-primary/[0.06] px-3 py-2">
      <AlertCircle className="size-4 shrink-0 text-accent-text" aria-hidden />
      <p className="text-body-sm text-foreground">{message}</p>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto shrink-0"
        onClick={onAction}
      >
        {actionLabel}
      </Button>
    </div>
  )
}
```

- [ ] **Step 6: Wire it into `WorkspaceView`**

In `src/components/workspace/workspace-view.tsx`, import `computeAttention` from `@/lib/workspace/attention` and `AttentionStrip`, compute `const attention = useMemo(() => computeAttention(tabs), [tabs])`, and render `<AttentionStrip attention={attention} onCleanup={() => setCleanupOpen(true)} onViewOther={() => handleCategoryFilter("other")} />` immediately above `<WorkspaceOverview tabs={tabs} />` inside `<main>`.

- [ ] **Step 7: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool, paste the same 15-URL sample plus two duplicate entries of an existing URL, confirm the attention strip appears above the stats with a "Clean up" action that opens the existing `CleanupDialog`.

```bash
git add src/lib/workspace/attention.ts src/lib/workspace/attention.test.ts src/components/workspace/attention-strip.tsx src/components/workspace/workspace-view.tsx
git commit -m "feat: add conditional attention strip surfacing duplicates and uncategorized tabs"
```

---

### Task 19: Stats row redesign + count-up

**Files:**
- Create: `src/hooks/use-count-up.ts`
- Test: `src/hooks/use-count-up.test.ts`
- Modify: `src/components/workspace/workspace-overview.tsx`

**Interfaces:**
- Produces: `useCountUp(target: number, options?: { durationMs?: number }): number` — a hook that animates from its previous value to `target` (or reduced-motion: jumps immediately), consumed by `WorkspaceOverview`.

- [ ] **Step 1: Write the failing hook test**

```ts
// src/hooks/use-count-up.test.ts
import { describe, expect, it, vi, afterEach } from "vitest"
import { renderHook, act } from "@testing-library/react"
import { useCountUp } from "./use-count-up"

describe("useCountUp", () => {
  afterEach(() => {
    vi.useRealTimers()
  })

  it("starts at 0 and animates toward the target over time", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 100 },
    })
    expect(result.current).toBe(0)

    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender({ target: 100 })
    expect(result.current).toBe(100)
  })

  it("does not re-animate when the target is unchanged across renders", () => {
    vi.useFakeTimers()
    const { result, rerender } = renderHook(({ target }) => useCountUp(target), {
      initialProps: { target: 5 },
    })
    act(() => {
      vi.advanceTimersByTime(1000)
    })
    rerender({ target: 5 })
    expect(result.current).toBe(5)
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/hooks/use-count-up.test.ts
```

Expected: FAIL — `./use-count-up` does not exist.

- [ ] **Step 3: Implement the hook**

```ts
// src/hooks/use-count-up.ts
"use client"

import { useEffect, useRef, useState } from "react"

export function useCountUp(target: number, options?: { durationMs?: number }): number {
  const durationMs = options?.durationMs ?? 500
  const [value, setValue] = useState(target === 0 ? 0 : 0)
  const previousTarget = useRef<number | null>(null)

  useEffect(() => {
    if (previousTarget.current === target) return
    previousTarget.current = target

    const prefersReducedMotion =
      typeof window !== "undefined" &&
      window.matchMedia?.("(prefers-reduced-motion: reduce)").matches

    if (prefersReducedMotion) {
      setValue(target)
      return
    }

    const start = performance.now()
    const from = 0
    let frame: number

    function tick(now: number) {
      const elapsed = now - start
      const progress = Math.min(1, elapsed / durationMs)
      const eased = 1 - Math.pow(1 - progress, 3)
      setValue(Math.round(from + (target - from) * eased))
      if (progress < 1) frame = requestAnimationFrame(tick)
    }

    frame = requestAnimationFrame(tick)
    return () => cancelAnimationFrame(frame)
  }, [target, durationMs])

  return value
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/hooks/use-count-up.test.ts
```

Expected: PASS. (`requestAnimationFrame` runs under fake timers via jsdom's polyfill already exercised elsewhere in this codebase's test setup; if it does not resolve within the advanced time in CI, fall back to asserting `result.current` is `> 0` and `<= target` rather than exactly `100`, but try the exact assertion first since it keeps the test meaningful.)

- [ ] **Step 5: Redesign `WorkspaceOverview` as a divided row using the hook**

```tsx
// src/components/workspace/workspace-overview.tsx
"use client"

import { computeOverview } from "@/lib/workspace/stats"
import { useCountUp } from "@/hooks/use-count-up"
import type { Tab } from "@/lib/tabs/types"

function Stat({ label, value }: { label: string; value: number }) {
  const animated = useCountUp(value)
  return (
    <div className="flex items-baseline gap-2 py-3 first:pl-0">
      <p className="text-h2 text-meta text-foreground">{animated}</p>
      <p className="text-label text-tertiary">{label}</p>
    </div>
  )
}

export function WorkspaceOverview({ tabs }: { tabs: Tab[] }) {
  const { total, unique, categoriesInUse, duplicates } = computeOverview(tabs)
  const stats = [
    { label: "total", value: total },
    { label: "unique", value: unique },
    { label: "categories", value: categoriesInUse },
    { label: "duplicates", value: duplicates },
  ]

  return (
    <div className="flex flex-wrap divide-x divide-subtle border-b border-subtle">
      {stats.map((stat) => (
        <div key={stat.label} className="pr-6 pl-6 first:pl-0">
          <Stat label={stat.label} value={stat.value} />
        </div>
      ))}
    </div>
  )
}
```

This replaces the previous 2×2/4-col equal-weight grid with a single divided row (dense, not card-like), matching "don't over-card the UI" — dividers and typography carry the structure instead of 4 bordered boxes.

- [ ] **Step 6: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool, dump a batch of tabs and confirm the stats row renders as a single divided line with numbers counting up from 0 on mount.

```bash
git add src/hooks/use-count-up.ts src/hooks/use-count-up.test.ts src/components/workspace/workspace-overview.tsx
git commit -m "feat: redesign stats as a divided row with count-up animation"
```

---

### Task 20: Tab list redesign — divider rows, hover-reveal actions

**Files:**
- Modify: `src/components/workspace/tab-card.tsx`, `src/components/workspace/filtered-tab-list.tsx`

**Interfaces:**
- `TabCard` keeps its existing props (`tab`, `onCategoryChange`) — this task is a visual restructure only, no new props (selection-mode props are added later in Task 24).

- [ ] **Step 1: Rewrite `TabCard` as a divider row instead of a bordered card**

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
    <div className="group flex items-center gap-3 border-b border-subtle px-1 py-2.5 last:border-b-0">
      <TabFavicon domain={tab.domain} />

      <div className="min-w-0 flex-1">
        <p className="truncate text-body font-medium text-foreground">{primaryLine}</p>
        <p className="truncate text-body-sm text-tertiary">{tab.domain}</p>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          nativeButton={false}
          render={
            <Badge
              variant="outline"
              aria-label={`Category: ${CATEGORIES[category].name}. Change category for ${tab.domain}`}
              className="hidden shrink-0 cursor-pointer sm:inline-flex"
            >
              {CATEGORIES[category].name}
            </Badge>
          }
        />
        <DropdownMenuContent align="end">
          {CATEGORY_ORDER.map((id) => (
            <DropdownMenuItem
              key={id}
              onClick={() => onCategoryChange(tab.id, id)}
            >
              {CATEGORIES[id].name}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>

      <div className="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity duration-(--duration-fast) group-hover:opacity-100 group-focus-within:opacity-100 has-data-open:opacity-100">
        <IconButton aria-label={`Open ${tab.domain}`} onClick={() => openTab(tab.url)}>
          <ExternalLink />
        </IconButton>

        <DropdownMenu>
          <DropdownMenuTrigger
            render={
              <IconButton aria-label={`More actions for ${tab.domain}`}>
                <MoreHorizontal />
              </IconButton>
            }
          />
          <DropdownMenuContent align="end">
            <DropdownMenuItem onClick={() => openTab(tab.url)}>Open</DropdownMenuItem>
            {CATEGORY_ORDER.map((id) => (
              <DropdownMenuItem
                key={id}
                onClick={() => onCategoryChange(tab.id, id)}
              >
                Move to {CATEGORIES[id].name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
    </div>
  )
}
```

Row chrome (border/radius/bg card) is gone; a hairline `border-b` between rows plus hover/focus-reveal on the action icons replaces it — matches "premium file/productivity list," not a stack of cards. `group-focus-within` and `has-data-open` keep the actions visible for keyboard users and while a dropdown from this row is open (not just mouse hover).

- [ ] **Step 2: Update `FilteredTabList` to remove its own per-item card wrapper**

```tsx
// src/components/workspace/filtered-tab-list.tsx
import { Search } from "lucide-react"
import { cn } from "@/lib/utils"
import { EmptyState } from "@/components/ui/empty-state"
import { TabCard } from "@/components/workspace/tab-card"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function FilteredTabList({
  tabs,
  highlightedIndex,
  onCategoryChange,
  onClearFilters,
}: {
  tabs: Tab[]
  highlightedIndex: number
  onCategoryChange: (id: string, category: CategoryId) => void
  onClearFilters?: () => void
}) {
  if (tabs.length === 0) {
    return (
      <EmptyState
        icon={Search}
        title="Nothing matches."
        description="Try a different search, or clear your filters."
        action={onClearFilters ? { label: "Clear filters", onClick: onClearFilters } : undefined}
      />
    )
  }

  return (
    <div className="rounded-lg border border-subtle bg-card px-2">
      {tabs.map((tab, index) => (
        <div
          key={tab.id}
          className={cn(index === highlightedIndex && "ring-2 ring-primary/50 rounded-md")}
        >
          <TabCard tab={tab} onCategoryChange={onCategoryChange} />
        </div>
      ))}
    </div>
  )
}
```

The list itself keeps exactly one outer surface (`bg-card` + `border-subtle`) — that's the "meaningful grouping" the brief allows; individual rows inside it no longer each carry their own card treatment.

- [ ] **Step 3: Wire `onClearFilters` from `WorkspaceView`**

In `src/components/workspace/workspace-view.tsx`, pass `onClearFilters={() => { setQuery(""); setCategoryFilter("all"); setSortKey("recent") }}` to `<FilteredTabList>`.

- [ ] **Step 4: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

Check `src/components/workspace/workspace-view.test.tsx` output carefully — if it asserts on the previous per-row `rounded-lg border` class of `TabCard`, update only that structural assertion, not any behavioral one.

In the browser tool: browse a populated workspace, hover a tab row and confirm the open/more icons fade in; search for something with no matches and confirm the new empty state with a working "Clear filters" button.

```bash
git add src/components/workspace/tab-card.tsx src/components/workspace/filtered-tab-list.tsx src/components/workspace/workspace-view.tsx
git commit -m "feat: redesign tab list as a dense divider-row list instead of per-row cards"
```

---

### Task 21: CategorySheet tuning

**Files:**
- Modify: `src/components/workspace/category-sheet.tsx`

**Interfaces:**
- None new.

- [ ] **Step 1: Apply the new typography tokens and an empty-state fallback**

```tsx
// src/components/workspace/category-sheet.tsx
import { Bookmark } from "lucide-react"
import {
  Sheet,
  SheetContent,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet"
import { ScrollArea } from "@/components/ui/scroll-area"
import { EmptyState } from "@/components/ui/empty-state"
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
      <SheetContent className="data-[side=right]:w-full sm:data-[side=right]:max-w-md">
        <SheetHeader>
          <SheetTitle className="text-h1">
            {def?.name} <span className="text-tertiary">· {tabs.length} tab{tabs.length === 1 ? "" : "s"}</span>
          </SheetTitle>
        </SheetHeader>
        {tabs.length === 0 ? (
          <EmptyState
            icon={Bookmark}
            title={`No tabs in ${def?.name ?? "this category"} anymore.`}
            description="They were recategorized or removed elsewhere in this session."
          />
        ) : (
          <ScrollArea className="h-[calc(100vh-6rem)] px-4">
            <div className="rounded-lg border border-subtle bg-card px-2 pb-6">
              {tabs.map((tab) => (
                <TabCard key={tab.id} tab={tab} onCategoryChange={onCategoryChange} />
              ))}
            </div>
          </ScrollArea>
        )}
      </SheetContent>
    </Sheet>
  )
}
```

- [ ] **Step 2: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool, open a category detail sheet from the workspace grid and confirm the new title styling and (if you recategorize every tab out of it while open) the empty state.

```bash
git add src/components/workspace/category-sheet.tsx
git commit -m "feat: tune category detail sheet typography and add its empty state"
```

---

### Task 22: WorkspaceHeader visual pass + Cmd+K hint chip

**Files:**
- Modify: `src/components/workspace/workspace-header.tsx`

**Interfaces:**
- Consumes: `Kbd` from Task 7 (rendered now as a static hint; Task 26 wires it to actually open the command palette once that exists).

- [ ] **Step 1: Apply typography tokens and add the shortcut hint**

```tsx
// src/components/workspace/workspace-header.tsx
"use client"

import { useState } from "react"
import { Sparkles, Trash2 } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Kbd } from "@/components/ui/kbd"
import { SearchBar } from "@/components/workspace/search-bar"
import { ExportMenu } from "@/components/workspace/export-menu"
import { ClearWorkspaceDialog } from "@/components/workspace/clear-workspace-dialog"
import type { Tab } from "@/lib/tabs/types"

export function WorkspaceHeader({
  tabs,
  searchValue,
  onSearch,
  onSearchArrowDown,
  onSearchArrowUp,
  onSearchEnter,
  onCleanup,
  onClear,
  onOpenPalette,
}: {
  tabs: Tab[]
  searchValue: string
  onSearch: (query: string) => void
  onSearchArrowDown?: () => void
  onSearchArrowUp?: () => void
  onSearchEnter?: () => void
  onCleanup: () => void
  onClear: () => void
  onOpenPalette?: () => void
}) {
  const [confirmOpen, setConfirmOpen] = useState(false)
  const tabCount = tabs.length

  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-3 px-6 py-4">
        <div className="mr-auto">
          <p className="text-body font-semibold tracking-tight text-foreground">TabDump</p>
          <p className="text-meta text-tertiary">
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

        {onOpenPalette && (
          <button
            type="button"
            onClick={onOpenPalette}
            className="hidden items-center gap-1.5 rounded-lg border border-subtle px-2 py-1 text-tertiary transition-colors hover:border-border hover:text-foreground md:inline-flex"
            aria-label="Open command palette"
          >
            <span className="text-label">Commands</span>
            <Kbd keys={["⌘", "K"]} />
          </button>
        )}

        <Button variant="ghost" size="sm" onClick={onCleanup}>
          <Sparkles /> Cleanup
        </Button>
        <ExportMenu tabs={tabs} />
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

`onOpenPalette` is optional and unused until Task 26 passes it down from `WorkspaceView` — this task only builds the visual hint chip so Phase 4's header work is complete before Phase 5 wires behavior.

- [ ] **Step 2: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
git add src/components/workspace/workspace-header.tsx
git commit -m "feat: apply typography tokens to workspace header, add command hint chip"
```

---

### Task 23: Phase 4 workspace QA checkpoint

**Files:**
- Modify: any file, only as needed to fix issues found.

**Interfaces:** none new.

- [ ] **Step 1: Full automated check**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

- [ ] **Step 2: Realistic-data visual check**

In the browser tool, paste a large, lopsided, duplicate-containing batch (40–60 URLs, several duplicates, most landing in 2–3 categories) and confirm: the attention strip, tiered category grid, divided stats row, and divider-row tab list all read clearly together — no leftover per-row card borders, no orphaned old styles.

- [ ] **Step 3: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: Phase 4 workspace visual QA polish"
```

(Skip the commit if nothing needed changing.)

---

## Phase 5 — Power-user UX

### Task 24: Install `cmdk`, build the CommandPalette shell

**Files:**
- Modify: `package.json` (dependency)
- Create: `src/components/command-palette/command-palette.tsx`
- Create: `src/components/command-palette/types.ts`
- Test: `src/components/command-palette/command-palette.test.tsx`

**Interfaces:**
- Produces: `type Command = { id: string; label: string; group: "Navigation" | "Selection" | "Actions" | "Sort" | "Help"; icon: LucideIcon; shortcut?: string[]; onSelect: () => void; disabled?: boolean }`, `<CommandPalette open={boolean} onOpenChange={(open: boolean) => void} commands={Command[]} />` — consumed by Task 25/26/27/28's command wiring and by `WorkspaceView`.

- [ ] **Step 1: Install the dependency**

```bash
npm install cmdk
```

- [ ] **Step 2: Define the `Command` type**

```ts
// src/components/command-palette/types.ts
import type { LucideIcon } from "lucide-react"

export type CommandGroup = "Navigation" | "Selection" | "Actions" | "Sort" | "Help"

export type Command = {
  id: string
  label: string
  group: CommandGroup
  icon: LucideIcon
  shortcut?: string[]
  onSelect: () => void
  disabled?: boolean
}
```

- [ ] **Step 3: Write the failing test**

```tsx
// src/components/command-palette/command-palette.test.tsx
import { describe, expect, it, vi } from "vitest"
import { render, screen } from "@testing-library/react"
import userEvent from "@testing-library/user-event"
import { Search, Trash2 } from "lucide-react"
import { CommandPalette } from "./command-palette"
import type { Command } from "./types"

function makeCommands(onSelectSearch: () => void, onSelectClear: () => void): Command[] {
  return [
    { id: "search", label: "Search tabs", group: "Navigation", icon: Search, onSelect: onSelectSearch },
    { id: "clear", label: "Clear workspace", group: "Actions", icon: Trash2, onSelect: onSelectClear },
  ]
}

describe("CommandPalette", () => {
  it("renders nothing when closed", () => {
    render(
      <CommandPalette open={false} onOpenChange={vi.fn()} commands={makeCommands(vi.fn(), vi.fn())} />
    )
    expect(screen.queryByPlaceholderText(/type a command/i)).not.toBeInTheDocument()
  })

  it("filters commands by typed query and runs the selected command on click", async () => {
    const user = userEvent.setup()
    const onSelectClear = vi.fn()
    const onOpenChange = vi.fn()
    render(
      <CommandPalette
        open
        onOpenChange={onOpenChange}
        commands={makeCommands(vi.fn(), onSelectClear)}
      />
    )

    const input = screen.getByPlaceholderText(/type a command/i)
    await user.type(input, "clear")

    expect(screen.queryByText("Search tabs")).not.toBeInTheDocument()
    const item = screen.getByText("Clear workspace")
    await user.click(item)

    expect(onSelectClear).toHaveBeenCalledOnce()
    expect(onOpenChange).toHaveBeenCalledWith(false)
  })

  it("groups commands under their group heading", () => {
    render(
      <CommandPalette
        open
        onOpenChange={vi.fn()}
        commands={makeCommands(vi.fn(), vi.fn())}
      />
    )
    expect(screen.getByText("Navigation")).toBeInTheDocument()
    expect(screen.getByText("Actions")).toBeInTheDocument()
  })
})
```

- [ ] **Step 4: Run it and confirm it fails**

```bash
npx vitest run src/components/command-palette/command-palette.test.tsx
```

Expected: FAIL — `./command-palette` does not exist.

- [ ] **Step 5: Implement the palette shell on `cmdk`**

```tsx
// src/components/command-palette/command-palette.tsx
"use client"

import { Command as CommandPrimitive } from "cmdk"
import { Kbd } from "@/components/ui/kbd"
import type { Command, CommandGroup } from "./types"

const GROUP_ORDER: CommandGroup[] = ["Navigation", "Selection", "Actions", "Sort", "Help"]

export function CommandPalette({
  open,
  onOpenChange,
  commands,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  commands: Command[]
}) {
  if (!open) return null

  function run(command: Command) {
    onOpenChange(false)
    command.onSelect()
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 px-4 pt-[15vh]"
      onClick={() => onOpenChange(false)}
    >
      <CommandPrimitive
        label="Command palette"
        className="w-full max-w-lg overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-lg ring-1 ring-foreground/10"
        onClick={(e) => e.stopPropagation()}
        shouldFilter
      >
        <CommandPrimitive.Input
          autoFocus
          placeholder="Type a command or search…"
          className="w-full border-b border-subtle bg-transparent px-4 py-3 text-body text-foreground placeholder:text-tertiary outline-none"
        />
        <CommandPrimitive.List className="max-h-[60vh] overflow-y-auto p-2">
          <CommandPrimitive.Empty className="py-6 text-center text-body-sm text-tertiary">
            No matching commands.
          </CommandPrimitive.Empty>
          {GROUP_ORDER.map((group) => {
            const groupCommands = commands.filter((c) => c.group === group)
            if (groupCommands.length === 0) return null
            return (
              <CommandPrimitive.Group
                key={group}
                heading={group}
                className="[&_[cmdk-group-heading]]:px-2 [&_[cmdk-group-heading]]:py-1.5 [&_[cmdk-group-heading]]:text-label [&_[cmdk-group-heading]]:text-tertiary"
              >
                {groupCommands.map((command) => (
                  <CommandPrimitive.Item
                    key={command.id}
                    value={`${command.label} ${command.group}`}
                    disabled={command.disabled}
                    onSelect={() => run(command)}
                    className="flex cursor-default items-center gap-2 rounded-md px-2 py-2 text-body text-foreground data-[selected=true]:bg-primary/15 data-[selected=true]:text-accent-text aria-disabled:opacity-40"
                  >
                    <command.icon className="size-4 shrink-0" aria-hidden />
                    <span className="flex-1">{command.label}</span>
                    {command.shortcut && <Kbd keys={command.shortcut} />}
                  </CommandPrimitive.Item>
                ))}
              </CommandPrimitive.Group>
            )
          })}
        </CommandPrimitive.List>
      </CommandPrimitive>
    </div>
  )
}
```

- [ ] **Step 6: Run the test and confirm it passes**

```bash
npx vitest run src/components/command-palette/command-palette.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json src/components/command-palette
git commit -m "feat: add cmdk-based command palette shell"
```

---

### Task 25: "Show duplicates" filter + Navigation commands wiring

**Files:**
- Modify: `src/lib/workspace/search.ts`
- Test: `src/lib/workspace/search.test.ts`
- Modify: `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- Produces: `filterTabs` gains an optional `duplicatesOnly?: boolean` option on its existing `opts` parameter — additive, so every current call site (which doesn't pass it) is unaffected.
- Produces: `WorkspaceView` gains internal `duplicatesOnly` state and a `commandPaletteOpen` state, plus a `navigationCommands` array wired into the (still-unrendered-here) `CommandPalette`.

- [ ] **Step 1: Write the failing test for the filter extension**

Append to `src/lib/workspace/search.test.ts` (read the existing file first to match its style/fixtures before appending):

```ts
describe("filterTabs duplicatesOnly", () => {
  it("returns only duplicate-flagged tabs when duplicatesOnly is set", () => {
    const tabs = [
      { id: "1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com", isDuplicate: false },
      { id: "2", url: "https://b.com", normalizedUrl: "https://b.com", domain: "b.com", isDuplicate: true },
    ] as Tab[]
    const result = filterTabs(tabs, { query: "", categoryId: "all", duplicatesOnly: true })
    expect(result).toHaveLength(1)
    expect(result[0].id).toBe("2")
  })

  it("combines with query and category filters", () => {
    const tabs = [
      { id: "1", url: "https://a.com", normalizedUrl: "https://a.com", domain: "a.com", isDuplicate: true, category: "research" },
      { id: "2", url: "https://b.com", normalizedUrl: "https://b.com", domain: "b.com", isDuplicate: true, category: "news" },
    ] as Tab[]
    const result = filterTabs(tabs, { query: "", categoryId: "research", duplicatesOnly: true })
    expect(result.map((t) => t.id)).toEqual(["1"])
  })
})
```

(Add `import type { Tab } from "@/lib/tabs/types"` to the test file's imports if it isn't already imported.)

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/lib/workspace/search.test.ts
```

Expected: FAIL — `filterTabs` doesn't accept `duplicatesOnly` yet (extra option is silently ignored by TS structurally only if the type allows it; since `opts` is a fixed object type today, this fails to type-check, which is the intended failure signal — confirm via `npx tsc --noEmit` as well as the runtime test).

- [ ] **Step 3: Implement the extension**

In `src/lib/workspace/search.ts`, change `filterTabs`'s signature and body:

```ts
export function filterTabs(
  tabs: Tab[],
  opts: { query: string; categoryId: CategoryId | "all"; duplicatesOnly?: boolean }
): Tab[] {
  return tabs.filter(
    (tab) =>
      matchesQuery(tab, opts.query) &&
      (opts.categoryId === "all" || categoryOf(tab) === opts.categoryId) &&
      (!opts.duplicatesOnly || Boolean(tab.isDuplicate))
  );
}
```

- [ ] **Step 4: Run the tests and confirm they pass**

```bash
npx vitest run src/lib/workspace/search.test.ts
npx tsc --noEmit
```

Expected: PASS.

- [ ] **Step 5: Wire `duplicatesOnly` and Navigation commands into `WorkspaceView`**

In `src/components/workspace/workspace-view.tsx`, add state and pass it through the existing `resultTabs` computation, and switch `isBrowsing` off when it's active:

```tsx
const [duplicatesOnly, setDuplicatesOnly] = useState(false)
const [commandPaletteOpen, setCommandPaletteOpen] = useState(false)

const isBrowsing =
  query.trim() === "" && categoryFilter === "all" && sortKey === "recent" && !duplicatesOnly

const resultTabs = useMemo(
  () => sortTabs(filterTabs(tabs, { query, categoryId: categoryFilter, duplicatesOnly }), sortKey),
  [tabs, query, categoryFilter, sortKey, duplicatesOnly]
)
```

Add a `navigationCommands` builder (still local to this file for now — Task 26/27/28 append more groups to the same array before it's finally passed to `<CommandPalette>` in Task 26's step). Import only the icons actually used:

```tsx
import { Search as SearchIcon, LayoutGrid, AlertCircle as DuplicatesIcon } from "lucide-react"
import type { Command } from "@/components/command-palette/types"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"

// inside WorkspaceView, before the return:
const navigationCommands: Command[] = [
  {
    id: "nav-search",
    label: "Search tabs",
    group: "Navigation",
    icon: SearchIcon,
    onSelect: () => document.getElementById("workspace-search-input")?.focus(),
  },
  {
    id: "nav-show-all",
    label: "Show all tabs",
    group: "Navigation",
    icon: LayoutGrid,
    onSelect: () => {
      setQuery("")
      setCategoryFilter("all")
      setDuplicatesOnly(false)
    },
  },
  {
    id: "nav-show-duplicates",
    label: "Show duplicates",
    group: "Navigation",
    icon: DuplicatesIcon,
    onSelect: () => {
      setQuery("")
      setCategoryFilter("all")
      setDuplicatesOnly(true)
    },
  },
  ...CATEGORY_ORDER.map((id): Command => ({
    id: `nav-category-${id}`,
    label: `Go to ${CATEGORIES[id].name}`,
    group: "Navigation",
    icon: CATEGORIES[id].icon,
    onSelect: () => {
      setQuery("")
      setDuplicatesOnly(false)
      setCategoryFilter(id)
    },
  })),
]
```

This task does not yet render `<CommandPalette>` (Task 26 assembles the full command list and renders it, and wires the Cmd+K shortcut) — it only establishes the filter capability and the first command group so Task 26's diff is additive, not a rewrite.

- [ ] **Step 6: Run the full suite and commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
git add src/lib/workspace/search.ts src/lib/workspace/search.test.ts src/components/workspace/workspace-view.tsx
git commit -m "feat: add duplicatesOnly filter and Navigation command list"
```

---

### Task 26: Action/Sort/Help commands + Cmd+K wiring, palette render

**Files:**
- Modify: `src/components/workspace/workspace-view.tsx`
- Create: `src/components/workspace/shortcuts-dialog.tsx`

**Interfaces:**
- Produces: `<ShortcutsDialog open onOpenChange />` listing the full shortcut system from the spec.
- `WorkspaceView` now renders `<CommandPalette>`, listens for Cmd/Ctrl+K, and passes `onOpenPalette` to `WorkspaceHeader` (from Task 22).

- [ ] **Step 1: Build the `ShortcutsDialog`**

```tsx
// src/components/workspace/shortcuts-dialog.tsx
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog"
import { Kbd } from "@/components/ui/kbd"

const SHORTCUTS: { keys: string[]; description: string }[] = [
  { keys: ["⌘", "K"], description: "Open the command palette" },
  { keys: ["/"], description: "Focus search" },
  { keys: ["Esc"], description: "Close the palette, a dialog, or exit selection mode" },
  { keys: ["↑", "↓"], description: "Move through results" },
  { keys: ["Enter"], description: "Open the highlighted tab, or run a command" },
  { keys: ["⌘", "A"], description: "Select all visible tabs (in selection mode)" },
]

export function ShortcutsDialog({
  open,
  onOpenChange,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="w-full sm:max-w-sm">
        <DialogHeader>
          <DialogTitle>Keyboard shortcuts</DialogTitle>
        </DialogHeader>
        <ul className="space-y-2">
          {SHORTCUTS.map((s) => (
            <li key={s.description} className="flex items-center justify-between gap-4">
              <span className="text-body-sm text-muted-foreground">{s.description}</span>
              <Kbd keys={s.keys} />
            </li>
          ))}
        </ul>
      </DialogContent>
    </Dialog>
  )
}
```

- [ ] **Step 2: Assemble Action/Sort/Help commands and render the palette in `WorkspaceView`**

In `src/components/workspace/workspace-view.tsx`, add `shortcutsOpen` state, import `CommandPalette`, `ShortcutsDialog`, `Download`/`FileText`/`ArrowUpDown`/`Keyboard`/`Sparkles`/`Trash2` icons as needed, build the remaining command groups, and render the palette:

```tsx
const actionCommands: Command[] = [
  {
    id: "action-cleanup",
    label: "Cleanup duplicates",
    group: "Actions",
    icon: Sparkles,
    onSelect: () => setCleanupOpen(true),
  },
  {
    id: "action-export-all",
    label: "Export all tabs",
    group: "Actions",
    icon: Download,
    onSelect: async () => {
      const ok = await copyText(urlsText(tabs))
      if (ok) toast.success(`Copied ${tabs.length} URL${tabs.length === 1 ? "" : "s"}`)
      else toast.error("Couldn't copy to clipboard")
    },
  },
  ...CATEGORY_ORDER.map((id): Command => ({
    id: `action-export-${id}`,
    label: `Export ${CATEGORIES[id].name}`,
    group: "Actions",
    icon: Download,
    disabled: (categoryCounts(tabs)[id] ?? 0) === 0,
    onSelect: async () => {
      const categoryTabs = tabs.filter((t) => ((t.category as CategoryId | undefined) ?? "other") === id)
      const ok = await copyText(urlsText(categoryTabs))
      if (ok) toast.success(`Copied ${categoryTabs.length} URL${categoryTabs.length === 1 ? "" : "s"}`)
      else toast.error("Couldn't copy to clipboard")
    },
  })),
  {
    id: "action-clear",
    label: "Clear workspace",
    group: "Actions",
    icon: Trash2,
    onSelect: () => setClearConfirmOpen(true),
  },
]

const sortCommands: Command[] = (["recent", "title", "domain", "category"] as const).map((key) => ({
  id: `sort-${key}`,
  label: `Sort by ${key === "recent" ? "recently added" : key}`,
  group: "Sort",
  icon: ArrowUpDown,
  onSelect: () => handleSort(key),
}))

const helpCommands: Command[] = [
  {
    id: "help-shortcuts",
    label: "Keyboard shortcuts",
    group: "Help",
    icon: Keyboard,
    onSelect: () => setShortcutsOpen(true),
  },
]

const allCommands = [...navigationCommands, ...actionCommands, ...sortCommands, ...helpCommands]
```

`copyText`/`urlsText`/`categoryCounts` are already imported in `export-menu.tsx` from `@/lib/workspace/export` and `@/lib/workspace/search` respectively — import the same functions here rather than duplicating logic. "Clear workspace" opens a confirm the same way the header's Clear button does today: add a `clearConfirmOpen` state and render the existing `ClearWorkspaceDialog` a second time driven by it, OR (simpler, avoids a duplicate dialog instance) lift `ClearWorkspaceDialog`'s open state out of `WorkspaceHeader` into `WorkspaceView` in this same step so both the header's Clear button and the palette's command drive the same dialog instance — do this: remove the internal `confirmOpen` state from `WorkspaceHeader` (Task 22's version), change its `onClear` prop usage so the button just calls a new `onRequestClear` prop, and own `clearConfirmOpen`/`ClearWorkspaceDialog` in `WorkspaceView` alongside `cleanupOpen`.

Render at the bottom of `WorkspaceView`'s JSX, alongside the existing `CleanupDialog`:

```tsx
<CommandPalette
  open={commandPaletteOpen}
  onOpenChange={setCommandPaletteOpen}
  commands={allCommands}
/>
<ShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
<ClearWorkspaceDialog
  open={clearConfirmOpen}
  onOpenChange={setClearConfirmOpen}
  onConfirm={() => {
    setClearConfirmOpen(false)
    onClear()
  }}
/>
```

And pass `onOpenPalette={() => setCommandPaletteOpen(true)}` and `onRequestClear={() => setClearConfirmOpen(true)}` to `<WorkspaceHeader>` (update `WorkspaceHeader`'s props accordingly, replacing its old internal `confirmOpen` state and its own `<ClearWorkspaceDialog>` render with a call to the new `onRequestClear` prop on the Clear button's `onClick`).

- [ ] **Step 3: Wire the Cmd/Ctrl+K shortcut**

Extend the existing `useEffect` keydown listener already in `WorkspaceView` (currently only handling Cmd/Ctrl+K to focus search) to instead open the palette:

```tsx
useEffect(() => {
  function handleKeyDown(e: KeyboardEvent) {
    if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === "k") {
      e.preventDefault()
      setCommandPaletteOpen(true)
    }
  }
  window.addEventListener("keydown", handleKeyDown)
  return () => window.removeEventListener("keydown", handleKeyDown)
}, [])
```

(This replaces the previous behavior of focusing the search input directly — the palette's own "Search tabs" command now covers that path, and typing in the palette is itself a fast search entry point.)

- [ ] **Step 4: Update or add tests covering the new Cmd+K behavior**

Check `src/components/workspace/workspace-view.test.tsx` for an existing assertion that Cmd+K focuses the search input directly; if present, update it to assert the command palette opens instead (`screen.getByPlaceholderText(/type a command/i)` becomes visible after firing the keydown event).

- [ ] **Step 5: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool: press Cmd/Ctrl+K on a populated workspace, confirm the palette opens with grouped commands; type "duplicates," select "Show duplicates," confirm the list filters; open the palette again and run "Keyboard shortcuts," confirm the shortcuts dialog appears.

```bash
git add src/components/workspace/workspace-view.tsx src/components/workspace/workspace-header.tsx src/components/workspace/shortcuts-dialog.tsx
git commit -m "feat: wire full command set into the palette and open it with Cmd/Ctrl+K"
```

---

### Task 27: Selection mode state + SelectionToolbar + row checkboxes

**Files:**
- Create: `src/components/workspace/selection-toolbar.tsx`
- Modify: `src/components/workspace/tab-card.tsx`, `src/components/workspace/filtered-tab-list.tsx`, `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- `TabCard` gains optional props: `selectable?: boolean`, `selected?: boolean`, `onToggleSelected?: () => void` (all optional so Task 20's existing usages without these props still compile and render exactly as before).
- Produces: `<SelectionToolbar count={number} onRecategorize={(id: CategoryId) => void} onExportSelected={() => void} onOpenSelected={() => void} onRemoveSelected={() => void} onClear={() => void} />`.

- [ ] **Step 1: Add selection props to `TabCard`**

In `src/components/workspace/tab-card.tsx`, extend the props and render a checkbox when `selectable` is true:

```tsx
import { Checkbox } from "@/components/ui/checkbox"
// ...existing imports

export function TabCard({
  tab,
  onCategoryChange,
  selectable = false,
  selected = false,
  onToggleSelected,
}: {
  tab: Tab
  onCategoryChange: (id: string, category: CategoryId) => void
  selectable?: boolean
  selected?: boolean
  onToggleSelected?: () => void
}) {
  const category = (tab.category as CategoryId | undefined) ?? "other"
  const primaryLine = tab.title?.trim() || tab.domain

  return (
    <div className="group flex items-center gap-3 border-b border-subtle px-1 py-2.5 last:border-b-0">
      {selectable && (
        <Checkbox
          checked={selected}
          onCheckedChange={() => onToggleSelected?.()}
          aria-label={`Select ${tab.domain}`}
        />
      )}

      <TabFavicon domain={tab.domain} />
      {/* ...rest unchanged from Task 20's version... */}
```

(Everything below the favicon in the JSX stays exactly as Task 20 left it — only the props signature and the new conditional `Checkbox` at the top of the row are added here.)

- [ ] **Step 2: Build `SelectionToolbar`**

```tsx
// src/components/workspace/selection-toolbar.tsx
import { Download, ExternalLink, Trash2, X } from "lucide-react"
import { Button } from "@/components/ui/button"
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu"
import { CATEGORIES, CATEGORY_ORDER } from "@/lib/categories"
import type { CategoryId } from "@/lib/categories"

export function SelectionToolbar({
  count,
  onRecategorize,
  onExportSelected,
  onOpenSelected,
  onRemoveSelected,
  onClear,
}: {
  count: number
  onRecategorize: (id: CategoryId) => void
  onExportSelected: () => void
  onOpenSelected: () => void
  onRemoveSelected: () => void
  onClear: () => void
}) {
  return (
    <div className="sticky top-0 z-10 flex items-center gap-2 rounded-lg border border-primary/30 bg-primary/[0.08] px-3 py-2">
      <span className="text-body font-medium text-foreground">
        {count} selected
      </span>

      <div className="ml-auto flex items-center gap-1.5">
        <DropdownMenu>
          <DropdownMenuTrigger
            render={<Button variant="ghost" size="sm">Recategorize</Button>}
          />
          <DropdownMenuContent align="end">
            {CATEGORY_ORDER.map((id) => (
              <DropdownMenuItem key={id} onClick={() => onRecategorize(id)}>
                {CATEGORIES[id].name}
              </DropdownMenuItem>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>

        <Button variant="ghost" size="sm" onClick={onExportSelected}>
          <Download /> Export
        </Button>
        <Button variant="ghost" size="sm" onClick={onOpenSelected}>
          <ExternalLink /> Open
        </Button>
        <Button variant="destructive" size="sm" onClick={onRemoveSelected}>
          <Trash2 /> Remove
        </Button>
        <Button variant="ghost" size="sm" onClick={onClear}>
          <X /> Clear selection
        </Button>
      </div>
    </div>
  )
}
```

- [ ] **Step 3: Wire selection state into `WorkspaceView` and `FilteredTabList`/`CategoryGrid` consumers**

In `src/components/workspace/workspace-view.tsx`, add:

```tsx
const [selectionMode, setSelectionMode] = useState(false)
const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())

function toggleSelected(id: string) {
  setSelectedIds((prev) => {
    const next = new Set(prev)
    if (next.has(id)) next.delete(id)
    else next.add(id)
    return next
  })
}

function exitSelectionMode() {
  setSelectionMode(false)
  setSelectedIds(new Set())
}
```

Pass `selectable={selectionMode}`, `selected={selectedIds.has(tab.id)}`, `onToggleSelected={() => toggleSelected(tab.id)}` through to `FilteredTabList`, which forwards the same three props straight through to each `TabCard` (extend `FilteredTabList`'s props and JSX accordingly, mirroring Task 20's structure — this is category-detail/search-results selection; Task 27 scope stops at the flat list, `CategoryGrid`'s browse-mode cards are not individually selectable, matching that selection is a search/list-view feature).

The toolbar's handlers are implemented in Step 4 below before it is rendered — implement Step 4 first, then come back and render it in `WorkspaceView`'s JSX, immediately above `<FilteredTabList>`/`<CategoryGrid>`:

```tsx
{selectionMode && selectedIds.size > 0 && (
  <div className="mb-3">
    <SelectionToolbar
      count={selectedIds.size}
      onRecategorize={handleRecategorizeSelected}
      onExportSelected={handleExportSelected}
      onOpenSelected={handleOpenSelected}
      onRemoveSelected={handleRemoveSelected}
      onClear={exitSelectionMode}
    />
  </div>
)}
```

- [ ] **Step 4: Implement the bulk-action handlers referenced above**

```tsx
function handleRecategorizeSelected(category: CategoryId) {
  const ids = selectedIds
  onTabsChange(tabs.map((t) => (ids.has(t.id) ? { ...t, category } : t)))
  toast.success(`Recategorized ${ids.size} tab${ids.size === 1 ? "" : "s"} to ${CATEGORIES[category].name}`)
  exitSelectionMode()
}

async function handleExportSelected() {
  const selected = tabs.filter((t) => selectedIds.has(t.id))
  const ok = await copyText(urlsText(selected))
  if (ok) toast.success(`Copied ${selected.length} URL${selected.length === 1 ? "" : "s"}`)
  else toast.error("Couldn't copy to clipboard")
}

const OPEN_SELECTED_CONFIRM_THRESHOLD = 10
function handleOpenSelected() {
  const selected = tabs.filter((t) => selectedIds.has(t.id))
  if (selected.length > OPEN_SELECTED_CONFIRM_THRESHOLD) {
    setOpenSelectedConfirmOpen(true)
    return
  }
  selected.forEach((t) => window.open(t.url, "_blank", "noopener,noreferrer"))
}

function handleRemoveSelected() {
  const remaining = removeTabs(tabs, Array.from(selectedIds))
  onTabsChange(remaining)
  toast.success(`Removed ${selectedIds.size} tab${selectedIds.size === 1 ? "" : "s"}.`)
  exitSelectionMode()
}
```

Add an `openSelectedConfirmOpen` state and a small `AlertDialog` (reuse the pattern already established by `ClearWorkspaceDialog`) that confirms before opening more than `OPEN_SELECTED_CONFIRM_THRESHOLD` tabs at once, calling the actual `window.open` loop on confirm.

- [ ] **Step 5: Add a "Select" entry point and the Selection command group**

Add a small text-button ("Select") next to `CategoryFilterBar`/`SortControl` in `WorkspaceView`'s JSX that calls `setSelectionMode(true)`, and add to `navigationCommands`/a new `selectionCommands` array (merged into `allCommands` alongside the groups built in Task 26):

```tsx
const selectionCommands: Command[] = [
  {
    id: "selection-toggle",
    label: selectionMode ? "Exit selection mode" : "Select tabs",
    group: "Selection",
    icon: CheckSquare,
    onSelect: () => (selectionMode ? exitSelectionMode() : setSelectionMode(true)),
  },
  {
    id: "selection-select-all",
    label: "Select all visible",
    group: "Selection",
    icon: CheckSquare,
    disabled: !selectionMode,
    onSelect: () => setSelectedIds(new Set(resultTabs.map((t) => t.id))),
  },
]
```

Include `selectionCommands` in `allCommands` (`[...navigationCommands, ...selectionCommands, ...actionCommands, ...sortCommands, ...helpCommands]`).

- [ ] **Step 6: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool: enter selection mode, select 3 tabs, confirm the toolbar shows "3 selected" and the four actions work (recategorize moves them, export copies their URLs with a toast, remove deletes them with a toast, Clear selection exits without changes). Confirm checkboxes only appear in selection mode.

```bash
git add src/components/workspace/tab-card.tsx src/components/workspace/filtered-tab-list.tsx src/components/workspace/workspace-view.tsx src/components/workspace/selection-toolbar.tsx
git commit -m "feat: add first-class bulk selection with a contextual selection toolbar"
```

---

### Task 28: Consolidated keyboard shortcuts hook

**Files:**
- Create: `src/hooks/use-workspace-shortcuts.ts`
- Test: `src/hooks/use-workspace-shortcuts.test.ts`
- Modify: `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- Produces: `useWorkspaceShortcuts(handlers: { onOpenPalette: () => void; onFocusSearch: () => void; onEscape: () => void; onSelectAll?: () => void }): void` — a hook that owns all global keydown wiring, replacing the ad hoc listener built up across Tasks 26/27.

- [ ] **Step 1: Write the failing test**

```ts
// src/hooks/use-workspace-shortcuts.test.ts
import { describe, expect, it, vi } from "vitest"
import { renderHook } from "@testing-library/react"
import { useWorkspaceShortcuts } from "./use-workspace-shortcuts"

function fireKey(init: KeyboardEventInit) {
  window.dispatchEvent(new KeyboardEvent("keydown", init))
}

describe("useWorkspaceShortcuts", () => {
  it("calls onOpenPalette on Cmd/Ctrl+K", () => {
    const onOpenPalette = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette, onFocusSearch: vi.fn(), onEscape: vi.fn() })
    )
    fireKey({ key: "k", metaKey: true })
    expect(onOpenPalette).toHaveBeenCalledOnce()
  })

  it("calls onFocusSearch on / when no input is focused", () => {
    const onFocusSearch = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette: vi.fn(), onFocusSearch, onEscape: vi.fn() })
    )
    fireKey({ key: "/" })
    expect(onFocusSearch).toHaveBeenCalledOnce()
  })

  it("does not hijack / while an input is focused", () => {
    const input = document.createElement("input")
    document.body.appendChild(input)
    input.focus()
    const onFocusSearch = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette: vi.fn(), onFocusSearch, onEscape: vi.fn() })
    )
    fireKey({ key: "/" })
    expect(onFocusSearch).not.toHaveBeenCalled()
    document.body.removeChild(input)
  })

  it("calls onEscape on Escape", () => {
    const onEscape = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({ onOpenPalette: vi.fn(), onFocusSearch: vi.fn(), onEscape })
    )
    fireKey({ key: "Escape" })
    expect(onEscape).toHaveBeenCalledOnce()
  })

  it("calls onSelectAll on Cmd/Ctrl+A when provided", () => {
    const onSelectAll = vi.fn()
    renderHook(() =>
      useWorkspaceShortcuts({
        onOpenPalette: vi.fn(),
        onFocusSearch: vi.fn(),
        onEscape: vi.fn(),
        onSelectAll,
      })
    )
    fireKey({ key: "a", metaKey: true })
    expect(onSelectAll).toHaveBeenCalledOnce()
  })
})
```

- [ ] **Step 2: Run it and confirm it fails**

```bash
npx vitest run src/hooks/use-workspace-shortcuts.test.ts
```

Expected: FAIL — `./use-workspace-shortcuts` does not exist.

- [ ] **Step 3: Implement the hook**

```ts
// src/hooks/use-workspace-shortcuts.ts
"use client"

import { useEffect } from "react"

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return tag === "INPUT" || tag === "TEXTAREA" || target.isContentEditable
}

export function useWorkspaceShortcuts(handlers: {
  onOpenPalette: () => void
  onFocusSearch: () => void
  onEscape: () => void
  onSelectAll?: () => void
}) {
  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      const key = e.key.toLowerCase()
      const meta = e.metaKey || e.ctrlKey

      if (meta && key === "k") {
        e.preventDefault()
        handlers.onOpenPalette()
        return
      }

      if (meta && key === "a" && handlers.onSelectAll) {
        e.preventDefault()
        handlers.onSelectAll()
        return
      }

      if (key === "escape") {
        handlers.onEscape()
        return
      }

      if (key === "/" && !isTypingTarget(e.target)) {
        e.preventDefault()
        handlers.onFocusSearch()
      }
    }

    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [handlers])
}
```

- [ ] **Step 4: Run the test and confirm it passes**

```bash
npx vitest run src/hooks/use-workspace-shortcuts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Replace `WorkspaceView`'s ad hoc keydown `useEffect` with the hook**

In `src/components/workspace/workspace-view.tsx`, remove the `useEffect`/`handleKeyDown` block built up across Task 26 and replace it with:

```tsx
useWorkspaceShortcuts({
  onOpenPalette: () => setCommandPaletteOpen(true),
  onFocusSearch: () => document.getElementById("workspace-search-input")?.focus(),
  onEscape: () => {
    if (commandPaletteOpen) return setCommandPaletteOpen(false)
    if (shortcutsOpen) return setShortcutsOpen(false)
    if (cleanupOpen) return setCleanupOpen(false)
    if (clearConfirmOpen) return setClearConfirmOpen(false)
    if (selectionMode) return exitSelectionMode()
    if (query) return setQuery("")
  },
  onSelectAll: selectionMode
    ? () => setSelectedIds(new Set(resultTabs.map((t) => t.id)))
    : undefined,
})
```

Note this Escape stack intentionally checks the palette/dialogs before selection mode before search — matching the spec's "context-sensitive close" ordering (topmost overlay first, then mode, then filter).

- [ ] **Step 6: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool: with the palette closed and no dialog open, press `/` to focus search, type something, press Escape and confirm it clears the search rather than doing nothing; open the palette and press Escape, confirm it closes the palette without also clearing search.

```bash
git add src/hooks/use-workspace-shortcuts.ts src/hooks/use-workspace-shortcuts.test.ts src/components/workspace/workspace-view.tsx
git commit -m "feat: consolidate keyboard shortcuts into a single context-sensitive hook"
```

---

### Task 29: Phase 5 power-user UX QA checkpoint

**Files:**
- Modify: any file, only as needed to fix issues found.

**Interfaces:** none new.

- [ ] **Step 1: Full automated check**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

- [ ] **Step 2: End-to-end power-user walkthrough in the browser tool**

Dump ~30 tabs. Open the palette with Cmd/Ctrl+K, run "Show duplicates," run "Sort by domain," run "Go to Research," run "Select tabs," select several rows, run each `SelectionToolbar` action, run "Keyboard shortcuts" and confirm the listed shortcuts match what actually works.

- [ ] **Step 3: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: Phase 5 power-user UX polish"
```

(Skip the commit if nothing needed changing.)

---

## Phase 6 — Responsive UX

### Task 30: Mobile WorkspaceHeader restructure

**Files:**
- Modify: `src/components/workspace/workspace-header.tsx`

**Interfaces:**
- None new — layout-only change, same props from Task 26.

- [ ] **Step 1: Split the header into a two-row responsive layout**

Replace the single `flex flex-wrap` row with an explicit two-row structure below `sm`, collapsing Cleanup/Export/Clear into one overflow menu on small screens:

```tsx
<header className="border-b border-subtle">
  <div className="mx-auto max-w-6xl px-6 py-4">
    <div className="flex items-center gap-3">
      <div className="mr-auto">
        <p className="text-body font-semibold tracking-tight text-foreground">TabDump</p>
        <p className="text-meta text-tertiary">
          {tabCount} tab{tabCount === 1 ? "" : "s"}
        </p>
      </div>

      {onOpenPalette && (
        <button
          type="button"
          onClick={onOpenPalette}
          className="hidden items-center gap-1.5 rounded-lg border border-subtle px-2 py-1 text-tertiary transition-colors hover:border-border hover:text-foreground md:inline-flex"
          aria-label="Open command palette"
        >
          <span className="text-label">Commands</span>
          <Kbd keys={["⌘", "K"]} />
        </button>
      )}

      <div className="hidden items-center gap-1.5 sm:flex">
        <Button variant="ghost" size="sm" onClick={onCleanup}>
          <Sparkles /> Cleanup
        </Button>
        <ExportMenu tabs={tabs} />
        <Button variant="ghost" size="sm" onClick={onRequestClear}>
          <Trash2 /> Clear
        </Button>
      </div>

      <DropdownMenu>
        <DropdownMenuTrigger
          render={<IconButton aria-label="More actions" tooltip="More actions" className="sm:hidden" />}
        />
        <DropdownMenuContent align="end">
          <DropdownMenuItem onClick={onOpenPalette}>Command menu</DropdownMenuItem>
          <DropdownMenuItem onClick={onCleanup}>Cleanup</DropdownMenuItem>
          <DropdownMenuItem onClick={onClickExportTxt}>Export as TXT</DropdownMenuItem>
          <DropdownMenuItem variant="destructive" onClick={onRequestClear}>Clear workspace</DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>

    <div className="mt-3 sm:hidden">
      <SearchBar
        value={searchValue}
        onChange={onSearch}
        onArrowDown={onSearchArrowDown}
        onArrowUp={onSearchArrowUp}
        onEnter={onSearchEnter}
        className="w-full"
      />
    </div>
  </div>
</header>
```

`SearchBar` needs a `className` passthrough for the `w-full` override on mobile — extend `SearchBar`'s props to accept and merge an optional `className` onto its root `div` (`className={cn("relative w-40 sm:w-64", className)}`), and keep the desktop-width `SearchBar` instance inline in the row above `md:hidden` isn't needed since the mobile block already fully replaces it below `sm` — so also wrap the existing inline `<SearchBar>` usage in the first row with a `hidden sm:block` wrapper so it doesn't double-render on mobile.

The mobile overflow menu's "Export as TXT" needs a handler — thread an `onExportTxt` prop from `WorkspaceHeader`'s existing `ExportMenu` logic: since `ExportMenu` currently owns that handler internally, either (a) export a standalone `downloadTextFile(...)`/`buildExportText(...)` call inline here (already available from `@/lib/workspace/export`, same as `ExportMenu` uses), or (b) hide `ExportMenu`'s full dropdown behind the overflow item by rendering it but visually hidden and triggering its click programmatically. Prefer (a) — it's simpler and avoids DOM gymnastics:

```tsx
import { buildExportText, downloadTextFile } from "@/lib/workspace/export"
// ...
function handleExportTxt() {
  const ok = downloadTextFile("tabdump-export.txt", buildExportText(tabs))
  if (ok) toast.success("Workspace exported")
  else toast.error("Couldn't export workspace")
}
```

and use `onClick={handleExportTxt}` on the mobile menu's "Export as TXT" item (import `toast` from `sonner`, matching `export-menu.tsx`'s existing pattern).

- [ ] **Step 2: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool, use `resize_window` at 375px width and confirm: wordmark/count on row 1 with a single overflow icon button (no more 3 crammed ghost buttons), full-width search on row 2, overflow menu contains all four actions and each works.

```bash
git add src/components/workspace/workspace-header.tsx src/components/workspace/search-bar.tsx
git commit -m "feat: give the workspace header a dedicated two-row mobile layout"
```

---

### Task 31: Mobile CommandPalette and SelectionToolbar variants

**Files:**
- Modify: `src/components/command-palette/command-palette.tsx`, `src/components/workspace/selection-toolbar.tsx`

**Interfaces:** none new — responsive className changes only.

- [ ] **Step 1: Make the palette full-screen below `sm`**

In `src/components/command-palette/command-palette.tsx`, change the outer wrapper and inner panel classNames:

```tsx
<div
  className="fixed inset-0 z-50 flex items-start justify-center bg-black/40 sm:px-4 sm:pt-[15vh]"
  onClick={() => onOpenChange(false)}
>
  <CommandPrimitive
    label="Command palette"
    className="flex h-full w-full flex-col overflow-hidden bg-popover text-popover-foreground sm:h-auto sm:max-w-lg sm:rounded-xl sm:shadow-lg sm:ring-1 sm:ring-foreground/10"
    onClick={(e) => e.stopPropagation()}
    shouldFilter
  >
```

and change `CommandPrimitive.List`'s className `max-h-[60vh]` to `max-h-none flex-1 sm:max-h-[60vh]` so it fills the full-screen sheet on mobile instead of being capped at 60vh with dead space below.

- [ ] **Step 2: Make the selection toolbar a bottom-fixed bar on mobile**

In `src/components/workspace/selection-toolbar.tsx`, change the root wrapper to stick to the bottom on small screens and stay inline (sticky top) from `sm` up, and wrap the actions to a scrollable row so they don't overflow a narrow viewport:

```tsx
<div className="fixed inset-x-0 bottom-0 z-10 flex items-center gap-2 border-t border-primary/30 bg-popover px-3 py-3 sm:sticky sm:top-0 sm:rounded-lg sm:border sm:border-primary/30 sm:border-t-primary/30 sm:bg-primary/[0.08] sm:py-2">
  <span className="shrink-0 text-body font-medium text-foreground">
    {count} selected
  </span>
  <div className="ml-auto flex items-center gap-1.5 overflow-x-auto">
```

- [ ] **Step 3: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool at 375px: open the command palette, confirm it fills the screen; enter selection mode with a couple rows selected, confirm the toolbar sits fixed at the bottom, thumb-reachable, and its actions scroll horizontally rather than wrapping/overflowing.

```bash
git add src/components/command-palette/command-palette.tsx src/components/workspace/selection-toolbar.tsx
git commit -m "feat: give the command palette and selection toolbar dedicated mobile layouts"
```

---

### Task 32: Mobile touch targets + category collapse tuning

**Files:**
- Modify: `src/components/workspace/tab-card.tsx`, `src/components/workspace/category-card.tsx`

**Interfaces:** none new.

- [ ] **Step 1: Bump touch targets on small screens in `TabCard`**

Change the row-action icon buttons' wrapper and the `IconButton`s' own sizing so they're always-visible (not hover-reveal, since there's no hover on touch) and hit 44px on small screens:

```tsx
<div className="flex shrink-0 items-center gap-0.5 opacity-100 sm:opacity-0 sm:transition-opacity sm:duration-(--duration-fast) sm:group-hover:opacity-100 sm:group-focus-within:opacity-100 sm:has-data-open:opacity-100">
  <IconButton
    aria-label={`Open ${tab.domain}`}
    onClick={() => openTab(tab.url)}
    className="size-11 sm:size-8"
  >
    <ExternalLink />
  </IconButton>

  <DropdownMenu>
    <DropdownMenuTrigger
      render={
        <IconButton
          aria-label={`More actions for ${tab.domain}`}
          className="size-11 sm:size-8"
        >
          <MoreHorizontal />
        </IconButton>
      }
    />
```

(`size-11` = 44px, `size-8` = 32px, matching the existing desktop size — the `className` override works because `IconButton`'s own `size-8` in its base classes is later in the `cn()` merge order than a caller's override only if `cn`/`twMerge` is used correctly, which it is via `IconButton`'s existing `cn(...)` call already merging `className` last.)

- [ ] **Step 2: Tune `CategoryCard`'s compact-tier row for touch**

In `src/components/workspace/category-card.tsx`, the compact-tier `<button>` already uses `px-3 py-2` — bump to a min-height on mobile: add `min-h-11 sm:min-h-0` to that button's className so the collapsed row still meets a 44px tap target on phones without inflating it on desktop.

- [ ] **Step 3: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool at 375px, confirm tab-row action buttons are visible without hovering (impossible on touch) and are comfortably tappable, and compact category rows have adequate height.

```bash
git add src/components/workspace/tab-card.tsx src/components/workspace/category-card.tsx
git commit -m "feat: meet 44px mobile touch targets and always-show row actions on touch"
```

---

### Task 33: Responsive QA pass

**Files:**
- Modify: any file, only as needed to fix issues found.

**Interfaces:** none new.

- [ ] **Step 1: Full breakpoint sweep**

Using the browser tool's `resize_window`, check 320, 375, 390, 768, 1024, 1440px on both the landing page and a workspace populated with ~40 mixed tabs (including a search in progress, a category sheet open, selection mode active, and the command palette open) at each breakpoint. Confirm no horizontal scroll, no overlapping elements, no clipped text.

- [ ] **Step 2: Fix anything found, then commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
git add -A
git commit -m "fix: Phase 6 responsive QA polish"
```

(Skip the commit if nothing needed changing.)

---

## Phase 7 — Motion + polish

### Task 34: Organization payoff stagger

**Files:**
- Modify: `src/app/globals.css`, `src/components/workspace/category-grid.tsx`

**Interfaces:**
- None new — pure CSS animation plus a mount-only flag.

- [ ] **Step 1: Add a stagger keyframe to `globals.css`**

```css
@layer components {
  @keyframes category-card-in {
    from {
      opacity: 0;
      transform: translateY(4px);
    }
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }
}
```

- [ ] **Step 2: Apply it on first mount only in `CategoryGrid`**

```tsx
// src/components/workspace/category-grid.tsx
"use client"

import { useEffect, useRef, useState } from "react"
import { CategoryCard } from "@/components/workspace/category-card"
import { CategorySheet } from "@/components/workspace/category-sheet"
import { orderCategoriesByPresence } from "@/lib/workspace/hierarchy"
import type { CategoryId } from "@/lib/categories"
import type { Tab } from "@/lib/tabs/types"

export function CategoryGrid({
  tabs,
  onCategoryChange,
}: {
  tabs: Tab[]
  onCategoryChange: (id: string, category: CategoryId) => void
}) {
  const [openCategory, setOpenCategory] = useState<CategoryId | null>(null)
  const hasAnimated = useRef(false)
  useEffect(() => {
    hasAnimated.current = true
  }, [])

  const entries = orderCategoriesByPresence(tabs)
  const groupsById = Object.fromEntries(entries.map((e) => [e.id, e.tabs]))

  return (
    <>
      <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 lg:grid-cols-3">
        {entries.map((entry, index) => (
          <div
            key={entry.id}
            style={
              hasAnimated.current
                ? undefined
                : {
                    animation: "category-card-in var(--duration-slow) var(--ease-standard) both",
                    animationDelay: `${Math.min(index, 6) * 40}ms`,
                  }
            }
          >
            <CategoryCard
              categoryId={entry.id}
              tabs={entry.tabs}
              presence={entry.presence}
              onViewAll={() => setOpenCategory(entry.id)}
            />
          </div>
        ))}
      </div>

      <CategorySheet
        categoryId={openCategory}
        tabs={openCategory ? groupsById[openCategory] : []}
        open={openCategory !== null}
        onOpenChange={(open) => !open && setOpenCategory(null)}
        onCategoryChange={onCategoryChange}
      />
    </>
  )
}
```

`hasAnimated` is a ref checked at render time before the mount effect runs, so the very first render (mount) always applies the animation and every subsequent re-render (e.g. a category reassignment) skips it — the stagger plays once, on entry, not on every state update. The global `prefers-reduced-motion` rule from Task 3 already forces `animation-duration` to near-zero, so no additional guard is needed here.

- [ ] **Step 3: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

In the browser tool, dump a fresh batch of tabs from the landing page and confirm the category cards stagger in on the workspace's first paint, then reassign a tab's category and confirm the grid updates without re-triggering the stagger.

```bash
git add src/app/globals.css src/components/workspace/category-grid.tsx
git commit -m "feat: stagger category cards in on first workspace mount"
```

---

### Task 35: Hover/press micro-interaction consistency pass

**Files:**
- Modify: `src/components/workspace/category-filter-bar.tsx`, `src/components/workspace/tab-card.tsx`, `src/components/workspace/category-card.tsx`

**Interfaces:** none new.

- [ ] **Step 1: Apply the shared duration/ease tokens to remaining ad hoc `transition-colors`**

Each of these three files currently has a bare `transition-colors` (no explicit duration/ease, falling back to Tailwind's default). Update each occurrence to `transition-colors duration-(--duration-fast) ease-(--ease-standard)`:
- `category-filter-bar.tsx`: the `Pill` button's className.
- `tab-card.tsx`: the action-icon wrapper's `transition-opacity` (already updated with `duration-(--duration-fast)` in Task 20 — confirm it's present, no change needed if so).
- `category-card.tsx`: the compact-tier button's className (added in Task 17) — add `transition-colors duration-(--duration-fast) ease-(--ease-standard)` alongside its existing classes.

- [ ] **Step 2: Run the full suite, verify visually, commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
git add src/components/workspace/category-filter-bar.tsx src/components/workspace/tab-card.tsx src/components/workspace/category-card.tsx
git commit -m "fix: apply consistent motion timing to remaining hover transitions"
```

---

### Task 36: Ruthless "does this look AI-generated" visual QA pass

**Files:**
- Modify: any file, as needed.

**Interfaces:** none new.

- [ ] **Step 1: Run the checklist from the spec against every screen**

In the browser tool, walk landing, workspace (browse mode), workspace (search/filtered), category sheet, cleanup dialog, command palette, selection mode, and every empty state. For each, check: generic cards, excessive rounded rectangles, gradients, excessive borders, weak/inconsistent typography, inconsistent spacing, repetitive components, visual noise, decorative-only elements, awkward responsive behavior. Specifically re-check that `HeroBackground`'s radial glow (the one remaining gradient in the app) still reads as restrained (low opacity, subtle) rather than a loud SaaS-template glow — this is the single highest-risk "looks AI-generated" element in the whole app and deserves direct scrutiny, not just a glance.

- [ ] **Step 2: Fix everything found**

Make the fixes directly in the relevant component files. Do not defer findings — this is the pass that catches what earlier phases missed because they were focused on one screen at a time.

- [ ] **Step 3: Run the full suite and commit**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
git add -A
git commit -m "fix: Phase 7 ruthless visual QA — remove remaining generic-SaaS artifacts"
```

(If Step 2 found nothing, still run Step 3's checks but skip the commit.)

---

## Phase 8 — QA

### Task 37: Full automated regression check

**Files:** none — verification only.

- [ ] **Step 1: Run everything**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all pass with zero errors. If `npm run build` reveals any component still importing a now-removed export (e.g. a leftover import from a file changed in an earlier phase), fix the import and re-run.

- [ ] **Step 2: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: resolve build/lint/type regressions found in final QA"
```

(Skip if nothing needed changing.)

---

### Task 38: Accessibility and keyboard-navigation pass

**Files:**
- Modify: any file, as needed.

**Interfaces:** none new.

- [ ] **Step 1: Full keyboard walkthrough**

In the browser tool, using only Tab/Shift+Tab/Enter/Escape/Arrow keys (no clicks), complete: paste tabs and submit on landing; open the command palette and run a command; open the cleanup dialog and complete a cleanup; enter selection mode, select tabs via keyboard, run a bulk action; open a category sheet and close it. Confirm every interactive element has a visible focus ring and nothing is a keyboard trap.

- [ ] **Step 2: Contrast check on new tokens**

Verify (via the browser tool's `javascript_tool`, reading computed `color`/`background-color` and checking against WCAG AA) the `AttentionStrip`'s text-on-tint, the `SelectionToolbar`'s text-on-tint, and the command palette's selected-item state (`bg-primary/15` + `text-accent-text`, already used elsewhere in the app and previously contrast-verified per the code comment in `globals.css` — confirm it still holds at the exact opacity used here).

- [ ] **Step 3: Fix anything found, then commit**

```bash
npx vitest run
npx tsc --noEmit
git add -A
git commit -m "fix: accessibility and keyboard-navigation issues found in final QA"
```

(Skip if nothing needed changing.)

---

### Task 39: Final responsive/performance regression check and completion report

**Files:** none — verification only.

- [ ] **Step 1: Realistic large-scale check**

In the browser tool, paste 100 URLs (generate via the browser console: `Array.from({length:100},(_,i)=>\`https://example${i % 20}.com/page-${i}\`).join('\n')`, pasted into the landing textarea) at 375px and 1440px. Confirm: the "Organizing…" beat still feels snappy (not sluggish at 100 tabs), the workspace renders without visible jank, count-up and stagger animations complete quickly, search/filter/sort remain responsive while typing.

- [ ] **Step 2: Sanity-check for obviously expensive re-renders**

Grep the changed files for any `useEffect`/`useMemo` missing a dependency array or recomputing on every render unnecessarily (in particular, re-check `useCountUp` and `useWorkspaceShortcuts` since both were newly introduced in this plan) — confirm both only re-run their effect logic when their actual inputs change, not on every parent re-render.

- [ ] **Step 3: Final full check and report**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Summarize: total files changed, new files added, new dependency (`cmdk`), test count before/after, and a screen-by-screen confirmation that all 13 refinement points from the approved direction are implemented (personality/copy preserved, workspace as hero, organization payoff, command palette depth, first-class bulk actions, reduced card nesting, category hierarchy, empty states, obviously-interactive icon buttons, dedicated mobile model, keyboard shortcut system, ruthless visual QA pass, phased delivery).

- [ ] **Step 4: No further commit needed if Steps 1–3 found nothing new**

(This task is a verification/report task; only commit if Step 2's grep turns up an actual fix to make.)
