# TabDump Phase 1 & 2 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Scaffold TabDump (Next.js + TypeScript + Tailwind) with a premium dark-first design system and a functional landing page whose textarea parses, normalizes, and dedup-flags pasted URLs in real time.

**Architecture:** Next.js App Router site. `src/app/globals.css` + `tailwind.config.ts` hold design tokens as CSS variables. `src/components/ui/*` holds restyled shadcn primitives (Button, Textarea, Input, Badge, Card). `src/lib/tabs/*` holds pure, framework-free parsing/normalization/dedup functions with Vitest unit tests. `src/app/page.tsx` composes Header + Hero + a client `TabInput` component that owns the textarea state and calls the `src/lib/tabs` functions via `useMemo`/`useDeferredValue` so large pastes (up to 250 URLs) stay responsive.

**Tech Stack:** Next.js 15 (App Router), TypeScript, Tailwind CSS, shadcn/ui (Radix primitives), lucide-react, Geist Sans/Mono (`next/font`), Vitest + @testing-library for unit tests, npm.

## Global Constraints

- Dark-first UI: near-black background with distinct surface/elevated/input layers (never pure black everywhere).
- Monochrome base UI; the chosen accent is indigo/blue, used only for primary actions, interactive states, and (reserved) success/warning states.
- One consistent radius scale; nothing pill-shaped except explicit badges.
- Subtle borders and soft, low-opacity shadows only — no heavy box look.
- Transitions restrained to ~150–200ms ease-out; no excessive motion.
- Wordmark: `TabDump`, no logo illustration.
- Hero headline verbatim: `Your tabs are a mess.\nDump them.`
- Hero subtext verbatim: `Paste your browser tabs and turn the chaos\ninto an organized workspace.`
- Textarea placeholder verbatim:
  ```
  Paste your tabs here...

  https://github.com/...
  https://arxiv.org/...
  https://amazon.in/...
  ```
- Helper text verbatim: `Paste 20, 50, or even 100 tabs at once.`
- CTA label is dynamic: `Dump my tabs →` (0 valid URLs, disabled) / `Dump 1 tab →` (1) / `Dump N tabs →` (N).
- Status line verbatim pattern: `N tabs detected` or `N tabs detected · M invalid` (only shown when relevant).
- Tracking params stripped for `normalizedUrl` only, never from the stored `url`: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `fbclid`, `gclid`.
- Parsing must accept newline, comma, space, and tab delimiters in any mixture, must never throw on malformed input, and must remain responsive at 250 pasted URLs.
- Excluded from Phase 1 & 2 (do not build): auth, database, API routes, AI/categorization logic, browser extension, results/workspace dashboard, payments, network favicon fetching, actually removing duplicates (only flag them), navigating anywhere on submit.
- Responsive targets: 320, 375, 390, 768, 1024, 1440px+ with no horizontal overflow.

---

### Task 1: Initialize the Next.js project

**Files:**
- Create: entire scaffolded Next.js app at repo root (`package.json`, `tsconfig.json`, `next.config.ts`, `src/app/layout.tsx`, `src/app/page.tsx`, `src/app/globals.css`, `.eslintrc`/`eslint.config.mjs`, `postcss.config.mjs`)

**Interfaces:**
- Produces: an app runnable via `npm run dev`, editable at `src/app/page.tsx`, styled via `src/app/globals.css` and Tailwind.

- [ ] **Step 1: Scaffold with create-next-app**

Run from the repo root (`C:\Users\viswa\Downloads\tabs`, currently empty except `.git`):

```bash
npx --yes create-next-app@latest . --typescript --tailwind --eslint --app --src-dir --import-alias "@/*" --use-npm
```

If it prompts interactively for anything not covered by flags (e.g. Turbopack), accept the default.

- [ ] **Step 2: Verify it builds and runs**

Run: `npm run dev -- --port 4001 &` then `curl -sSf http://localhost:4001 > /dev/null && echo OK`, then stop the dev server.
Expected: `OK` printed, no errors in server output.

- [ ] **Step 3: Commit**

```bash
git add -A
git commit -m "chore: scaffold Next.js + TypeScript + Tailwind app"
```

---

### Task 2: Install shadcn/ui, lucide-react, and fonts

