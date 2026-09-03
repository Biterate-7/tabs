import { CATEGORIES } from "@/lib/categories";
import type { CategoryId } from "@/lib/categories";
import type { RawCluster, JoinReason } from "@/lib/organize/cluster";
import { canonicalSiteIdentity } from "@/lib/organize/domain-identity";
import type { Tab } from "@/lib/tabs/types";

export type ClusterManifestEntry = {
  clusterId: string;
  tabIds: string[];
  size: number;
  sampleTitles: string[];
  dominantDomains: string[];
  categoryDistribution: string[];
  dominantJoinReason: JoinReason;
  /** Canonical site identity (domain-identity.ts) shared by a majority of this cluster's members, if any — see RawCluster.dominantDomain. */
  dominantDomain?: string;
  /** Share (0-1) of members whose canonical identity is `dominantDomain`. */
  domainShare?: number;
};

const JOIN_REASON_RANK: Record<JoinReason, number> = { semantic: 3, domain: 2, keyword: 1, none: 0 };

function dominantJoinReason(cluster: RawCluster): JoinReason {
  let best: JoinReason = "none";
  for (const reason of cluster.joinReasons.values()) {
    if (JOIN_REASON_RANK[reason] > JOIN_REASON_RANK[best]) best = reason;
  }
  return best;
}

/**
 * Compresses a RawCluster (src/lib/organize/cluster.ts's union-find output,
 * which already merges tabs by semantic/domain/keyword signal across the
 * WHOLE dump collectively) into the compact summary the AI cluster-naming
 * prompt actually needs — a handful of representative titles/domains rather
 * than every member tab. This is what keeps a 580-tab dump's manifest to
 * dozens of short entries instead of hundreds of per-tab lines, staying well
 * under MAX_PROMPT_CHARS (src/app/api/ai/organize/route.ts) in one or two
 * requests instead of the old per-tab approach's ~15 sequential chunks.
 */
export function buildClusterManifest(clusters: RawCluster[], tabsById: Map<string, Tab>): ClusterManifestEntry[] {
  return clusters.map((cluster) => {
    const members = cluster.tabIds.map((id) => tabsById.get(id)).filter((t): t is Tab => Boolean(t));

    const seenTitles = new Set<string>();
    const sampleTitles: string[] = [];
    for (const t of members) {
      const title = t.title?.trim();
      if (!title || seenTitles.has(title)) continue;
      seenTitles.add(title);
      sampleTitles.push(title);
      if (sampleTitles.length >= 5) break;
    }

    const domainCounts = new Map<string, number>();
    for (const t of members) {
      const identity = canonicalSiteIdentity(t.domain);
      domainCounts.set(identity, (domainCounts.get(identity) ?? 0) + 1);
    }
    const dominantDomains = [...domainCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([d]) => d);

    const categoryCounts = new Map<string, number>();
    for (const t of members) {
      const name = CATEGORIES[(t.category as CategoryId | undefined) ?? "other"]?.name ?? "Other";
      categoryCounts.set(name, (categoryCounts.get(name) ?? 0) + 1);
    }
    const categoryDistribution = [...categoryCounts.entries()]
      .sort((a, b) => b[1] - a[1])
      .map(([name, count]) => `${name} (${count})`);

    return {
      clusterId: cluster.id,
      tabIds: cluster.tabIds,
      size: members.length,
      sampleTitles,
      dominantDomains,
      categoryDistribution,
      dominantJoinReason: dominantJoinReason(cluster),
      dominantDomain: cluster.dominantDomain,
      domainShare: cluster.domainShare,
    };
  });
}
