import type { CategoryId } from "@/lib/categories"

/**
 * The single fictional browsing session every demo on this page draws from.
 *
 * One corpus, not one per section: the page tells a continuous story (these
 * tabs get dumped in the hero, organized further down, searched, and restored
 * from history near the end), and a reader who notices "arxiv.org — Attention
 * Is All You Need" in three different demos should be seeing the *same* tab
 * each time.
 *
 * It is deliberately plain data with no dependency on the workspace store.
 * Marketing demos never read or write real workspace state: nothing on this
 * page imports from @/lib/workspace, so a demo cannot mutate a visitor's
 * saved workspaces even by accident.
 */
export type DemoTab = {
  id: string
  domain: string
  title: string
  category: CategoryId
  /** Root → child section this tab lands in once organized (the "From chaos to structure" tree). */
  section: string
  subsection: string
  /**
   * Marks one of the deliberately repeated entries. The corpus contains real
   * repeats (four GitHub tabs, three Docs tabs) because the duplicate demo
   * collapses actual rows rather than illustrating a collapse that never
   * happened.
   */
  duplicateOf?: string
}

let seq = 0
function tab(
  domain: string,
  title: string,
  category: CategoryId,
  section: string,
  subsection: string,
  duplicateOf?: string
): DemoTab {
  return { id: `d${seq++}`, domain, title, category, section, subsection, duplicateOf }
}

export const DEMO_TABS: DemoTab[] = [
  // --- Research -----------------------------------------------------------
  tab("arxiv.org", "Attention Is All You Need", "research", "Research", "Papers"),
  tab("arxiv.org", "Denoising Diffusion Probabilistic Models", "research", "Research", "Papers"),
  tab("arxiv.org", "Attention Is All You Need", "research", "Research", "Papers", "arxiv-attention"),
  tab("scholar.google.com", "Cited by 41,203", "research", "Research", "Sources"),
  tab("nature.com", "Room-temperature superconductivity", "research", "Research", "Papers"),
  tab("pubmed.ncbi.nlm.nih.gov", "Sleep latency meta-analysis", "research", "Research", "Sources"),
  tab("wikipedia.org", "Thermodynamic free energy", "research", "Research", "Sources"),
  tab("wikipedia.org", "Quantum decoherence", "research", "Research", "Sources"),
  tab("semanticscholar.org", "Related: 128 papers", "research", "Research", "Sources"),
  tab("notion.so", "Literature review notes", "research", "Research", "Notes"),

  // --- School -------------------------------------------------------------
  tab("khanacademy.org", "Entropy and the second law", "school", "School", "Physics"),
  tab("myopenmath.com", "Problem set 7 — due Friday", "school", "School", "Physics"),
  tab("coursera.org", "Macroeconomics · Week 4", "school", "School", "Economics"),
  tab("investopedia.com", "What is quantitative easing?", "school", "School", "Economics"),
  tab("spanishdict.com", "Subjuntivo — practice", "school", "School", "Spanish"),
  tab("wordreference.com", "aprovechar", "school", "School", "Spanish"),
  tab("docs.google.com", "Physics IA draft v4", "school", "School", "Physics"),

  // --- Projects / development --------------------------------------------
  tab("github.com", "vercel/next.js · Issues", "projects", "Development", "GitHub"),
  tab("github.com", "vercel/next.js · Issues", "projects", "Development", "GitHub", "gh-next"),
  tab("github.com", "tabdump/tabdump · Pull requests", "projects", "Development", "GitHub"),
  tab("github.com", "tabdump/tabdump · Pull requests", "projects", "Development", "GitHub", "gh-tabdump"),
  tab("developer.mozilla.org", "IntersectionObserver", "projects", "Development", "Documentation"),
  tab("developer.mozilla.org", "CSS custom properties", "projects", "Development", "Documentation"),
  tab("react.dev", "useSyncExternalStore", "projects", "Development", "Documentation"),
  tab("stackoverflow.com", "Debounce inside useEffect", "projects", "Development", "References"),
  tab("linear.app", "TBD-412 · Spatial canvas", "projects", "Development", "References"),
  tab("vercel.com", "tabdump — Deployments", "projects", "Development", "References"),

  // --- Creative -----------------------------------------------------------
  tab("figma.com", "Landing page — exploration", "creative", "Design", "Working files"),
  tab("dribbble.com", "Dark dashboard studies", "creative", "Design", "Inspiration"),
  tab("fonts.google.com", "Geist · specimen", "creative", "Design", "Inspiration"),

  // --- Shopping -----------------------------------------------------------
  tab("amazon.com", "Standing desk — 48\"", "shopping", "Personal", "Shopping"),
  tab("keychron.com", "K3 Pro low-profile", "shopping", "Personal", "Shopping"),

  // --- News / read later --------------------------------------------------
  tab("nytimes.com", "Morning briefing", "news", "Personal", "Reading"),
  tab("theverge.com", "The tab problem nobody solved", "news", "Personal", "Reading"),
  tab("longform.org", "The case against inbox zero", "read-later", "Personal", "Reading"),
  tab("newyorker.com", "Annals of attention", "read-later", "Personal", "Reading"),

  // --- Other --------------------------------------------------------------
  tab("mail.google.com", "Inbox (312)", "other", "Personal", "Everything else"),
  tab("calendar.google.com", "Week of Oct 14", "other", "Personal", "Everything else"),
  tab("youtube.com", "Lecture 8 — Fourier transforms", "other", "Personal", "Everything else"),
  tab("reddit.com", "r/webdev — weekly thread", "other", "Personal", "Everything else"),
]