**Files:**
- Modify: `src/app/layout.tsx` (font setup)
- Create: `components.json` (shadcn config), `src/lib/utils.ts` (shadcn's `cn` helper), `src/components/ui/button.tsx`, `src/components/ui/textarea.tsx`, `src/components/ui/input.tsx`, `src/components/ui/badge.tsx`, `src/components/ui/card.tsx` (via shadcn CLI, restyled in Task 4)

**Interfaces:**
- Produces: `cn(...)` from `@/lib/utils`, unstyled-but-accessible `Button`, `Textarea`, `Input`, `Badge`, `Card` from `@/components/ui/*` for Task 4 to restyle.

- [ ] **Step 1: Install lucide-react**

```bash
npm install lucide-react
```

- [ ] **Step 2: Init shadcn/ui**

```bash
npx --yes shadcn@latest init -d
```

Expected: creates `components.json` and `src/lib/utils.ts`.

- [ ] **Step 3: Add the primitives we need**

```bash
npx --yes shadcn@latest add button textarea input badge card
```

Expected: files created under `src/components/ui/`.

- [ ] **Step 4: Configure Geist fonts in the root layout**

In `src/app/layout.tsx`, use `next/font/google`'s `Geist` and `Geist_Mono` (or `next/font/local` if `create-next-app` already wired Geist — check the file first and adapt rather than duplicating):

```tsx
import { Geist, Geist_Mono } from "next/font/google";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className="dark">
      <body className={`${geistSans.variable} ${geistMono.variable} font-sans antialiased`}>
        {children}
      </body>
    </html>
  );
}
```

- [ ] **Step 5: Verify build**

Run: `npm run build`
Expected: succeeds with no type errors.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "chore: add shadcn/ui primitives, lucide-react, Geist fonts"
```

---

### Task 3: Design tokens

**Files:**
- Modify: `src/app/globals.css` (CSS variables + base layer)
- Modify: `tailwind.config.ts` (or confirm Tailwind v4's `@theme` inline block in `globals.css` is used instead, matching whatever `create-next-app` set up — inspect first, don't create a second competing config)

**Interfaces:**
- Produces: CSS variables `--bg-base`, `--bg-surface`, `--bg-elevated`, `--bg-input`, `--border-subtle`, `--border-default`, `--text-primary`, `--text-secondary`, `--text-tertiary`, `--accent-4`, `--accent-9`, `--accent-11`, `--success-9`, `--warning-9`, `--radius-sm`, `--radius-md`, `--radius-lg`, consumed by every component in Task 4+.

- [ ] **Step 1: Inspect what create-next-app generated**

Read `src/app/globals.css` and `tailwind.config.ts` (if present — Tailwind v4 may only use `globals.css`). Confirm whether it's Tailwind v3 (JS config + `@tailwind` directives) or v4 (`@import "tailwindcss"` + `@theme`).

- [ ] **Step 2: Add token variables to `globals.css`**

Add (adjust syntax to match v3 `:root {}` or v4 `@theme {}` found in Step 1):

```css
:root {
  --bg-base: #0a0a0b;
  --bg-surface: #121214;
  --bg-elevated: #18181b;
  --bg-input: #141416;

  --border-subtle: rgba(255, 255, 255, 0.06);
  --border-default: rgba(255, 255, 255, 0.1);

  --text-primary: #f4f4f5;
  --text-secondary: #a1a1aa;
  --text-tertiary: #71717a;

  --accent-4: #1e2a4a;
  --accent-9: #3b5bfd;
  --accent-10: #5470ff;
  --accent-11: #b3c0ff;

  --success-9: #2fae63;
  --warning-9: #d99a2b;
  --danger-9: #e5484d;

  --radius-sm: 6px;
  --radius-md: 10px;
  --radius-lg: 16px;

  --shadow-elevated: 0 8px 30px rgba(0, 0, 0, 0.35);

  --ease-out-standard: cubic-bezier(0.16, 1, 0.3, 1);
}

body {
  background-color: var(--bg-base);
  color: var(--text-primary);
}

::selection {
  background-color: var(--accent-9);
  color: white;
}

* {
  scrollbar-color: var(--border-default) transparent;
  scrollbar-width: thin;
}

*::-webkit-scrollbar {
  width: 10px;
  height: 10px;
}
*::-webkit-scrollbar-thumb {
  background-color: var(--border-default);
  border-radius: var(--radius-sm);
}
*::-webkit-scrollbar-track {
  background: transparent;
}

:focus-visible {
  outline: 2px solid var(--accent-9);
  outline-offset: 2px;
}
```

- [ ] **Step 3: Map tokens into Tailwind's theme**

If Tailwind v4: add to the `@theme inline {}` block so classes like `bg-surface`, `text-secondary`, `border-subtle`, `rounded-md` resolve to the variables above (e.g. `--color-surface: var(--bg-surface);`, `--color-border-subtle: var(--border-subtle);`, `--radius-md: var(--radius-md);`).
If Tailwind v3: extend `theme.extend.colors`/`borderRadius`/`boxShadow` in `tailwind.config.ts` to reference the same CSS variables via `hsl(var(--...))`/`var(--...)` patterns.

- [ ] **Step 4: Verify visually**

Run `npm run dev`, load the default page, confirm the background is the near-black token (not Tailwind's default white/black) via browser inspection.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add TabDump design tokens (color, radius, shadow, focus)"
```

---

### Task 4: Core UI primitives

**Files:**
- Modify: `src/components/ui/button.tsx`, `src/components/ui/textarea.tsx`, `src/components/ui/input.tsx`, `src/components/ui/badge.tsx`, `src/components/ui/card.tsx`
- Create: `src/components/ui/icon-button.tsx`, `src/components/ui/surface.tsx` (thin wrapper alias over Card if Card is already suitable — only create if genuinely distinct)

**Interfaces:**
- Consumes: token classes from Task 3 (`bg-surface`, `border-subtle`, `rounded-md`, etc.), `cn` from `@/lib/utils`.
- Produces: `<Button variant="primary|secondary|ghost" size="...">`, `<IconButton aria-label="...">`, `<Textarea>`, `<Input>`, `<Badge variant="...">`, `<Card>`/`<Surface>` — used by Task 5, 6, 11.

- [ ] **Step 1: Restyle Button variants**

Edit `src/components/ui/button.tsx`'s `buttonVariants` (cva) so:
- `default`/`primary`: `bg-[var(--accent-9)] text-white hover:bg-[var(--accent-10)] rounded-[var(--radius-md)] transition-colors duration-150`
- `secondary`: `bg-surface border border-default text-primary hover:border-[var(--border-default)] hover:bg-elevated`
- `ghost`: `text-secondary hover:text-primary hover:bg-surface`
All variants keep shadcn's existing focus-visible ring and disabled styles (don't remove accessibility behavior — only change color/radius classes).

