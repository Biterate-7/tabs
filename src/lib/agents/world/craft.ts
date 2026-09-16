/**
 * What kind of work a run appears to be doing, and therefore which room it
 * works in.
 *
 * Phase 18 put every working agent in the same three anonymous work stations,
 * filled in the order the runs were discovered. That is a fair thing to draw
 * when nothing is known about the work, and it was the only thing available:
 * the world had no vocabulary for *kinds* of work at all.
 *
 * A world with a Research Lab, a Development Room, a Writing Studio and an
 * Analysis Room needs one. This is it — and the whole of it, so there is
 * exactly one place to look when a figure is standing somewhere surprising.
 *
 * ## What this is, and what it is very deliberately not
 *
 * It decides **where a desk is**, and nothing else. It cannot make an agent
 * look busy, cannot change its state, cannot invent an activity and is never
 * consulted for a character that has no run. The caption under a figure is
 * still the run's own `currentActivity`, the detail card still lists the real
 * files and work items, and a run whose evidence says nothing stands on the
 * general operations floor rather than being assigned a speciality it never
 * claimed.
 *
 * This matters because the derivation *is* a heuristic and saying so is
 * cheaper than pretending otherwise. "Touched four `.ts` files" is strong
 * evidence about the kind of work; "the word 'review' appeared in a task
 * title" is weak. The scoring below encodes that difference rather than
 * flattening it, and the null result is a real answer that the layout engine
 * honours.
 *
 * ## Why it is not provider-derived
 *
 * Because which agent you are has nothing to do with what you are doing. A
 * world that sent one provider to the Development Room every time would be
 * asserting a specialisation the product does not observe and the providers
 * do not have — and it would make the room assignment a fact about the
 * catalogue rather than about the work, which is exactly backwards. Nothing
 * in this file can see a provider; see visual/security.test.ts.
 */

export type WorldCraft = "research" | "code" | "writing" | "analysis";

/**
 * In tie-break order.
 *
 * A total order over the crafts, so two crafts that score identically always
 * resolve the same way. Without it the room a run works in could depend on
 * object key iteration, which is stable in practice and not a thing to rely
 * on for something a person watches move.
 */
export const WORLD_CRAFTS: readonly WorldCraft[] = ["research", "code", "writing", "analysis"];

/**
 * Everything the derivation is allowed to look at.
 *
 * All four fields are already-sanitised domain strings. There is no path here
 * for raw provider text, an absolute file path or a session id: `filePaths`
 * are workspace-relative artifact paths, which is what the domain stores and
 * what the detail card already shows.
 */
export type CraftEvidence = {
  /** The run's own title. Stable for the run's whole life. */
  title?: string;
  /** The run's current activity line. The most descriptive signal, and the most volatile. */
  activity?: string;
  /** Titles of the run's work items. */
  workItemTitles?: readonly string[];
  /** Workspace-relative paths of the artifacts this run touched. */
  filePaths?: readonly string[];
};

/**
 * File extensions, by craft.
 *
 * The strongest signal available, and the reason the derivation is stable
 * enough to watch: a run's artifact list only ever grows, so evidence from
 * files accumulates instead of flickering. A run that has touched six
 * TypeScript files does not stop having touched them because its activity
 * line changed.
 *
 * The groupings are ordinary and arguable at the edges — `.sql` is filed
 * under analysis because a run touching one is far more often querying than
 * authoring a schema — and every one of them is overridable by weight of
 * evidence rather than being a veto.
 */
const EXTENSIONS: Record<WorldCraft, readonly string[]> = {
  research: ["pdf", "epub", "rtf"],
  code: [
    "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "rs", "go", "java", "rb", "php",
    "c", "h", "cc", "cpp", "hpp", "cs", "swift", "kt", "kts", "scala", "dart", "lua",
    "ex", "exs", "sh", "bash", "zsh", "ps1", "vue", "svelte", "html", "htm", "css",
    "scss", "json", "yaml", "yml", "toml", "gradle", "dockerfile",
  ],
  writing: ["md", "mdx", "markdown", "txt", "rst", "adoc", "tex", "doc", "docx", "odt"],
  analysis: ["csv", "tsv", "parquet", "ipynb", "sql", "xlsx", "xls", "db", "sqlite", "log"],
};

/**
 * Phrases, by craft.
 *
 * Substring matches against lower-cased text, which is the right amount of
 * cleverness for the job: a stemmer or a classifier would be more accurate on
 * paper and would make a figure's position depend on a model nobody can read.
 * Every phrase here is one a person can check against a task title in a
 * second, and a phrase that turns out to mislead can be deleted without
 * anything being retrained.
 *
 * Overlaps are resolved by not creating them. "documentation" reads as
 * looking something up, so it is research; the writing list asks for verbs of
 * composition instead, and neither contains the bare word "document".
 */
