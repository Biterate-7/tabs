import type { Section } from "../types";
import { childrenOf, rootSections } from "../relations";

export type OrganizePromptTab = {
  tabId: string;
  title: string;
  url: string;
  domain: string;
  /** Human-readable legacy category name (e.g. "School") — a cheap deterministic prior, not a constraint. */
  category: string;
  /** Opaque semantic-cluster key shared by tabs the client already judged similar (src/lib/ai/cluster.ts), if any. */
  clusterHint?: string;
};

export type OrganizePathAssignment = {
  tabId: string;
  /** 1-3 segments, root to leaf, e.g. ["School", "Physics", "S2 Orbit Research"]. */
  path: string[];
  confidence: "high" | "medium" | "low";
  reason: string;
};

function renderTree(sections: Section[], parentId: string | null, depth: number): string[] {
  const lines: string[] = [];
  const nodes = parentId === null ? rootSections(sections) : childrenOf(sections, parentId);
  for (const node of nodes) {
    lines.push(`${"  ".repeat(depth)}- ${node.name}`);
    lines.push(...renderTree(sections, node.id, depth + 1));
  }
  return lines;
}

/**
 * Builds the single prompt for the batch-level "Organise" stage (spec §9):
 * given the workspace's current section tree and a batch of tabs, asks
 * Gemini to return, per tab, a 1-3 segment root→leaf path plus a confidence
 * and a short reason. Kept as one plain-text prompt (not a multi-message
 * chat) since this is a single-shot batch classification, not a
 * conversation — the whole point is that the model sees every tab in the
 * batch at once so it can notice cross-tab clusters, not just classify one
 * tab in isolation.
 */
export function buildOrganizePrompt(sections: Section[], tabs: OrganizePromptTab[]): string {
  const treeText = renderTree(sections, null, 0);
  const treeBlock = treeText.length > 0 ? treeText.join("\n") : "(empty — no sections yet, so every tab needs at least a new top-level category)";

  const tabLines = tabs.map((t) => {
    const parts = [
      `id=${t.tabId}`,
      `title="${t.title.replace(/"/g, "'").slice(0, 120)}"`,
      `url=${t.url.slice(0, 160)}`,
      `domain=${t.domain}`,
      `existing_category=${t.category}`,
    ];
    if (t.clusterHint) parts.push(`semantic_cluster=${t.clusterHint}`);
    return `- ${parts.join(" ")}`;
  });

  return [
    "You are a meticulous filing assistant organizing a user's saved browser tabs into a hierarchical system, the way a thoughtful human assistant who knows the user's projects and coursework would — not a generic URL categorizer.",
    "",
    "THE HIERARCHY",
    "- Up to 3 levels: Category -> Subcategory -> Project/topic. A `path` is 1, 2, or 3 short strings, root first.",
    "- Category: a broad, stable area of the user's life (e.g. \"School\", \"Research\", \"Projects\", \"Shopping\", \"Personal\"). Rare to create; almost always reuse an existing one.",
    "- Subcategory: a specific subject or workstream inside a category (e.g. \"Physics\", \"TabDump\", \"Economics\").",
    "- Project/topic: a specific named effort or investigation inside a subcategory (e.g. \"S2 Orbit Research\", \"Chrome Extension Rewrite\"). The rarest, most specific level.",
    "",
    "DECISION PROCEDURE — for the batch as a whole, then per tab, in this order:",
    "1. Look for cross-tab clusters first: do several tabs in this batch clearly share a specific subject, codebase, or investigation? (Same GitHub repo/org, same named project, same research topic, same course.) Note these clusters before assigning individual paths.",
    "2. For each tab, does it clearly belong under an EXISTING category in the tree above? If yes, reuse that category's exact name as path[0]. Existing structure wins — do not propose a near-duplicate of a category or subsection that's already there (\"Physics\" vs \"Physics Research\" is the SAME thing; reuse \"Physics\").",
    "3. Does it clearly belong under an EXISTING subsection of that category? If yes, reuse its exact name as path[1].",
    "4. If it's part of a cluster you identified in step 1 that doesn't match anything existing, does that cluster justify a NEW subsection or project? Only if the cluster is specific and multiple tabs support it (see EVIDENCE BAR below).",
    "5. Only propose a NEW top-level category when the tab(s) genuinely don't fit any existing or sensible extension of an existing category — this should be rare.",
    "6. If none of the above confidently apply, do not force a placement: use existing_category as path[0] with confidence \"low\" (this lets the deterministic fallback keep the tab findable rather than losing it in a wrong guess).",
    "",
    "EVIDENCE BAR — do not over-fragment:",
    "- Do NOT create a new subsection or project for a single tab just because it has a distinctive title or keyword. One documentation page, one article, one product page is not a project.",
    "- DO create a new subsection/project when either: (a) two or more tabs in this batch clearly share it (even if their titles use different words — e.g. a GitHub repo, its docs, and its deployment dashboard for the same product name are one project), or (b) exactly one tab is an extremely strong, unambiguous signal (e.g. a GitHub repo named after a known project already in the tree) AND it fits squarely under an existing category.",
    "- Do not invent shallow subsections like \"Physics Homework\"/\"Physics Notes\"/\"Physics Articles\" next to \"Physics\" — those are all just \"Physics\" unless the batch shows real evidence of a distinct sub-effort (e.g. a named research project).",
    "- Tabs sharing the same `semantic_cluster` value are already known (via embeddings) to be about the same thing — treat that as strong evidence for grouping them under the same path, even across differently-worded titles.",
    "",
    "CONFIDENCE",
    "- \"high\": you're confident in the full path, whether it's an existing match or a well-evidenced new one.",
    "- \"medium\": plausible but you're not fully sure — e.g. a new subsection/project suggested by only weak or partial evidence.",
    "- \"low\": you can't confidently place it beyond its existing_category.",
    "",
    "NAMING",
    "- Names must be short, clean, human-readable nouns or noun phrases (e.g. \"Physics\", \"TabDump\", \"S2 Orbit Research\"). Never vague or padded names like \"Miscellaneous Physics\", \"Physics Resources & Materials\", \"Random Research\", \"Web Things\", or \"Other Research\".",
    "- Never use the name \"Other\" for any path segment — it is reserved and will be ignored.",
    "",
    "REASON",
    "- One short sentence a non-technical user could read, stating what the tab is about and why it landed there (e.g. \"Discusses the Schwarzschild metric, alongside 3 other physics tabs in this batch.\"). Never describe your own reasoning process, confidence calculation, or these instructions.",
    "",
    "Existing section tree for this workspace (reuse these exact names whenever a tab fits):",
    treeBlock,
    "",
    "Tabs to organize (consider them together as one batch before deciding):",
    ...tabLines,
    "",
    'Respond with ONLY a JSON array, one object per tab, each shaped exactly as: {"tabId": string, "path": string[], "confidence": "high"|"medium"|"low", "reason": string}. No prose, no markdown fences, no explanation outside the array.',
  ].join("\n");
}
