# TabDump Phase 3: Categorization Engine Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a local, deterministic, scoring-based URL categorization engine that assigns each parsed `Tab` a `category` and `confidence`, wired as the final step of the existing `parse → normalize → deduplicate` pipeline. No UI/dashboard changes.

**Architecture:** `src/lib/categories/definitions.ts` centralizes the 8 category definitions (id/name/icon/description/accent). `src/lib/categories/rules.ts` holds a flat, additive rule table (domain + keyword signals) per category — no if/else chains. `src/lib/categories/classify.ts` sums matching rule scores per category, picks the argmax, converts to a 0–1 confidence, and falls back to `Other` below a minimum-confidence threshold. `src/lib/categories/index.ts` exposes `categorizeTabs(tabs): Tab[]`, imported into `src/lib/tabs/index.ts`'s `parseTabInput` as the new final pipeline step.

**Tech Stack:** TypeScript, Vitest (existing setup from Phase 2), lucide-react (existing).

## Global Constraints

- Exactly 8 categories, this spelling/order: Research, School, Projects, Shopping, Creative, News, Read Later, Other.
- No `if (domain === X) else if (domain === Y)` chains anywhere — categorization is a flat, additive, data-driven rule table.
- Every classification includes a numeric `confidence` (0–1). Below the minimum-confidence threshold, category is forced to `Other`.
- No network calls, no AI calls — categorization is 100% local and synchronous.
- `Tab.category` remains a plain mutable string field (already exists from Phase 2) so a future manual override never touches engine code.
- Do not build dashboard/workspace UI. Do not render category badges anywhere yet.
- Do not use page title as a signal yet (not available); design signal extraction so it's a trivial future addition.

---

### Task 1: Category definitions and shared types

**Files:**
- Create: `src/lib/categories/types.ts`
- Create: `src/lib/categories/definitions.ts`
- Test: `src/lib/categories/definitions.test.ts`

**Interfaces:**
- Produces: `CategoryId` union type, `CategoryDefinition` type, `CATEGORIES: Record<CategoryId, CategoryDefinition>`, `CATEGORY_ORDER: CategoryId[]` — consumed by every later task.

- [ ] **Step 1: Write the failing test**

```ts
// src/lib/categories/definitions.test.ts
import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_ORDER } from "./definitions";

describe("CATEGORIES", () => {
  it("defines exactly the 8 required categories in order", () => {
    expect(CATEGORY_ORDER).toEqual([
      "research",
      "school",
      "projects",
      "shopping",
      "creative",
      "news",
      "read-later",
      "other",
    ]);
  });

  it("gives every category an id, name, icon, description, and accent color", () => {
    for (const id of CATEGORY_ORDER) {
      const def = CATEGORIES[id];
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.icon).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.accentColor.length).toBeGreaterThan(0);
    }
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/categories/definitions.test.ts
```

Expected: FAIL — `definitions.ts` does not exist.

- [ ] **Step 3: Implement `types.ts`**

```ts
// src/lib/categories/types.ts
import type { LucideIcon } from "lucide-react";

export type CategoryId =
  | "research"
  | "school"
  | "projects"
  | "shopping"
  | "creative"
  | "news"
  | "read-later"
  | "other";

export type CategoryDefinition = {
  id: CategoryId;
  name: string;
  icon: LucideIcon;
  description: string;
  /** CSS variable name (defined in globals.css) carrying this category's subtle accent color. */
  accentColor: string;
};

export type UrlContext = {
  hostname: string;
  pathname: string;
  search: string;
  href: string;
};

export type CategoryScores = Record<CategoryId, number>;

export type Classification = {
  category: CategoryId;
  confidence: number;
  scores: CategoryScores;
};
```

- [ ] **Step 4: Implement `definitions.ts`**