const PHRASES: Record<WorldCraft, readonly string[]> = {
  research: [
    "research", "investigat", "explore", "exploring", "survey", "look up", "looking up",
    "documentation", "docs for", "read the", "gather", "find out", "discover", "compare",
  ],
  code: [
    "implement", "refactor", "fix", "bug", "compile", "build", "debug", "patch",
    "migrat", "typecheck", "lint", "deploy", "install", "dependenc", "endpoint",
    "component", "function", "unit test", "test suite", "regression", "merge conflict",
  ],
  writing: [
    "write", "writing", "wrote", "draft", "rewrite", "compose", "summar", "changelog",
    "readme", "article", "blog", "outline", "prose", "copy edit", "translat",
  ],
  analysis: [
    "analy", "audit", "benchmark", "profil", "measure", "metric", "evaluat",
    "statistic", "dataset", "query", "report on", "chart", "tally", "breakdown",
  ],
};

/**
 * What each kind of evidence is worth.
 *
 * File evidence outweighs everything because it is a record of what happened
 * rather than a description of it, and because it cannot change its mind.
 * Within the text signals, a run title and a task title outweigh the activity
 * line for a reason that is about the picture rather than about accuracy: the
 * activity line is rewritten every few seconds, and a figure that changed
 * rooms every time its caption did would be unwatchable.
 */
const WEIGHT = { file: 3, title: 2, workItem: 2, activity: 1 } as const;

/** How many matching files are counted before the evidence stops accumulating. */
const FILE_EVIDENCE_CAP = 4;

/**
 * The craft a run appears to be practising, or null for "no idea".
 *
 * Null is a first-class answer and the one the layout engine treats as
 * "general work floor". It is what an agent whose run has no title, no
 * activity, no tasks and no files gets — which is a real and common state
 * early in a run, and inventing a speciality for it would be the exact kind
 * of dressing-up the rest of this layer refuses.
 */
export function deriveCraft(evidence: CraftEvidence): WorldCraft | null {
  const scores = new Map<WorldCraft, number>();

  function add(craft: WorldCraft, amount: number): void {
    scores.set(craft, (scores.get(craft) ?? 0) + amount);
  }

  // ---- Files: what the run actually touched --------------------------------

  const counted = new Map<WorldCraft, number>();
  for (const path of evidence.filePaths ?? []) {
    const craft = craftForPath(path);
    if (!craft) continue;
    const already = counted.get(craft) ?? 0;
    if (already >= FILE_EVIDENCE_CAP) continue;
    counted.set(craft, already + 1);
    add(craft, WEIGHT.file);
  }

  // ---- Words: what the run says it is doing --------------------------------

  scoreText(evidence.title, WEIGHT.title, add);
  for (const title of evidence.workItemTitles ?? []) scoreText(title, WEIGHT.workItem, add);
  scoreText(evidence.activity, WEIGHT.activity, add);

  // ---- The winner, or nobody ----------------------------------------------

  let best: WorldCraft | null = null;
  let bestScore = 0;
  // Iterated in WORLD_CRAFTS order with a strict comparison, so the first
  // craft in that order wins a tie rather than the last one examined.
  for (const craft of WORLD_CRAFTS) {
    const score = scores.get(craft) ?? 0;
    if (score > bestScore) {
      best = craft;
      bestScore = score;
    }
  }

  return best;
}

/** The craft a single path's extension suggests, if any. */
export function craftForPath(path: string): WorldCraft | null {
  const name = path.toLowerCase().split(/[\\/]/).pop() ?? "";
  // A file with no dot can still be a known name — a Dockerfile is the one
  // that actually turns up — so the whole basename is tried as well.
  const extension = name.includes(".") ? (name.split(".").pop() ?? "") : name;
  if (!extension) return null;

  for (const craft of WORLD_CRAFTS) {
    if (EXTENSIONS[craft].includes(extension)) return craft;
  }
  return null;
}

/** Adds one text field's matches to the running score. */
function scoreText(
  text: string | undefined,
  weight: number,
  add: (craft: WorldCraft, amount: number) => void
): void {
  if (!text) return;
  const haystack = text.toLowerCase();
  if (!haystack.trim()) return;

  for (const craft of WORLD_CRAFTS) {
    // One hit per craft per field. A title that says "fix the fix that fixes
    // the fix" is one piece of evidence, not three.
    if (PHRASES[craft].some((phrase) => haystack.includes(phrase))) add(craft, weight);
  }
}