- [ ] **Step 2: Create IconButton**

```tsx
// src/components/ui/icon-button.tsx
import * as React from "react";
import { cn } from "@/lib/utils";

export interface IconButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement> {
  "aria-label": string;
}

export const IconButton = React.forwardRef<HTMLButtonElement, IconButtonProps>(
  ({ className, ...props }, ref) => (
    <button
      ref={ref}
      type="button"
      className={cn(
        "inline-flex h-9 w-9 items-center justify-center rounded-[var(--radius-sm)]",
        "text-secondary hover:text-primary hover:bg-surface transition-colors duration-150",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--accent-9)]",
        className
      )}
      {...props}
    />
  )
);
IconButton.displayName = "IconButton";
```

- [ ] **Step 3: Restyle Textarea and Input**

Edit both to use: `bg-input border border-subtle rounded-[var(--radius-md)] text-primary placeholder:text-tertiary focus-visible:border-[var(--accent-9)] focus-visible:ring-1 focus-visible:ring-[var(--accent-9)] transition-colors duration-150`.

- [ ] **Step 4: Restyle Badge**

Edit `badge.tsx` variants to be small, `rounded-[var(--radius-sm)]` (not full pill), `border border-subtle bg-surface text-secondary text-xs font-medium px-2 py-0.5`, with an `accent` variant using `bg-[var(--accent-4)] text-[var(--accent-11)] border-transparent` for later category/status use.

- [ ] **Step 5: Restyle Card as the Surface primitive**

Edit `card.tsx` root to `bg-surface border border-subtle rounded-[var(--radius-lg)] shadow-[var(--shadow-elevated)]`. If the shadcn Card's subcomponent API (Header/Title/Content) is more than Phase 1/2 needs, keep it as-is — do not remove shadcn's existing exports, just adjust classes.

- [ ] **Step 6: Verify with a scratch render**

Temporarily render one of each in `src/app/page.tsx`, `npm run dev`, confirm visually in the browser tool, then remove the scratch render (Task 6 will build the real page).

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: restyle shadcn primitives with TabDump design tokens"
```

---

### Task 5: Header

**Files:**
- Create: `src/components/header.tsx`
- Modify: `src/app/page.tsx` (render it)

**Interfaces:**
- Produces: `<Header />` with no props, used by `src/app/page.tsx`.

- [ ] **Step 1: Build the Header component**

```tsx
// src/components/header.tsx
export function Header() {
  return (
    <header className="border-b border-subtle">
      <div className="mx-auto flex max-w-5xl items-center px-6 py-5">
        <span className="text-sm font-semibold tracking-tight text-primary">
          TabDump
        </span>
      </div>
    </header>
  );
}
```

- [ ] **Step 2: Render it at the top of `src/app/page.tsx`**

- [ ] **Step 3: Verify**

`npm run dev`, confirm the wordmark renders top-left with a subtle bottom border, no nav items.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: add TabDump header/wordmark"
```

