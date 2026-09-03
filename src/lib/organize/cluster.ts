import type { ScopedTab, SemanticClusterHint } from "./types";
import { tabTokens } from "./keywords";
import { canonicalSiteIdentity, isGenericSiteIdentity } from "./domain-identity";

/** Precedence used when a tab ends up joined into its cluster via more than one signal — the strongest one wins for confidence scoring later. */
export type JoinReason = "semantic" | "domain" | "keyword" | "none";

const REASON_RANK: Record<JoinReason, number> = { semantic: 3, domain: 2, keyword: 1, none: 0 };

export type RawCluster = {
  id: string;
  tabIds: string[];
  /** Best join reason seen for each tab in this cluster — see UnionFind.recordReason. */
  joinReasons: Map<string, JoinReason>;
  /** Canonical site identity (see domain-identity.ts) shared by every member, when this cluster was formed (or dominated) by the hard domain-clustering stage — undefined for a cluster with no single dominant site. */
  dominantDomain?: string;
  /** Share (0-1) of this cluster's tabs whose canonical site identity equals `dominantDomain`. */
  domainShare?: number;
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
 * (2) a shared canonical site identity (domain-identity.ts) — a HARD signal:
 *     www.instagram.com / m.instagram.com / instagram.com all count as the
 *     same site, and once 2+ tabs share one, they're locked to that cluster
 *     and taken out of the keyword pool below (see domainLockedIds) so a
 *     single incidental shared word (e.g. two different projects both
 *     mentioning "notes") can never transitively bridge two unrelated site
 *     clusters into one mixed blob — the actual failure mode behind AGENTS.md's
 *     "Instagram tabs dumped into Other" regression: without this exclusion,
 *     keyword union-find's transitive closure could (and in practice did)
 *     chain together tabs from entirely different sites/topics through a
 *     sequence of weak pairwise links, none of which individually looked
 *     wrong, producing one mega-cluster mislabeled after whichever token
 *     happened to be most frequent;
 * (3) a shared significant keyword token (title/domain), bounded by
 *     document frequency as above, and restricted to tabs NOT already
 *     domain-locked by (2).
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

  const identityByTab = new Map(scopedTabs.map((st) => [st.tab.id, canonicalSiteIdentity(st.tab.domain)]));
  const byIdentity = new Map<string, string[]>();
  for (const st of scopedTabs) {
    const identity = identityByTab.get(st.tab.id)!;
    if (isGenericSiteIdentity(identity)) continue;
    const bucket = byIdentity.get(identity);
    if (bucket) bucket.push(st.tab.id);
    else byIdentity.set(identity, [st.tab.id]);
  }
  const domainLockedIds = new Set<string>();
  for (const ids of byIdentity.values()) {
    if (ids.length < 2) continue;
    for (const id of ids) domainLockedIds.add(id);
    for (let i = 1; i < ids.length; i++) uf.union(ids[0], ids[i], "domain");
  }

  const keywordPool = scopedTabs.filter((st) => !domainLockedIds.has(st.tab.id));
  const tokensByTab = new Map(keywordPool.map((st) => [st.tab.id, tabTokens(st.tab)]));
  const byToken = new Map<string, string[]>();
  for (const [tabId, tokens] of tokensByTab) {
    for (const tok of tokens) {
      const bucket = byToken.get(tok);
      if (bucket) bucket.push(tabId);
      else byToken.set(tok, [tabId]);
    }
  }

  const maxDocCount = Math.max(MIN_KEYWORD_DOC_COUNT, Math.floor(keywordPool.length * MAX_KEYWORD_DOC_FRACTION));
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

    const identityCounts = new Map<string, number>();
    for (const id of tabIds) {
      const identity = identityByTab.get(id);
      if (!identity) continue;
      identityCounts.set(identity, (identityCounts.get(identity) ?? 0) + 1);
    }
    const dominant = [...identityCounts.entries()].sort((a, b) => b[1] - a[1])[0];
    const dominantDomain = dominant && !isGenericSiteIdentity(dominant[0]) ? dominant[0] : undefined;
    const domainShare = dominant && dominantDomain ? dominant[1] / tabIds.length : undefined;

    clusters.push({ id: `cluster-${i++}-${root}`, tabIds, joinReasons, dominantDomain, domainShare });
  }
  return clusters;
}