```ts
// src/lib/categories/definitions.ts
import {
  FlaskConical,
  GraduationCap,
  FolderGit2,
  ShoppingCart,
  Palette,
  Newspaper,
  Bookmark,
  CircleHelp,
} from "lucide-react";
import type { CategoryDefinition, CategoryId } from "./types";

export const CATEGORY_ORDER: CategoryId[] = [
  "research",
  "school",
  "projects",
  "shopping",
  "creative",
  "news",
  "read-later",
  "other",
];

export const CATEGORIES: Record<CategoryId, CategoryDefinition> = {
  research: {
    id: "research",
    name: "Research",
    icon: FlaskConical,
    description: "Papers, journals, and academic sources.",
    accentColor: "--category-research",
  },
  school: {
    id: "school",
    name: "School",
    icon: GraduationCap,
    description: "Coursework, learning platforms, and class materials.",
    accentColor: "--category-school",
  },
  projects: {
    id: "projects",
    name: "Projects",
    icon: FolderGit2,
    description: "Code, deployment, and product-building tools.",
    accentColor: "--category-projects",
  },
  shopping: {
    id: "shopping",
    name: "Shopping",
    icon: ShoppingCart,
    description: "Product pages, carts, and marketplaces.",
    accentColor: "--category-shopping",
  },
  creative: {
    id: "creative",
    name: "Creative",
    icon: Palette,
    description: "Design, illustration, and portfolio tools.",
    accentColor: "--category-creative",
  },
  news: {
    id: "news",
    name: "News",
    icon: Newspaper,
    description: "Articles from news and media outlets.",
    accentColor: "--category-news",
  },
  "read-later": {
    id: "read-later",
    name: "Read Later",
    icon: Bookmark,
    description: "Blogs, long-form writing, and docs worth revisiting.",
    accentColor: "--category-read-later",
  },
  other: {
    id: "other",
    name: "Other",
    icon: CircleHelp,
    description: "Anything that doesn't confidently fit elsewhere.",
    accentColor: "--category-other",
  },
};
```

- [ ] **Step 5: Run and confirm it passes**

```bash
npx vitest run src/lib/categories/definitions.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Add the 8 accent CSS variables to `globals.css`**

In `src/app/globals.css`'s `.dark { ... }` block (alongside the existing `--success`/`--warning` additions from Phase 1), add subtle, mostly-desaturated accents so the base UI stays monochrome and these only matter once badges are built in a later phase:

```css
  --category-research: #8b7cf6;
  --category-school: #f5a623;
  --category-projects: #4361ff;
  --category-shopping: #22c55e;
  --category-creative: #ec4899;
  --category-news: #38bdf8;
  --category-read-later: #a1a1aa;
  --category-other: #71717a;
```

- [ ] **Step 7: Typecheck and commit**

```bash
npx tsc --noEmit
git add -A
git commit -m "feat: add category definitions (8 categories, icons, accent tokens)"
```

---

### Task 2: URL context extraction and rule table

**Files:**
- Create: `src/lib/categories/context.ts`
- Create: `src/lib/categories/rules.ts`
- Test: `src/lib/categories/rules.test.ts`

**Interfaces:**
- Consumes: `CategoryId` (Task 1).
- Produces: `toUrlContext(normalizedUrl: string): UrlContext`, `RULES: SignalRule[]` where `SignalRule = { category: CategoryId; score: number; test: (ctx: UrlContext) => boolean; label: string }` — consumed by Task 3's scoring engine. `label` exists purely for test readability/debugging (which rule fired).

- [ ] **Step 1: Implement `context.ts` (no test needed — trivial wrapper, exercised transitively by Task 3's tests)**

```ts
// src/lib/categories/context.ts
import type { UrlContext } from "./types";