---

### Task 6: Landing page hero + static composition

**Files:**
- Modify: `src/app/page.tsx`
- Create: `src/components/hero-background.tsx` (decorative gradient/grid, `pointer-events-none`)

**Interfaces:**
- Consumes: `Header` (Task 5), `Button`, `Textarea`, `Badge` (Task 4).
- Produces: the full static landing page layout that Task 11 will wire up with real state (this task ships it with an inert textarea/button, per Phase 1 scope).

- [ ] **Step 1: Build the decorative background**

```tsx
// src/components/hero-background.tsx
export function HeroBackground() {
  return (
    <div
      aria-hidden
      className="pointer-events-none absolute inset-0 overflow-hidden"
    >
      <div
        className="absolute left-1/2 top-0 h-[480px] w-[900px] -translate-x-1/2 rounded-full opacity-20 blur-3xl"
        style={{
          background:
            "radial-gradient(closest-side, var(--accent-9), transparent)",
        }}
      />
      <div
        className="absolute inset-0 opacity-[0.03]"
        style={{
          backgroundImage:
            "linear-gradient(to right, var(--border-default) 1px, transparent 1px), linear-gradient(to bottom, var(--border-default) 1px, transparent 1px)",
          backgroundSize: "48px 48px",
        }}
      />
    </div>
  );
}
```

- [ ] **Step 2: Compose the page**

```tsx
// src/app/page.tsx
import { Header } from "@/components/header";
import { HeroBackground } from "@/components/hero-background";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";

export default function Home() {
  return (
    <div className="relative min-h-screen">
      <HeroBackground />
      <Header />
      <main className="relative mx-auto flex max-w-3xl flex-col items-center px-6 py-20 text-center sm:py-28">
        <h1 className="text-4xl font-semibold tracking-tight text-primary sm:text-6xl">
          Your tabs are a mess.
          <br />
          Dump them.
        </h1>
        <p className="mt-5 max-w-xl text-balance text-base text-secondary sm:text-lg">
          Paste your browser tabs and turn the chaos
          <br className="hidden sm:block" /> into an organized workspace.
        </p>

        <div className="mt-10 w-full">
          <Textarea
            aria-label="Paste your tabs"
            placeholder={
              "Paste your tabs here...\n\nhttps://github.com/...\nhttps://arxiv.org/...\nhttps://amazon.in/..."
            }
            rows={8}
            className="w-full resize-none text-left text-sm sm:text-base"
          />
          <p className="mt-2 text-xs text-tertiary">
            Paste 20, 50, or even 100 tabs at once.
          </p>
          <Button size="lg" className="mt-6 w-full sm:w-auto">
            Dump my tabs →
          </Button>
        </div>
      </main>
    </div>
  );
}
```

(Task 11 replaces the inert `Textarea`/`Button` pair here with the stateful `TabInput` client component — same visual position, same copy defaults.)

- [ ] **Step 3: Verify in the browser tool**

`npm run dev`, load the page, confirm hero hierarchy (headline → subtext → textarea → helper text → CTA), confirm the background glow/grid is subtle and doesn't obscure text.

- [ ] **Step 4: Commit**

```bash
git add -A
git commit -m "feat: build TabDump landing page hero and composition"
```

---

### Task 7: Phase 1 responsive & accessibility QA pass

**Files:**
- Modify: `src/app/page.tsx`, `src/components/hero-background.tsx`, `src/components/ui/*` (only as needed to fix issues found)

**Interfaces:**
- None new — this task only verifies and patches Tasks 1–6.

- [ ] **Step 1: Resize-test each breakpoint**

Using the browser tool, load the dev server and check 320, 375, 390, 768, 1024, and 1440px widths. Confirm: no horizontal scrollbar, headline wraps sensibly, textarea stays comfortably usable, CTA stays reachable without being cramped against the viewport edge, decorative background never overlaps interactive text.

- [ ] **Step 2: Keyboard-navigation test**

Tab through the page: focus should move Header (nothing focusable) → Textarea → Button, each with a visible focus ring (from the `:focus-visible` token in Task 3). Confirm no focus trap and no invisible focus targets.

- [ ] **Step 3: Run typecheck and lint**

```bash
npx tsc --noEmit
npm run lint
```

Expected: zero errors.