/** The corpus with repeats removed, i.e. what a dump actually keeps. */
export const DEMO_UNIQUE_TABS: DemoTab[] = DEMO_TABS.filter((t) => !t.duplicateOf)

export const DEMO_DUPLICATE_COUNT = DEMO_TABS.length - DEMO_UNIQUE_TABS.length

/**
 * The headline count in the hero. Larger than the corpus on purpose — the
 * demo renders a representative sample of a session, not all of it, and the
 * copy says so ("a slice of a real session"). Kept here so the number can
 * never drift between the button label, the counter and the result line.
 */
export const HERO_TAB_COUNT = 142

export type DemoSection = {
  name: string
  /** The category whose accent colors this section, so the tree and the spatial canvas agree. */
  category: CategoryId
  children: { name: string; count: number }[]
}

/** The organized shape of the corpus — derived, so it can never disagree with DEMO_TABS. */
export const DEMO_SECTIONS: DemoSection[] = (() => {
  const order = ["Research", "School", "Development", "Design", "Personal"]
  const byName = new Map<string, DemoSection>()

  for (const t of DEMO_UNIQUE_TABS) {
    let section = byName.get(t.section)
    if (!section) {
      section = { name: t.section, category: t.category, children: [] }
      byName.set(t.section, section)
    }
    const child = section.children.find((c) => c.name === t.subsection)
    if (child) child.count += 1
    else section.children.push({ name: t.subsection, count: 1 })
  }

  return order.flatMap((name) => {
    const s = byName.get(name)
    return s ? [s] : []
  })
})()

/** Fictional saved sessions for the History Dump demo. */
export type DemoSession = {
  id: string
  label: string
  when: string
  tabCount: number
  /** Domains shown as a favicon cluster on the row — a glance-able fingerprint of the session. */
  domains: string[]
}

export const DEMO_SESSIONS: DemoSession[] = [
  {
    id: "yesterday",
    label: "Yesterday afternoon",
    when: "Wed · 2:10 – 6:45 PM",
    tabCount: 42,
    domains: ["arxiv.org", "wikipedia.org", "scholar.google.com", "notion.so", "nature.com"],
  },
  {
    id: "monday",
    label: "Monday deep work",
    when: "Mon · 9:00 AM – 1:20 PM",
    tabCount: 87,
    domains: ["github.com", "developer.mozilla.org", "react.dev", "linear.app", "vercel.com"],
  },
  {
    id: "thesis",
    label: "Thesis sources",
    when: "Last week",
    tabCount: 31,
    domains: ["pubmed.ncbi.nlm.nih.gov", "semanticscholar.org", "arxiv.org", "nature.com"],
  },
  {
    id: "project-x",
    label: "Redesign research",
    when: "Oct 2 – Oct 6",
    tabCount: 64,
    domains: ["figma.com", "dribbble.com", "fonts.google.com", "theverge.com"],
  },
]

/** Workspaces for the workspace-switching demo. */
export type DemoWorkspace = {
  id: string
  name: string
  tally: string
  /** Which sections of the corpus this workspace shows — keeps its contents honest. */
  sections: string[]
  accent: CategoryId
}

export const DEMO_WORKSPACES: DemoWorkspace[] = [
  { id: "thesis", name: "Thesis", tally: "2 sections", sections: ["Research", "School"], accent: "research" },
  { id: "build", name: "Building TabDump", tally: "2 sections", sections: ["Development", "Design"], accent: "projects" },
  { id: "life", name: "Personal", tally: "1 section", sections: ["Personal"], accent: "read-later" },
]

/**
 * A deterministic 0–1 value from a string. Every demo that wants per-item
 * variation (scatter positions, animation delays, drift) derives it from the
 * tab's own id through this, so the page looks identical on the server and
 * on every client — `Math.random()` in a render would hydrate mismatched.
 */
/**
 * Rounds a computed layout number before it reaches the markup.
 *
 * Not cosmetic. `Math.cos`/`Math.sin` are implementation-defined in
 * ECMAScript, and Node's V8 and Chrome's do not always agree in the last ULP —
 * so a transform built from them serialises as `8.05984891768965cqw` on the
 * server and `8.059848917689651cqw` in the browser, which React reports as a
 * hydration mismatch on every element that uses one. Three decimals is far
 * finer than a subpixel at these scales and makes the string identical on both
 * sides (and shorter in the HTML).
 */
export function roundLayout(n: number): number {
  return Math.round(n * 1000) / 1000
}

export function hashUnit(seed: string, salt = 0): number {
  let h = 2166136261 ^ salt
  for (let i = 0; i < seed.length; i++) {
    h ^= seed.charCodeAt(i)
    h = Math.imul(h, 16777619)
  }
  return ((h >>> 0) % 100000) / 100000
}