export function toUrlContext(normalizedUrl: string): UrlContext {
  const url = new URL(normalizedUrl);
  return {
    hostname: url.hostname.toLowerCase(),
    pathname: url.pathname.toLowerCase(),
    search: url.search.toLowerCase(),
    href: normalizedUrl.toLowerCase(),
  };
}
```

- [ ] **Step 2: Write the failing test for the rule table's shape**

```ts
// src/lib/categories/rules.test.ts
import { describe, expect, it } from "vitest";
import { RULES } from "./rules";
import { toUrlContext } from "./context";

function matchingCategories(url: string): string[] {
  const ctx = toUrlContext(url);
  return RULES.filter((r) => r.test(ctx)).map((r) => r.category);
}

describe("RULES", () => {
  it("has at least one high-confidence rule per category except other", () => {
    const categories = new Set(RULES.map((r) => r.category));
    for (const id of [
      "research",
      "school",
      "projects",
      "shopping",
      "creative",
      "news",
      "read-later",
    ]) {
      expect(categories.has(id as never)).toBe(true);
    }
  });

  it("matches research high-confidence domains", () => {
    for (const url of [
      "https://arxiv.org/abs/1234",
      "https://scholar.google.com/citations",
      "https://pubmed.ncbi.nlm.nih.gov/12345",
      "https://www.researchgate.net/publication/1",
      "https://www.jstor.org/stable/1",
      "https://www.semanticscholar.org/paper/1",
    ]) {
      expect(matchingCategories(url)).toContain("research");
    }
  });

  it("matches school high-confidence domains", () => {
    for (const url of [
      "https://classroom.google.com/c/1",
      "https://canvas.instructure.com/courses/1",
      "https://moodle.org/course/view.php",
    ]) {
      expect(matchingCategories(url)).toContain("school");
    }
  });

  it("matches projects high-confidence domains", () => {
    for (const url of [
      "https://github.com/foo/bar",
      "https://gitlab.com/foo/bar",
      "https://bitbucket.org/foo/bar",
      "https://vercel.com/dashboard",
      "https://supabase.com/dashboard",
      "https://linear.app/team/issue/1",
    ]) {
      expect(matchingCategories(url)).toContain("projects");
    }
  });

  it("matches shopping high-confidence domains across TLDs", () => {
    for (const url of [
      "https://www.amazon.com/dp/xyz",
      "https://www.amazon.in/dp/xyz",
      "https://www.flipkart.com/product/1",
      "https://www.myntra.com/product/1",
      "https://www.ebay.com/itm/1",
      "https://www.etsy.com/listing/1",
    ]) {
      expect(matchingCategories(url)).toContain("shopping");
    }
  });

  it("matches creative high-confidence domains", () => {
    for (const url of [
      "https://www.canva.com/design/1",
      "https://www.figma.com/file/1",
      "https://www.behance.net/gallery/1",
      "https://dribbble.com/shots/1",
      "https://www.pinterest.com/pin/1",
    ]) {
      expect(matchingCategories(url)).toContain("creative");
    }
  });

  it("matches known news domains", () => {
    for (const url of [
      "https://www.bbc.com/news/1",
      "https://www.nytimes.com/2026/01/01/world/article.html",
      "https://www.reuters.com/world/1",
      "https://www.theguardian.com/world/1",
    ]) {
      expect(matchingCategories(url)).toContain("news");
    }
  });

  it("matches read-later blog/docs signals", () => {
    for (const url of [
      "https://someblog.substack.com/p/my-post",
      "https://dev.to/someone/a-post",
      "https://docs.example.com/getting-started",
      "https://example.com/blog/my-long-post",
    ]) {
      expect(matchingCategories(url)).toContain("read-later");
    }
  });

  it("gives figma both creative (high) and projects (medium) signals", () => {
    const cats = matchingCategories("https://www.figma.com/file/1");
    expect(cats).toContain("creative");
    expect(cats).toContain("projects");
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
npx vitest run src/lib/categories/rules.test.ts
```

Expected: FAIL — `rules.ts` does not exist.

- [ ] **Step 4: Implement `rules.ts`**

```ts
// src/lib/categories/rules.ts
import type { CategoryId, UrlContext } from "./types";

export type SignalRule = {
  category: CategoryId;
  score: number;
  label: string;
  test: (ctx: UrlContext) => boolean;
};

const HIGH = 90;
const MEDIUM = 55;
const KEYWORD = 20;

function hostIs(...domains: string[]) {
  return (ctx: UrlContext) =>
    domains.some(
      (d) => ctx.hostname === d || ctx.hostname.endsWith(`.${d}`)
    );
}

function hostIncludes(...fragments: string[]) {
  return (ctx: UrlContext) =>
    fragments.some((f) => ctx.hostname.includes(f));
}

function pathIncludes(...fragments: string[]) {
  return (ctx: UrlContext) =>
    fragments.some((f) => ctx.pathname.includes(f) || ctx.search.includes(f));
}

export const RULES: SignalRule[] = [
  // Research
  {
    category: "research",
    score: HIGH,
    label: "research-high-domain",
    test: hostIs(
      "arxiv.org",
      "scholar.google.com",
      "pubmed.ncbi.nlm.nih.gov",
      "researchgate.net",
      "jstor.org",
      "semanticscholar.org"
    ),
  },
  {
    category: "research",
    score: MEDIUM,
    label: "research-medium-domain",
    test: hostIs("wikipedia.org", "medium.com"),
  },
  {
    category: "research",
    score: MEDIUM,
    label: "research-edu-tld",
    test: (ctx) => ctx.hostname.endsWith(".edu"),
  },
  {
    category: "research",
    score: KEYWORD,
    label: "research-keyword",
    test: pathIncludes("/doi/", "/abs/", "paper", "abstract"),
  },

  // School
  {
    category: "school",
    score: HIGH,
    label: "school-high-domain",
    test: hostIs("classroom.google.com", "blackboard.com", "instructure.com"),
  },
  {
    category: "school",
    score: HIGH,
    label: "school-high-keyword-domain",
    test: hostIncludes("canvas", "moodle"),
  },
  {
    category: "school",
    score: MEDIUM,
    label: "school-medium-domain",
    test: hostIs("docs.google.com", "drive.google.com", "notion.so"),
  },
  {
    category: "school",
    score: KEYWORD,
    label: "school-keyword",
    test: pathIncludes("assignment", "syllabus", "course", "lecture"),
  },

  // Projects
  {
    category: "projects",
    score: HIGH,
    label: "projects-high-domain",
    test: hostIs(
      "github.com",
      "gitlab.com",
      "bitbucket.org",
      "vercel.com",
      "supabase.com",
      "linear.app"
    ),
  },
  {
    category: "projects",
    score: MEDIUM,
    label: "projects-medium-domain",
    test: hostIs("notion.so", "figma.com"),
  },

  // Shopping
  {
    category: "shopping",
    score: HIGH,
    label: "shopping-high-domain",
    test: hostIncludes("amazon.", "flipkart.com", "myntra.com", "ebay.", "etsy.com"),
  },
  {
    category: "shopping",
    score: KEYWORD,
    label: "shopping-keyword",
    test: pathIncludes("/cart", "/checkout", "/dp/", "/product/"),
  },

  // Creative
  {
    category: "creative",
    score: HIGH,
    label: "creative-high-domain",
    test: hostIs(
      "canva.com",
      "figma.com",
      "behance.net",
      "dribbble.com",
      "pinterest.com"
    ),
  },

  // News
  {
    category: "news",
    score: HIGH,
    label: "news-high-domain",
    test: hostIs(
      "bbc.com",
      "bbc.co.uk",
      "cnn.com",
      "reuters.com",
      "theguardian.com",
      "nytimes.com",
      "washingtonpost.com",
      "apnews.com",
      "npr.org",
      "bloomberg.com",
      "wsj.com",
      "aljazeera.com",
      "ndtv.com",
      "hindustantimes.com",
      "indianexpress.com",
      "timesofindia.indiatimes.com"
    ),
  },
  {
    category: "news",
    score: KEYWORD,
    label: "news-keyword",
    test: pathIncludes("/news/", "/article/", "/breaking/"),
  },

  // Read Later
  {
    category: "read-later",
    score: MEDIUM,
    label: "read-later-blog-domain",
    test: hostIncludes(
      "substack.com",
      "dev.to",
      "hashnode.com",
      "blogspot.com",
      "wordpress.com"
    ),
  },
  {
    category: "read-later",
    score: KEYWORD,
    label: "read-later-docs-subdomain",
    test: hostIncludes("docs."),
  },
  {
    category: "read-later",
    score: KEYWORD,
    label: "read-later-keyword",
    test: pathIncludes("/blog/", "/posts/", "/article", "/docs/", "/p/"),
  },
];
```

- [ ] **Step 5: Run and confirm it passes**

```bash
npx vitest run src/lib/categories/rules.test.ts
```

Expected: all tests PASS.

- [ ] **Step 6: Commit**

```bash
git add -A
git commit -m "feat: add data-driven categorization rule table (domain + keyword signals)"
```

---

### Task 3: Scoring and classification

**Files:**
- Create: `src/lib/categories/classify.ts`
- Test: `src/lib/categories/classify.test.ts`

**Interfaces:**
- Consumes: `RULES` (Task 2), `CATEGORY_ORDER` (Task 1), `Classification`/`CategoryScores` types (Task 1).
- Produces: `scoreUrl(normalizedUrl: string): CategoryScores`, `classifyUrl(normalizedUrl: string): Classification` — consumed by Task 4's `categorizeTabs`.

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/categories/classify.test.ts
import { describe, expect, it } from "vitest";
import { classifyUrl, scoreUrl } from "./classify";

describe("scoreUrl", () => {
  it("returns a score for every category, defaulting to 0", () => {
    const scores = scoreUrl("https://example.com/");
    expect(Object.keys(scores)).toHaveLength(8);
    expect(scores.other).toBe(0);
  });

  it("sums multiple matching rules for the same category", () => {
    // github.com matches the projects-high-domain rule only, so this
    // checks a case where two rules stack: a school docs domain plus
    // a course keyword in the path.
    const scores = scoreUrl("https://docs.google.com/document/course-notes");
    expect(scores.school).toBeGreaterThan(55);
  });
});

describe("classifyUrl", () => {
  it("classifies GitHub as Projects with high confidence", () => {
    const result = classifyUrl("https://github.com/foo/bar");
    expect(result.category).toBe("projects");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies GitLab as Projects with high confidence", () => {
    const result = classifyUrl("https://gitlab.com/foo/bar");
    expect(result.category).toBe("projects");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies arXiv as Research with high confidence", () => {
    const result = classifyUrl("https://arxiv.org/abs/1234.5678");
    expect(result.category).toBe("research");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies Google Scholar as Research", () => {
    const result = classifyUrl("https://scholar.google.com/citations?user=1");
    expect(result.category).toBe("research");
  });

  it("classifies Wikipedia as Research with medium confidence", () => {
    const result = classifyUrl("https://en.wikipedia.org/wiki/Cat");
    expect(result.category).toBe("research");
    expect(result.confidence).toBeGreaterThanOrEqual(0.5);
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("classifies Amazon as Shopping", () => {
    const result = classifyUrl("https://www.amazon.in/dp/B0ABCDEFG");
    expect(result.category).toBe("shopping");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies Flipkart as Shopping", () => {
    const result = classifyUrl("https://www.flipkart.com/product/p/itm1");
    expect(result.category).toBe("shopping");
  });

  it("classifies Google Classroom as School", () => {
    const result = classifyUrl("https://classroom.google.com/c/abc123");
    expect(result.category).toBe("school");
    expect(result.confidence).toBeGreaterThanOrEqual(0.9);
  });

  it("classifies Canva as Creative", () => {
    const result = classifyUrl("https://www.canva.com/design/DAF.../edit");
    expect(result.category).toBe("creative");
  });

  it("classifies Figma as Creative over Projects (higher weight wins)", () => {
    const result = classifyUrl("https://www.figma.com/file/abc/My-Design");
    expect(result.category).toBe("creative");
    expect(result.scores.projects).toBeGreaterThan(0);
    expect(result.scores.creative).toBeGreaterThan(result.scores.projects);
  });

  it("classifies YouTube as Other (no strong signal defined for it yet)", () => {
    const result = classifyUrl("https://www.youtube.com/watch?v=abc123");
    expect(result.category).toBe("other");
  });

  it("classifies a major news site as News", () => {
    const result = classifyUrl(
      "https://www.bbc.com/news/world-europe-12345678"
    );
    expect(result.category).toBe("news");
  });

  it("classifies an unknown site as Other with low confidence", () => {
    const result = classifyUrl("https://totally-unknown-site-xyz123.com/");
    expect(result.category).toBe("other");
    expect(result.confidence).toBeLessThan(0.4);
  });

  it("classifies an ambiguous personal blog as Read Later, not confidently something else", () => {
    const result = classifyUrl("https://someone.substack.com/p/my-thoughts");
    expect(result.category).toBe("read-later");
    expect(result.confidence).toBeLessThan(0.9);
  });

  it("never returns a confidence above 1", () => {
    const result = classifyUrl("https://github.com/foo/bar");
    expect(result.confidence).toBeLessThanOrEqual(1);
  });
});
```

- [ ] **Step 2: Run and confirm it fails**

```bash
npx vitest run src/lib/categories/classify.test.ts
```

Expected: FAIL — `classify.ts` does not exist.

- [ ] **Step 3: Implement `classify.ts`**

```ts
// src/lib/categories/classify.ts
import { CATEGORY_ORDER } from "./definitions";
import { RULES } from "./rules";
import { toUrlContext } from "./context";
import type { CategoryId, CategoryScores, Classification } from "./types";

const MIN_CONFIDENT_SCORE = 40;
const MAX_SCORE = 100;

function emptyScores(): CategoryScores {
  const scores = {} as CategoryScores;
  for (const id of CATEGORY_ORDER) scores[id] = 0;
  return scores;
}

export function scoreUrl(normalizedUrl: string): CategoryScores {
  const scores = emptyScores();
  let ctx;
  try {
    ctx = toUrlContext(normalizedUrl);
  } catch {
    return scores;
  }

  for (const rule of RULES) {
    if (rule.test(ctx)) {
      scores[rule.category] = Math.min(
        MAX_SCORE,
        scores[rule.category] + rule.score
      );
    }
  }

  return scores;
}

function argmaxCategory(scores: CategoryScores): CategoryId {
  let best: CategoryId = CATEGORY_ORDER[0];
  for (const id of CATEGORY_ORDER) {
    if (scores[id] > scores[best]) best = id;
  }
  return best;
}

export function classifyUrl(normalizedUrl: string): Classification {
  const scores = scoreUrl(normalizedUrl);
  const winner = argmaxCategory(scores);
  const winningScore = scores[winner];

  if (winningScore < MIN_CONFIDENT_SCORE) {
    return {
      category: "other",
      confidence: Math.max(0, winningScore / MAX_SCORE),
      scores,
    };
  }

  return {
    category: winner,
    confidence: Math.min(1, winningScore / MAX_SCORE),
    scores,
  };
}
```

- [ ] **Step 4: Run and confirm it passes**

```bash
npx vitest run src/lib/categories/classify.test.ts
```

Expected: all tests PASS. If the Wikipedia or Figma tests fail on score magnitudes, adjust `MEDIUM`/`KEYWORD` weights in `rules.ts` (Task 2), not the classifier logic — the classifier is generic.

- [ ] **Step 5: Commit**

```bash
git add -A
git commit -m "feat: add scoring-based classification with confidence and Other fallback"
```

---

### Task 4: Pipeline integration — `categorizeTabs`

**Files:**
- Create: `src/lib/categories/index.ts`
- Modify: `src/lib/tabs/types.ts` (add `confidence?: number` to `Tab`)
- Modify: `src/lib/tabs/index.ts` (add categorization as the final `parseTabInput` step)
- Test: `src/lib/categories/index.test.ts`
- Test: append to `src/lib/tabs/index.test.ts`

**Interfaces:**
- Consumes: `classifyUrl` (Task 3), `Tab` (from `src/lib/tabs/types.ts`).
- Produces: `categorizeTabs(tabs: Tab[]): Tab[]` — consumed by `src/lib/tabs/index.ts`'s `parseTabInput`, which becomes the full `parse → normalize → deduplicate → categorize` pipeline.

- [ ] **Step 1: Add `confidence` to the `Tab` type**

In `src/lib/tabs/types.ts`, add one field to the existing `Tab` type:

```ts
export type Tab = {
  id: string;
  url: string;
  normalizedUrl: string;
  domain: string;
  category?: string;
  confidence?: number;
  title?: string;
  favicon?: string;
  isDuplicate?: boolean;
};
```

- [ ] **Step 2: Write the failing test for `categorizeTabs`**

```ts
// src/lib/categories/index.test.ts
import { describe, expect, it } from "vitest";
import { categorizeTabs } from "./index";
import type { Tab } from "@/lib/tabs/types";

function makeTab(url: string, normalizedUrl: string): Tab {
  return { id: url, url, normalizedUrl, domain: new URL(normalizedUrl).hostname };
}

describe("categorizeTabs", () => {
  it("assigns category and confidence to every tab without mutating originals", () => {
    const input = [
      makeTab("https://github.com/a", "https://github.com/a"),
      makeTab("https://unknown-xyz.com/", "https://unknown-xyz.com/"),
    ];
    const result = categorizeTabs(input);

    expect(result).toHaveLength(2);
    expect(result[0].category).toBe("projects");
    expect(typeof result[0].confidence).toBe("number");
    expect(result[1].category).toBe("other");

    // originals untouched
    expect(input[0].category).toBeUndefined();
  });

  it("preserves all other tab fields", () => {
    const input = [
      { ...makeTab("https://github.com/a", "https://github.com/a"), isDuplicate: true },
    ];
    const result = categorizeTabs(input);
    expect(result[0].isDuplicate).toBe(true);
    expect(result[0].id).toBe(input[0].id);
  });
});
```

- [ ] **Step 3: Run and confirm it fails**

```bash
npx vitest run src/lib/categories/index.test.ts
```

Expected: FAIL — `src/lib/categories/index.ts` does not exist.

- [ ] **Step 4: Implement `src/lib/categories/index.ts`**

```ts
// src/lib/categories/index.ts
import { classifyUrl } from "./classify";
import type { Tab } from "@/lib/tabs/types";

export * from "./types";
export { CATEGORIES, CATEGORY_ORDER } from "./definitions";
export { classifyUrl, scoreUrl } from "./classify";

export function categorizeTabs(tabs: Tab[]): Tab[] {
  return tabs.map((tab) => {
    const { category, confidence } = classifyUrl(tab.normalizedUrl);
    return { ...tab, category, confidence };
  });
}
```

- [ ] **Step 5: Run and confirm it passes**

```bash
npx vitest run src/lib/categories/index.test.ts
```

Expected: both tests PASS.

- [ ] **Step 6: Wire into `parseTabInput`**

In `src/lib/tabs/index.ts`, add the import and final step:

```ts
// src/lib/tabs/index.ts (full file)
import { parseUrls } from "./parse";
import { markDuplicates } from "./duplicates";
import { categorizeTabs } from "@/lib/categories";
import type { ParseResult } from "./types";

export * from "./types";
export { parseUrls, splitInput } from "./parse";
export { normalizeUrl, TRACKING_PARAMS } from "./normalize";
export { markDuplicates } from "./duplicates";

export function parseTabInput(raw: string): ParseResult {
  const { tabs, invalidCount } = parseUrls(raw);
  const deduplicated = markDuplicates(tabs);
  return { tabs: categorizeTabs(deduplicated), invalidCount };
}
```

- [ ] **Step 7: Append an end-to-end pipeline test**

Append to `src/lib/tabs/index.test.ts`:

```ts
it("runs the full parse -> normalize -> dedupe -> categorize pipeline", () => {
  const { tabs, invalidCount } = parseTabInput(
    "https://github.com/a, https://arxiv.org/abs/1, not-a-url-!!, https://github.com/a"
  );
  expect(invalidCount).toBe(1);
  expect(tabs).toHaveLength(3);
  expect(tabs[0].category).toBe("projects");
  expect(tabs[1].category).toBe("research");
  expect(tabs[2].isDuplicate).toBe(true);
  expect(tabs[2].category).toBe("projects");
});
```

- [ ] **Step 8: Run the whole `src/lib` suite and confirm everything passes**

```bash
npx vitest run src/lib
```

Expected: all test files pass (existing Phase 2 tests + new Phase 3 tests).

- [ ] **Step 9: Typecheck, lint, and commit**

```bash
npx tsc --noEmit
npm run lint
git add -A
git commit -m "feat: integrate categorization into parseTabInput pipeline (parse -> normalize -> dedupe -> categorize)"
```

---

### Task 5: Large-dataset performance and final QA

**Files:**
- Test: append to `src/lib/categories/classify.test.ts` (performance case)
- Modify: any file, only if QA finds an issue.

**Interfaces:**
- None new — verifies Tasks 1–4 hold up at scale and QA-gates the phase.

- [ ] **Step 1: Add a 250-URL performance test**

Append to `src/lib/categories/classify.test.ts`:

```ts
it("classifies 250 mixed URLs quickly", () => {
  const domains = [
    "github.com/a",
    "arxiv.org/abs/1",
    "amazon.in/dp/x",
    "totally-unknown-xyz.com/",
    "canva.com/design/1",
  ];
  const urls = Array.from(
    { length: 250 },
    (_, i) => `https://${domains[i % domains.length]}?n=${i}`
  );
  const start = performance.now();
  for (const url of urls) classifyUrl(url);
  const elapsed = performance.now() - start;
  expect(elapsed).toBeLessThan(200);
});
```

Run: `npx vitest run src/lib/categories/classify.test.ts` — expect PASS.

- [ ] **Step 2: Full automated check**

```bash
npx vitest run
npx tsc --noEmit
npm run lint
npm run build
```

Expected: all succeed with zero errors.

- [ ] **Step 3: Manual dev-server smoke test**

Start the dev server, paste a realistic mixed dump into the existing textarea (unchanged from Phase 2), and confirm in the browser console that categorization runs without throwing — e.g. `import("@/lib/tabs").then(m => console.log(m.parseTabInput("https://github.com/a\nhttps://arxiv.org/b").tabs))` and inspect that `category`/`confidence` are present. The UI itself does not display categories yet (out of scope), so this is a data-layer smoke test only.

- [ ] **Step 4: Fix anything found, then commit**

```bash
git add -A
git commit -m "test: add categorization performance test; final Phase 3 QA"
```

(Skip the commit if nothing needed changing.)

- [ ] **Step 5: Report completion**

Summarize categories, engine design, confidence system, test results, and any fixes in the `PHASE 3 COMPLETE` format specified by the user.