- [ ] **Step 4: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: responsive and accessibility polish for landing page"
```

(Skip the commit if Step 1–3 found nothing to change.)

---

### Task 8: Tab types and URL parsing utility

**Files:**
- Create: `src/lib/tabs/types.ts`
- Create: `src/lib/tabs/parse.ts`
- Test: `src/lib/tabs/parse.test.ts`

**Interfaces:**
- Produces: `Tab` type, `splitInput(raw: string): string[]`, `parseUrls(raw: string): { tabs: Tab[]; invalidCount: number }` — consumed by Task 9 (normalization is called from inside `parseUrls`), Task 10, and Task 11.

- [ ] **Step 1: Install Vitest**

```bash
npm install -D vitest @vitejs/plugin-react jsdom
```

Add to `package.json` `scripts`: `"test": "vitest run"`.
Create `vitest.config.ts`:

```ts
import { defineConfig } from "vitest/config";
import react from "@vitejs/plugin-react";
import path from "node:path";

export default defineConfig({
  plugins: [react()],
  test: {
    environment: "jsdom",
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "./src"),
    },
  },
});
```

- [ ] **Step 2: Write the failing test for `splitInput`**

```ts
// src/lib/tabs/parse.test.ts
import { describe, expect, it } from "vitest";
import { splitInput, parseUrls } from "./parse";

