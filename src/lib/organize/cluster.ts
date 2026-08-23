import type { ScopedTab, SemanticClusterHint } from "./types";
import { GENERIC_DOMAINS, tabTokens } from "./keywords";

/** Precedence used when a tab ends up joined into its cluster via more than one signal — the strongest one wins for confidence scoring later. */
export type JoinReason = "semantic" | "domain" | "keyword" | "none";

const REASON_RANK: Record<JoinReason, number> = { semantic: 3, domain: 2, keyword: 1, none: 0 };

export type RawCluster = {
  id: string;
  tabIds: string[];
  /** Best join reason seen for each tab in this cluster — see UnionFind.recordReason. */
  joinReasons: Map<string, JoinReason>;
};

/** Standard union-find with path compression + union by size — plenty fast for the hundreds of tabs a real library holds. */
class UnionFind {
  private parent = new Map<string, string>();
  private size = new Map<string, number>();
  private bestReason = new Map<string, JoinReason>();

  add(id: string): void {
    if (!this.parent.has(id)) {
      this.parent.set(id, id);
      this.size.set(id, 1);
      this.bestReason.set(id, "none");
    }
  }

  find(id: string): string {
    let root = id;
    while (this.parent.get(root) !== root) root = this.parent.get(root)!;
    let cur = id;
    while (this.parent.get(cur) !== root) {
      const next = this.parent.get(cur)!;
      this.parent.set(cur, root);
      cur = next;
    }
    return root;
  }

  recordReason(id: string, reason: JoinReason): void {
    const current = this.bestReason.get(id) ?? "none";
    if (REASON_RANK[reason] > REASON_RANK[current]) this.bestReason.set(id, reason);
  }

  reasonFor(id: string): JoinReason {
    return this.bestReason.get(id) ?? "none";
  }

  union(a: string, b: string, reason: JoinReason): void {
    this.recordReason(a, reason);
    this.recordReason(b, reason);
    const rootA = this.find(a);
    const rootB = this.find(b);
    if (rootA === rootB) return;
    const sizeA = this.size.get(rootA) ?? 1;
    const sizeB = this.size.get(rootB) ?? 1;
    const [big, small] = sizeA >= sizeB ? [rootA, rootB] : [rootB, rootA];
    this.parent.set(small, big);
    this.size.set(big, sizeA + sizeB);
  }

  groups(): Map<string, string[]> {
    const out = new Map<string, string[]>();
    for (const id of this.parent.keys()) {
      const root = this.find(id);
      const bucket = out.get(root);
      if (bucket) bucket.push(id);
      else out.set(root, [id]);
    }
    return out;
  }
}

/**
 * Keyword document frequency lets keyword-based joining ignore both overly
 * rare (typo/one-off) and overly generic (present in nearly everything)
 * tokens — a token shared by only 1 tab can't cluster anything, and one
 * shared by most of the library is too generic to mean anything. Processing
 * from rarest to most common lets specific shared vocabulary (e.g.
 * "schwarzschild") drive strong unions before generic ones ever get a
 * chance to over-merge unrelated tabs.
 */
const MAX_KEYWORD_DOC_FRACTION = 0.75;
const MIN_KEYWORD_DOC_COUNT = 2;

/**
 * Groups tabs into raw candidate clusters using, in order of strength:
 * (1) a shared semantic-cluster key from client-side embedding clustering
 *     (see src/lib/ai/cluster.ts) — the strongest signal, since it reflects
 *     actual page meaning even across differently-worded titles (AGENTS.md's
 *     "General Relativity Notes" / "Schwarzschild Metric" / "S2 Star Orbit
 *     Data" example);
 * (2) an exact non-generic domain match;
 * (3) a shared significant keyword token (title/domain), bounded by
 *     document frequency as above.
 * Pure and read-only — never touches a WorkspaceStore.
 */
export function buildRawClusters(scopedTabs: ScopedTab[], semanticHints: SemanticClusterHint[] = []): RawCluster[] {
  const uf = new UnionFind();
  for (const st of scopedTabs) uf.add(st.tab.id);
  if (scopedTabs.length === 0) return [];

  const semanticKeyByTab = new Map(semanticHints.map((h) => [h.tabId, h.clusterKey]));

  const bySemanticKey = new Map<string, string[]>();
  for (const st of scopedTabs) {
    const key = semanticKeyByTab.get(st.tab.id);
    if (!key) continue;
    const bucket = bySemanticKey.get(key);
    if (bucket) bucket.push(st.tab.id);
    else bySemanticKey.set(key, [st.tab.id]);
  }
  for (const ids of bySemanticKey.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i], "semantic");
  }

  const byDomain = new Map<string, string[]>();
  for (const st of scopedTabs) {
    const domain = st.tab.domain.toLowerCase();
    if (GENERIC_DOMAINS.has(domain)) continue;
    const bucket = byDomain.get(domain);
    if (bucket) bucket.push(st.tab.id);
    else byDomain.set(domain, [st.tab.id]);
  }
  for (const ids of byDomain.values()) {
    if (ids.length < 2) continue;
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i], "domain");
  }

  const tokensByTab = new Map(scopedTabs.map((st) => [st.tab.id, tabTokens(st.tab)]));
  const byToken = new Map<string, string[]>();
  for (const [tabId, tokens] of tokensByTab) {
    for (const tok of tokens) {
      const bucket = byToken.get(tok);
      if (bucket) bucket.push(tabId);
      else byToken.set(tok, [tabId]);
    }
  }

  const maxDocCount = Math.max(MIN_KEYWORD_DOC_COUNT, Math.floor(scopedTabs.length * MAX_KEYWORD_DOC_FRACTION));
  const eligibleTokens = [...byToken.entries()]
    .filter(([, ids]) => ids.length >= MIN_KEYWORD_DOC_COUNT && ids.length <= maxDocCount)
    .sort((a, b) => a[1].length - b[1].length);

  for (const [, ids] of eligibleTokens) {
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i], "keyword");
  }

  const groups = uf.groups();
  const clusters: RawCluster[] = [];
  let i = 0;
  for (const [root, tabIds] of groups) {
    const joinReasons = new Map<string, JoinReason>();
    for (const id of tabIds) joinReasons.set(id, uf.reasonFor(id));
    clusters.push({ id: `cluster-${i++}-${root}`, tabIds, joinReasons });
  }
  return clusters;
}
