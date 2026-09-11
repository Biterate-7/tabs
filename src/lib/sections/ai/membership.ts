/**
 * Whether a cluster's members actually belong at the path the cluster is about
 * to be filed under.
 *
 * src/lib/organize/cluster.ts answers "which tabs go together", and a shared
 * website is legitimate evidence there — a cluster of 14 Instagram tabs is a
 * real thing, and it becomes a real "Instagram" section. But the pipeline then
 * applies ONE path to every member of a cluster at once (pipeline.ts's
 * applyClusterEntry), and at that point the question has changed: not "do
 * these tabs go together" but "is this tab about the topic this section names".
 * A shared platform cannot answer the second question, and treating it as
 * though it could is what put an organic-chemistry video, an economics video
 * and a gaming montage into "Physics > Projectile Motion" — marked
 * `classified`, at high confidence — because two projectile-motion videos in
 * the same cluster were also on youtube.com.
 *
 * So membership is validated against the SECTION, never against whichever
 * member happened to seed the cluster. Only the tabs with no evidence of their
 * own are asked to justify themselves, and only when the section names a
 * topic; a section that names the platform IS the platform, and every member
 * of a platform cluster belongs in it by definition.
 */
import type { JoinReason } from "@/lib/organize/cluster";
import { canonicalSiteIdentity, getDomainSectionName } from "@/lib/organize/domain-identity";
import { contentTokens, tokenize, tokenOverlap } from "@/lib/organize/keywords";
import { findSimilarSibling } from "../normalize";
import type { Tab } from "@/lib/tabs/types";

export type ClusterMembershipInput = {
  members: Tab[];
  /** The path the cluster is about to be filed at. */
  path: string[];
  /** Per-tab join reason from buildRawClusters — see RawCluster.joinReasons. */
  joinReasons: ReadonlyMap<string, JoinReason>;
  /** Tab id → semantic cluster key, for the tabs that have one. */
  semanticKeyByTabId: ReadonlyMap<string, string>;
};

export type ClusterMembership = {
  /** Members that belong at `path` and are placed there. */
  belong: Tab[];
  /**
   * Members that are in this cluster only because they share a platform with
   * somebody who does. Not placed here; the caller hands them back to the
   * stages that place leftovers, which regroup them by site into a section
   * that IS their platform.
   */
  released: Tab[];
};

/**
 * Whether `leafName` names the site `tab` is on, rather than a topic — the
 * "YouTube" / "Instagram" / "GitHub" section, where the platform is the
 * concept and every member belongs by definition. Compared through
 * findSimilarSibling, the same near-match rule that decides whether a path
 * reuses an existing section, so "Youtube" and "YouTube" agree here exactly as
 * they would there.
 */
function namesTheSite(leafName: string, tab: Tab): boolean {
  const siteName = getDomainSectionName(tab.domain);
  return findSimilarSibling([siteName], leafName) !== null;
}

/**
 * Content-level support for `leafName` from the tab's own title, with the
 * site's name excluded — see keywords.ts's contentTokens for why that
 * exclusion is the point rather than a detail.
 */
function supportsConcept(tab: Tab, leafName: string): boolean {
  return tokenOverlap(contentTokens(tab), tokenize(leafName)) > 0;
}

/**
 * Splits a cluster's members into those that belong at `path` and those that
 * are only riding along on a shared platform.
 *
 * Everything is kept — `released` empty — when:
 *   - the path is a single root category, which is broad by design and not
 *     where the reported contamination happens (the evidence gate in
 *     pipeline.ts draws the same line); or
 *   - the leaf names the cluster's own site, so the platform IS the concept; or
 *   - no member can be validated at all, which says the path does not describe
 *     this cluster rather than that the cluster is wrong — releasing every
 *     member would be a bigger claim than the evidence supports.
 *
 * A member is validated when ANY of these holds, in the order the architecture
 * already ranks its signals:
 *   - it joined on a content signal (`semantic` — embeddings agreeing across
 *     differently-worded titles — or `keyword`), so it has evidence of its own;
 *   - its own title supports the section's name;
 *   - it shares an embedding cluster with a member validated above, which is
 *     the embedding saying "same topic as that one" rather than "same website".
 */
export function partitionClusterMembers(input: ClusterMembershipInput): ClusterMembership {
  const { members, path, joinReasons, semanticKeyByTabId } = input;
  const leafName = path[path.length - 1]?.trim() ?? "";
  if (path.length <= 1 || !leafName) return { belong: members, released: [] };
  if (members.some((tab) => namesTheSite(leafName, tab))) return { belong: members, released: [] };

  const belong: Tab[] = [];
  const undecided: Tab[] = [];
  for (const tab of members) {
    const reason = joinReasons.get(tab.id) ?? "none";
    if (reason !== "domain" || supportsConcept(tab, leafName)) belong.push(tab);
    else undecided.push(tab);
  }

  if (belong.length === 0) return { belong: members, released: [] };

  // One pass is enough: a shared key with an ALREADY-validated member is the
  // claim being admitted, and chaining it through newly-admitted members is
  // exactly the transitive contamination this function exists to stop.
  const validatedKeys = new Set<string>();
  for (const tab of belong) {
    const key = semanticKeyByTabId.get(tab.id);
    if (key) validatedKeys.add(key);
  }

  const released: Tab[] = [];
  for (const tab of undecided) {
    const key = semanticKeyByTabId.get(tab.id);
    if (key && validatedKeys.has(key)) belong.push(tab);
    else released.push(tab);
  }

  // Member order is an input to naming and to the deterministic fallback path,
  // so it is restored rather than left as "validated first".
  const belongIds = new Set(belong.map((t) => t.id));
  return { belong: members.filter((t) => belongIds.has(t.id)), released };
}

/** Whether a cluster's own dominant site is what `leafName` names — the cluster-level counterpart to namesTheSite, for callers holding a canonical identity rather than a tab. */
export function pathNamesPlatform(leafName: string, dominantDomain: string | undefined): boolean {
  if (!dominantDomain) return false;
  return findSimilarSibling([getDomainSectionName(canonicalSiteIdentity(dominantDomain))], leafName) !== null;
}