describe("splitInput", () => {
  it("splits on newlines", () => {
    expect(splitInput("https://a.com\nhttps://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on commas", () => {
    expect(splitInput("https://a.com, https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on spaces", () => {
    expect(splitInput("https://a.com https://b.com")).toEqual([
      "https://a.com",
      "https://b.com",
    ]);
  });

  it("splits on tabs and mixed whitespace/commas", () => {
    expect(splitInput("https://a.com\t,\nhttps://b.com  https://c.com")).toEqual([
      "https://a.com",
      "https://b.com",
      "https://c.com",
    ]);
  });

  it("drops empty tokens and trims", () => {
    expect(splitInput("  \n\n , , https://a.com  ")).toEqual(["https://a.com"]);
  });

  it("returns an empty array for empty input", () => {
    expect(splitInput("")).toEqual([]);
    expect(splitInput("   \n\t  ")).toEqual([]);
  });
});
```

- [ ] **Step 3: Run it and confirm it fails**

```bash
npx vitest run src/lib/tabs/parse.test.ts
```

Expected: FAIL — `parse.ts` does not exist yet.

- [ ] **Step 4: Implement `types.ts` and `splitInput`**

```ts
// src/lib/tabs/types.ts
export type Tab = {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  category?: string;
  title?: string;
  favicon?: string;
  isDuplicate?: boolean;
};

export type ParseResult = {
  tabs: Tab[];
  invalidCount: number;
};
```

```ts
// src/lib/tabs/parse.ts (partial — extended in Step 6)
export function splitInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}
```

- [ ] **Step 5: Run the splitInput tests and confirm they pass**

```bash
npx vitest run src/lib/tabs/parse.test.ts
```

Expected: the 6 `splitInput` tests PASS (`parseUrls` tests below will still fail — that's expected until Step 6).

- [ ] **Step 6: Write the failing tests for `parseUrls`**

Append to `src/lib/tabs/parse.test.ts`:

```ts
describe("parseUrls", () => {
  it("parses well-formed URLs and assigns ids/domains", () => {
    const { tabs, invalidCount } = parseUrls("https://github.com/foo\nhttps://arxiv.org/abs/1");
    expect(invalidCount).toBe(0);
    expect(tabs).toHaveLength(2);
    expect(tabs[0].domain).toBe("github.com");
    expect(tabs[0].url).toBe("https://github.com/foo");
    expect(new Set(tabs.map((t) => t.id)).size).toBe(2);
  });

  it("adds https:// to bare domains", () => {
    const { tabs, invalidCount } = parseUrls("github.com/foo");
    expect(invalidCount).toBe(0);
    expect(tabs[0].url).toBe("https://github.com/foo");
  });

  it("counts garbage tokens as invalid without throwing", () => {
    expect(() => parseUrls("not a url, ///, ,,,")).not.toThrow();
    const { tabs, invalidCount } = parseUrls("not a url, https://a.com");
    expect(tabs).toHaveLength(1);
    expect(invalidCount).toBeGreaterThan(0);
  });

  it("handles empty input", () => {
    const { tabs, invalidCount } = parseUrls("");
    expect(tabs).toEqual([]);
    expect(invalidCount).toBe(0);
  });

  it("handles mixed valid and invalid content", () => {
    const { tabs, invalidCount } = parseUrls(
      "https://github.com/a, garbage, https://arxiv.org/b, also garbage"
    );
    expect(tabs).toHaveLength(2);
    expect(invalidCount).toBe(2);
  });

  it("remains fast and correct for 250 URLs", () => {
    const input = Array.from({ length: 250 }, (_, i) => `https://example.com/page-${i}`).join("\n");
    const start = performance.now();
    const { tabs, invalidCount } = parseUrls(input);
    const elapsed = performance.now() - start;
    expect(tabs).toHaveLength(250);
    expect(invalidCount).toBe(0);
    expect(elapsed).toBeLessThan(200);
  });
});
```

- [ ] **Step 7: Run it and confirm the new tests fail**

```bash
npx vitest run src/lib/tabs/parse.test.ts
```

Expected: FAIL — `parseUrls` is not exported yet.

- [ ] **Step 8: Implement `parseUrls`**

```ts
// src/lib/tabs/parse.ts (full file)
import type { ParseResult, Tab } from "./types";
import { normalizeUrl } from "./normalize";

export function splitInput(raw: string): string[] {
  return raw
    .split(/[\s,]+/)
    .map((token) => token.trim())
    .filter((token) => token.length > 0);
}

function ensureProtocol(token: string): string {
  return /^[a-zA-Z][a-zA-Z\d+\-.]*:\/\//.test(token) ? token : `https://${token}`;
}

let counter = 0;
function nextId(): string {
  counter += 1;
  return `tab-${Date.now()}-${counter}`;
}

function toTab(candidateUrl: string, parsed: URL): Tab {
  return {
    id: nextId(),
    url: candidateUrl,
    normalizedUrl: normalizeUrl(parsed),
    domain: parsed.hostname.replace(/^www\./, ""),
  };
}

export function parseUrls(raw: string): ParseResult {
  const tokens = splitInput(raw);
  const tabs: Tab[] = [];
  let invalidCount = 0;

  for (const token of tokens) {
    const candidate = ensureProtocol(token);
    let parsed: URL;
    try {
      parsed = new URL(candidate);
    } catch {
      invalidCount += 1;
      continue;
    }
    if (!parsed.hostname.includes(".")) {
      invalidCount += 1;
      continue;
    }
    tabs.push(toTab(candidate, parsed));
  }

  return { tabs, invalidCount };
}
```

Note: this depends on `normalizeUrl` from Task 9. Implement Task 9's `normalize.ts` (Steps 1–4 below) before running this step's tests.

- [ ] **Step 9: Run the full parse test file and confirm it passes**

```bash
npx vitest run src/lib/tabs/parse.test.ts
```

Expected: all tests PASS.

- [ ] **Step 10: Commit**

```bash
git add -A
git commit -m "feat: add Tab type and URL parsing utility with tests"
```

---

### Task 9: URL normalization utility

**Files:**
- Create: `src/lib/tabs/normalize.ts`
- Test: `src/lib/tabs/normalize.test.ts`

**Interfaces:**
- Consumes: nothing (pure function over the built-in `URL`).
- Produces: `normalizeUrl(url: URL): string`, `TRACKING_PARAMS: readonly string[]` — consumed by `parseUrls` (Task 8) and duplicate detection (Task 10).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/tabs/normalize.test.ts
import { describe, expect, it } from "vitest";
import { normalizeUrl } from "./normalize";

describe("normalizeUrl", () => {
  it("lowercases the hostname", () => {
    expect(normalizeUrl(new URL("https://GitHub.com/foo"))).toBe(
      "https://github.com/foo"
    );
  });

  it("strips a trailing slash", () => {
    expect(normalizeUrl(new URL("https://example.com/page/"))).toBe(
      "https://example.com/page"
    );
  });

  it("removes utm_ and click-id tracking params", () => {
    const url = new URL(
      "https://example.com/page?utm_source=x&utm_medium=y&utm_campaign=z&utm_term=t&utm_content=c&fbclid=1&gclid=2&keep=me"
    );
    expect(normalizeUrl(url)).toBe("https://example.com/page?keep=me");
  });

  it("drops the hash fragment", () => {
    expect(normalizeUrl(new URL("https://example.com/page#section"))).toBe(
      "https://example.com/page"
    );
  });

  it("treats two URLs differing only by tracking params as equal", () => {
    const a = normalizeUrl(new URL("https://example.com/page?utm_source=test"));
    const b = normalizeUrl(new URL("https://example.com/page"));
    expect(a).toBe(b);
  });

  it("sorts remaining query params for stable comparison", () => {
    const a = normalizeUrl(new URL("https://example.com/page?b=2&a=1"));
    const b = normalizeUrl(new URL("https://example.com/page?a=1&b=2"));
    expect(a).toBe(b);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/tabs/normalize.test.ts
```

Expected: FAIL — `normalize.ts` does not exist.

- [ ] **Step 3: Implement `normalize.ts`**

```ts
// src/lib/tabs/normalize.ts
export const TRACKING_PARAMS = [
  "utm_source",
  "utm_medium",
  "utm_campaign",
  "utm_term",
  "utm_content",
  "fbclid",
  "gclid",
] as const;

export function normalizeUrl(url: URL): string {
  const clone = new URL(url.toString());
  clone.hostname = clone.hostname.toLowerCase();
  clone.hash = "";
  for (const param of TRACKING_PARAMS) {
    clone.searchParams.delete(param);
  }
  clone.searchParams.sort();

  const pathname = clone.pathname.replace(/\/+$/, "");
  const search = clone.searchParams.toString();

  return `${clone.protocol}//${clone.hostname}${pathname}${search ? `?${search}` : ""}`;
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/tabs/normalize.test.ts
```

Expected: all tests PASS. (This unblocks Task 8 Step 9.)

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add URL normalization utility with tracking-param stripping"
```

---

### Task 10: Duplicate detection

**Files:**
- Create: `src/lib/tabs/duplicates.ts`
- Test: `src/lib/tabs/duplicates.test.ts`

**Interfaces:**
- Consumes: `Tab` type (Task 8).
- Produces: `markDuplicates(tabs: Tab[]): Tab[]` — consumed by Task 11's `parseTabInput`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/tabs/duplicates.test.ts
import { describe, expect, it } from "vitest";
import { markDuplicates } from "./duplicates";
import type { Tab } from "./types";

function makeTab(normalizedUrl: string, id: string): Tab {
  return { id, url: normalizedUrl, normalizedUrl, domain: "example.com" };
}

describe("markDuplicates", () => {
  it("does not flag unique tabs", () => {
    const tabs = markDuplicates([
      makeTab("https://a.com/1", "1"),
      makeTab("https://a.com/2", "2"),
    ]);
    expect(tabs.every((t) => !t.isDuplicate)).toBe(true);
  });

  it("flags exact duplicates after the first occurrence", () => {
    const tabs = markDuplicates([
      makeTab("https://example.com/page", "1"),
      makeTab("https://example.com/page", "2"),
    ]);
    expect(tabs[0].isDuplicate).toBeFalsy();
    expect(tabs[1].isDuplicate).toBe(true);
  });

  it("flags normalized-equivalent duplicates (tracking params differ)", () => {
    const tabs = markDuplicates([
      makeTab("https://example.com/page", "1"),
      makeTab("https://example.com/page", "2"), // normalizedUrl already stripped upstream
    ]);
    expect(tabs[1].isDuplicate).toBe(true);
  });

  it("handles an empty list", () => {
    expect(markDuplicates([])).toEqual([]);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/tabs/duplicates.test.ts
```

Expected: FAIL — `duplicates.ts` does not exist.

- [ ] **Step 3: Implement `duplicates.ts`**

```ts
// src/lib/tabs/duplicates.ts
import type { Tab } from "./types";

export function markDuplicates(tabs: Tab[]): Tab[] {
  const seen = new Set<string>();
  return tabs.map((tab) => {
    const isDuplicate = seen.has(tab.normalizedUrl);
    seen.add(tab.normalizedUrl);
    return { ...tab, isDuplicate };
  });
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/tabs/duplicates.test.ts
```

Expected: all tests PASS.

- [ ] **Step 5: Add the combined entry point and its test**

```ts
// src/lib/tabs/index.ts
import { parseUrls } from "./parse";
import { markDuplicates } from "./duplicates";
import type { ParseResult } from "./types";

export * from "./types";
export { parseUrls } from "./parse";
export { normalizeUrl, TRACKING_PARAMS } from "./normalize";
export { markDuplicates } from "./duplicates";

export function parseTabInput(raw: string): ParseResult {
  const { tabs, invalidCount } = parseUrls(raw);
  return { tabs: markDuplicates(tabs), invalidCount };
}
```

```ts
// src/lib/tabs/index.test.ts
import { describe, expect, it } from "vitest";
import { parseTabInput } from "./index";

describe("parseTabInput", () => {
  it("parses and flags duplicates end-to-end, including tracking-param dupes", () => {
    const { tabs, invalidCount } = parseTabInput(
      "https://example.com/page?utm_source=test, https://example.com/page, not-a-url-!!, https://github.com/x"
    );
    expect(invalidCount).toBe(1);
    expect(tabs).toHaveLength(3);
    expect(tabs[0].isDuplicate).toBeFalsy();
    expect(tabs[1].isDuplicate).toBe(true);
    expect(tabs[2].isDuplicate).toBeFalsy();
  });
});
```

- [ ] **Step 6: Run the whole `src/lib/tabs` suite and confirm everything passes**

```bash
npx vitest run src/lib/tabs
```

Expected: all tests across `parse.test.ts`, `normalize.test.ts`, `duplicates.test.ts`, `index.test.ts` PASS.

- [ ] **Step 7: Commit**

```bash
git add -A
git commit -m "feat: add duplicate detection and parseTabInput entry point with tests"
```

---

### Task 11: Wire the textarea to live parsing, count, and dynamic CTA

**Files:**
- Create: `src/components/tab-input.tsx`
- Modify: `src/app/page.tsx` (replace the inert Textarea/Button block from Task 6 with `<TabInput />`)

**Interfaces:**
- Consumes: `parseTabInput` from `@/lib/tabs`, `Textarea`/`Button` from `@/components/ui/*`.
- Produces: `<TabInput />`, a self-contained client component (no props) — this is the last piece `src/app/page.tsx` needs.

- [ ] **Step 1: Build `TabInput`**

```tsx
// src/components/tab-input.tsx
"use client";

import { useDeferredValue, useMemo, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { parseTabInput } from "@/lib/tabs";

export function TabInput() {
  const [raw, setRaw] = useState("");
  const deferredRaw = useDeferredValue(raw);

  const { tabs, invalidCount } = useMemo(
    () => parseTabInput(deferredRaw),
    [deferredRaw]
  );

  const validCount = tabs.length;
  const hasInput = raw.trim().length > 0;

  const ctaLabel =
    validCount === 0
      ? "Dump my tabs →"
      : validCount === 1
        ? "Dump 1 tab →"
        : `Dump ${validCount} tabs →`;

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
        className={
          "w-full resize-none text-left text-sm transition-colors duration-150 sm:text-base" +
          (validCount > 0 ? " border-[var(--accent-9)]/60" : "")
        }
      />

      <div className="mt-2 flex min-h-[1.25rem] items-center justify-between text-xs text-tertiary">
        <span>
          {hasInput &&
            `${validCount} tab${validCount === 1 ? "" : "s"} detected${
              invalidCount > 0 ? ` · ${invalidCount} invalid` : ""
            }`}
        </span>
        <span>Paste 20, 50, or even 100 tabs at once.</span>
      </div>

      <Button size="lg" className="mt-6 w-full sm:w-auto" disabled={validCount === 0}>
        {ctaLabel}
      </Button>
    </div>
  );
}
```

Note: the helper text (`Paste 20, 50, or even 100 tabs at once.`) moves inline next to the status line so the layout doesn't jump when the status line appears — both are always-present siblings in one row, matching the "subtle, no clutter" requirement in the spec.

- [ ] **Step 2: Replace the inert block in `src/app/page.tsx`**

Remove the standalone `<Textarea>` + helper `<p>` + `<Button>` JSX added in Task 6 and render `<TabInput />` in their place (keep the `import { Header }`/`HeroBackground` and the surrounding `<main>` structure untouched).

- [ ] **Step 3: Manual verification in the browser tool**

`npm run dev`, open the page, and test:
- Typing nothing → CTA reads `Dump my tabs →` and is disabled.
- Pasting `https://github.com/a\nhttps://arxiv.org/b` → status reads `2 tabs detected`, CTA reads `Dump 2 tabs →` and is enabled.
- Pasting `https://a.com, garbage, https://b.com` → status reads `2 tabs detected · 1 invalid`.
- Pasting a single URL → CTA reads `Dump 1 tab →` (singular).
- Pasting 250 URLs (generate via `Array.from({length:250},(_,i)=>\`https://example.com/p${i}\`).join('\n')` in the browser console and paste the result) → UI stays responsive, no visible lag, correct count shown.

- [ ] **Step 4: Run the full test suite, typecheck, and lint**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
```

Expected: all PASS, zero errors.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: wire textarea to live URL parsing, count, and dynamic CTA"
```

---

### Task 12: Final Phase 1 + 2 QA pass

**Files:**
- Modify: any file, only as needed to fix issues found below.

**Interfaces:**
- None new — this task only verifies Tasks 1–11 together and patches regressions.

- [ ] **Step 1: Full automated check**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all succeed with zero errors/warnings that fail the build.

- [ ] **Step 2: Responsive re-check with real data**

In the browser tool, at 375px and 1440px, paste a realistic mixed dump (newline + comma + space separated, a few duplicates, a few bad tokens, ~30 URLs) and confirm: hero hierarchy still dominant (headline → textarea → status/CTA), no overflow, status/CTA update correctly, no layout jump.

- [ ] **Step 3: Fix anything found, then commit**

```bash
git add -A
git commit -m "fix: final QA polish for Phase 1 and Phase 2"
```

(Skip the commit if nothing needed changing.)

- [ ] **Step 4: Report completion**

Summarize what was implemented, files touched, and test results in the two `PHASE N COMPLETE` report formats specified by the user, one for Phase 1 and one for Phase 2.
