# TabDump — Phase 1 & 2 Design

## Product
TabDump: paste browser tabs, turn the chaos into an organized workspace. Minimal, technical, premium, calm, dark-first. Not a generic SaaS template, not colorful, not a bloated dashboard.

## Phase 1 — Foundation & Design System

**Stack**: Next.js (App Router) + TypeScript + Tailwind CSS, initialized fresh (repo was empty). shadcn/ui for accessible primitives (Button, Textarea), restyled via our tokens. `lucide-react` for icons. Geist Sans/Mono via `next/font`. npm.

**Design tokens** (CSS variables, dark-first):
- Background layers: `--bg-base` (near-black), `--bg-surface` (cards), `--bg-elevated` (popovers), `--bg-input`.
- Border: `--border-subtle`, `--border-default`.
- Text: `--text-primary`, `--text-secondary`, `--text-tertiary`.
- Accent: indigo/blue scale (chosen by user) for primary actions/interactive states; small green (success) and amber (warning) scales reserved for later phases.
- Typography scale: hero (clamp-based, large + tight tracking), section heading, body, metadata/small.
- One radius scale (sm/md/lg), soft low-opacity shadows, restrained 150–200ms transitions.

**Components** (only what's clearly reused): Button (primary/secondary/ghost), IconButton, Card/Surface, Textarea, Input, Badge, minimal Header (wordmark only).

**Landing page**: Header → Hero (headline "Your tabs are a mess. Dump them." + subtext) → central Textarea + helper text + CTA → subtle decorative background (faint gradient/grid, restrained focus glow). No backend logic — this phase is visual/UI foundation only.

**Explicitly excluded from Phase 1**: auth, database, API routes, AI, categorization, URL parsing, browser extension, dashboard, payments.

## Phase 2 — URL Ingestion, Parsing & Input Experience

Builds on Phase 1's shell/textarea/CTA without redesigning the visual system.

**Parsing utility** (`lib/tabs/parse.ts` or similar, pure functions, unit-testable, no logic in components):
- Split pasted text on newlines, commas, spaces, and tabs (any mix).
- Trim, drop empties, prepend `https://` when a token looks like a bare domain, validate with `URL`.
- Never throw on garbage input — invalid tokens are collected separately, not fatal.

**Normalization** (`lib/tabs/normalize.ts`):
- Produce `normalizedUrl` (lowercased host, stripped tracking params: `utm_source`, `utm_medium`, `utm_campaign`, `utm_term`, `utm_content`, `fbclid`, `gclid`) used only for comparison/dedup.
- `originalUrl` is always preserved unmodified.

**Tab type** (`lib/tabs/types.ts`):
```ts
type Tab = {
  id: string
  url: string
  normalizedUrl: string
  domain: string
  category?: string
  title?: string
  favicon?: string
  isDuplicate?: boolean
}
```

**Duplicate detection**: exact and normalized-equivalent duplicates are flagged (`isDuplicate`), not removed.

**UI behavior** (in the existing textarea/CTA, restyled Phase 1 components — no new page structure):
- Live "N tabs detected" / "N tabs detected · M invalid" subtle status line below the textarea, debounced/memoized so it doesn't lag on large pastes (tested up to 250 URLs).
- CTA label reflects count: "Dump my tabs →" (0) / "Dump 1 tab →" / "Dump N tabs →"; disabled when there are zero valid URLs.
- Subtle textarea border/state change and status indicator on valid input; no heavy animation.

**Testing**: unit tests (Vitest or Jest — pick whichever adds less setup overhead in a fresh Next.js app) covering newline/comma/space/tab/mixed splitting, normalization, tracking-param stripping, duplicate detection (exact + normalized), invalid URLs, missing-protocol URLs, and mixed valid/invalid input.

**Explicitly excluded from Phase 2**: actually navigating to a workspace/results view, categorization logic, favicon fetching over the network, removing duplicates (only flagging).
