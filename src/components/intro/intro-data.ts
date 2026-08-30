import { CATEGORIES } from "@/lib/categories/definitions"
import type { CategoryId } from "@/lib/categories/types"

/** Resolves to the same CSS custom property real TabCard badges/graph nodes use for this category — the intro deliberately reuses the app's actual category palette rather than inventing a parallel one. */
export function categoryColorVar(category: CategoryId): string {
  return `var(${CATEGORIES[category].accentColor})`
}

export const BUCKET_LABEL: Record<IntroTab["bucket"], string> = {
  research: "Research",
  projects: "Projects",
  other: "Other",
}


export type IntroTab = {
  id: string
  domain: string
  label: string
  category: CategoryId
  /** Which of the intro's 3 payoff groups this tab sorts into — a coarser grouping than `category` so the "machine" output reads as 3 clean piles instead of 8 thin ones. */
  bucket: "research" | "projects" | "other"
}

function bucketFor(category: CategoryId): IntroTab["bucket"] {
  switch (category) {
    case "research":
    case "school":
      return "research"
    case "projects":
    case "creative":
      return "projects"
    default:
      return "other"
  }
}

const RAW_TABS: { domain: string; label: string; category: CategoryId }[] = [
  { domain: "arxiv.org", label: "Attention Is All You Need", category: "research" },
  { domain: "wikipedia.org", label: "Diffusion model", category: "research" },
  { domain: "scholar.google.com", label: "Cited by 412", category: "research" },
  { domain: "ncbi.nlm.nih.gov", label: "PubMed search", category: "research" },
  { domain: "coursera.org", label: "Intro to ML", category: "school" },
  { domain: "khanacademy.org", label: "Physics IA", category: "school" },
  { domain: "github.com", label: "tabdump/tabdump", category: "projects" },
  { domain: "figma.com", label: "Landing page draft", category: "projects" },
  { domain: "vercel.com", label: "Deployments", category: "projects" },
  { domain: "docs.google.com", label: "Project brief", category: "projects" },
  { domain: "notion.so", label: "Roadmap", category: "projects" },
  { domain: "linear.app", label: "TABDUMP-142", category: "projects" },
  { domain: "dribbble.com", label: "Shot: Dashboard UI", category: "creative" },
  { domain: "canva.com", label: "Poster draft", category: "creative" },
  { domain: "amazon.com", label: "Cart (3)", category: "shopping" },
  { domain: "nytimes.com", label: "Today's headlines", category: "news" },
  { domain: "theverge.com", label: "Apple event recap", category: "news" },
  { domain: "medium.com", label: "Why chaos wins", category: "read-later" },
  { domain: "mail.google.com", label: "Inbox (128)", category: "other" },
  { domain: "drive.google.com", label: "My Drive", category: "other" },
  { domain: "stackoverflow.com", label: "How to debounce…", category: "other" },
  { domain: "reddit.com", label: "r/webdev", category: "other" },
  { domain: "youtube.com", label: "React 19 talk", category: "other" },
  { domain: "calendar.google.com", label: "Today", category: "other" },
]

const DESKTOP_TABS: IntroTab[] = RAW_TABS.map((t, i) => ({
  id: `intro-tab-${i}`,
  ...t,
  bucket: bucketFor(t.category),
}))

// A curated subset — not just a slice — so the mobile scene still shows all
// 3 payoff buckets represented (see AGENTS.md's mobile example).
const MOBILE_DOMAINS = new Set([
  "wikipedia.org",
  "arxiv.org",
  "github.com",
  "figma.com",
  "notion.so",
  "reddit.com",
  "mail.google.com",
  "drive.google.com",
  "amazon.com",
])
const MOBILE_TABS: IntroTab[] = DESKTOP_TABS.filter((t) => MOBILE_DOMAINS.has(t.domain))

export function buildIntroTabs(mobile: boolean): IntroTab[] {
  return mobile ? MOBILE_TABS : DESKTOP_TABS
}

/** Per-bucket stagger for the "organized" scene's collection cards — shared with tabdump-intro.tsx so the sort-snap sound lands on the same beat as each card's entrance. */
export const CARD_STAGGER_MS = [0, 90, 180]

/** Deterministic string hash (same shape as tab-card.tsx's arrivalStyle) — seeds every per-tab pseudo-random value below so layout is stable across renders/reloads, not re-rolled on every mount. */
function hash(seed: string): number {
  let h = 0
  for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) | 0
  return Math.abs(h)
}

function rand01(id: string, salt: string): number {
  return (hash(`${id}:${salt}`) % 10000) / 10000
}

export type IntroChipLayout = {
  id: string
  /** Scattered resting position, as a percentage of the stage. */
  xPct: number
  yPct: number
  rotDeg: number
  scale: number
  /** Entrance stagger during the chaos scene. */
  entranceDelayMs: number
  /** Stagger during the converge-toward-center scene — independent of entranceDelayMs so the "wave" doesn't just replay arrival order. */
  convergeDelayMs: number
  /** Stacking order while scattered/converging, so nearby chips visibly pass over/under each other instead of all moving on the same flat plane. */
  zIndex: number
}

/** Converge-toward-center stagger is tiered by bucket (rather than fully random) so the funnel reads as a few loose waves arriving in sequence — a preview of the sorting to come — with per-tab jitter layered on top so tabs within a wave don't move in lockstep. */
const CONVERGE_TIER_MS: Record<IntroTab["bucket"], number> = { research: 0, projects: 110, other: 220 }

/**
 * One scattered position per tab, computed once from a seed rather than
 * Math.random() — the whole point is that this layout doesn't reshuffle on
 * every render (which would look like jitter, not chaos) and doesn't risk a
 * server/client mismatch (irrelevant here since TabDumpIntro only ever
 * mounts client-side, but keeping the convention matches the rest of the
 * codebase's deterministic-jitter pattern).
 *
 * Positions are biased toward a ring around the center (never the dead
 * center, which the title occupies) using polar coordinates, clamped to stay
 * on-stage and off the title band at the top. `mobile` both folds into the
 * seed (so the mobile subset gets its own spread instead of inheriting
 * whatever positions its members happened to land on in the desktop layout,
 * which could leave two of only 9 points sitting right on top of each other)
 * and tightens the horizontal clamp — a ~140px-wide chip centered at 94% of
 * a 375px-wide stage overflows past the edge in a way it never would at
 * desktop widths.
 */
export function computeChaosLayout(tabs: IntroTab[], mobile: boolean): Map<string, IntroChipLayout> {
  const map = new Map<string, IntroChipLayout>()
  const variant = mobile ? "m" : "d"
  const xClamp: [number, number] = mobile ? [16, 84] : [6, 94]
  tabs.forEach((tab) => {
    const seed = `${variant}:${tab.id}`
    const angle = rand01(seed, "angle") * Math.PI * 2
    const radius = 0.34 + rand01(seed, "radius") * 0.6
    const xPct = clamp(50 + Math.cos(angle) * radius * 46, xClamp[0], xClamp[1])
    const yPct = clamp(58 + Math.sin(angle) * radius * 34, 24, 92)
    map.set(tab.id, {
      id: tab.id,
      xPct,
      yPct,
      rotDeg: -8 + rand01(seed, "rot") * 16,
      scale: 0.86 + rand01(seed, "scale") * 0.3,
      entranceDelayMs: Math.round(rand01(seed, "entrance") * 900),
      convergeDelayMs: Math.round(CONVERGE_TIER_MS[tab.bucket] + rand01(seed, "converge") * 260),
      zIndex: Math.round(rand01(seed, "z") * 40),
    })
  })
  return map
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value))
}
