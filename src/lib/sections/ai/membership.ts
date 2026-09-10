/**
 * Per-(tab, section) membership evidence — the gate every "put THIS tab in
 * THAT group" decision passes through.
 *
 * Why this exists: before it, group membership was only ever decided at the
 * GROUP level and then applied to member tabs wholesale. A cluster's path was
 * applied to every one of its tabs (pipeline.ts Stage E), a leftover was
 * folded in on a bare Jaccard score (Stage F.1), and — the actual reported
 * bug — organize.ts's per-tab AI branch applied any path that already existed
 * regardless of confidence and with no relevance check at all, so a model that
 * reasoned "ManageBac is a school platform, this tab is school-ish, file it
 * there" was obeyed verbatim and genius.com/aistudio.google.com landed inside
 * a ManageBac group.
 *
 * The rule here is deliberately about EVIDENCE, not association: a tab may
 * join a specific topic/site group only when something about that tab itself
 * — its domain, its URL, its title — ties it to that group. Being in the same
 * dump, sharing a broad subject ("school", "AI", "education"), or sitting next
 * to a member that IS related are all explicitly not enough.
 *
 * Deliberately deterministic and dependency-free, same spirit as
 * src/lib/organize/keywords.ts: this is the check that decides whether the
 * model's answer is trusted, so it can't itself be another model call.
 */

import { CATEGORIES } from "@/lib/categories";
import { canonicalSiteIdentity, getDomainSectionName, isGenericSiteIdentity } from "@/lib/organize/domain-identity";
import { tabTokens, tokenize } from "@/lib/organize/keywords";
import type { Tab } from "@/lib/tabs/types";
import type { Section } from "../types";

/** The minimum a membership check needs to know about a tab — a real Tab always satisfies it. */
export type MembershipTab = { title?: string; url: string; domain: string };

/**
 * One tab already believed to be in the section, as context for judging
 * another. Deliberately carries nothing but the tab: a member earns the right
 * to vouch for a peer from its own site/name evidence (see isAnchor), never
 * from an upstream assertion that it belongs. That is what stops a group's
 * mistakes from justifying more of the same.
 */
export type CohortMember = { tab: MembershipTab };

/**
 * Why a tab is allowed in a section, or "none" — the only verdict that rejects.
 *
 * - "broad": the section isn't making a topical claim at all (a category like
 *   "School", or a generic bucket like "Reference"), so there is nothing for
 *   the tab to be a false positive OF.
 * - "site": the tab is on the site the section is about.
 * - "name": the tab's own title/URL/domain names the section's subject.
 * - "peer": the tab shares specific vocabulary with a member that is itself
 *   anchored to the section — the one indirect form of evidence, and only
 *   ever one hop from an anchor, never chained through other unanchored tabs.
 *
 * There is deliberately no "can't tell" verdict. Absent evidence is "none":
 * a tab that cannot be shown to belong is kept out, and callers route it to a
 * broad category or a deterministic bucket instead. That direction of error
 * is the cheap one — a tab filed one level too general is findable and
 * obviously so, while a tab sitting inside a group it has nothing to do with
 * is silently wrong. It also means an empty `cohort` never softens the check:
 * not knowing who else is in a group is not a reason to admit someone.
 */
export type MembershipEvidence = "broad" | "site" | "name" | "peer" | "none";

/** How many significant tokens a tab must share with an anchored member to earn "peer" evidence. One shared word is a coincidence ("assignments", "notes"); two is a topic. */
const MIN_PEER_TOKENS = 2;
/** A site has to actually dominate a section before section membership can be read off it. */
const DOMINANT_SITE_MIN_MEMBERS = 2;
const DOMINANT_SITE_MIN_SHARE = 0.5;
/** Below this, a collapsed section name is too short to substring-match a haystack without matching by accident ("AI" inside "airline"). */
const MIN_SUBSTRING_NAME_LENGTH = 4;

/** Legacy category names — the broadest level of the tree, never a topical claim about a tab. */
const CATEGORY_NAMES = new Set(Object.values(CATEGORIES).map((c) => c.name.toLowerCase()));

/**
 * Names that describe a bucket rather than a subject. A tab landing in one of
 * these can be a poor filing decision, but it can't be the failure this module
 * exists to stop: nobody reads "Reference" as a claim that the tab is about
 * ManageBac. Kept separate from CATEGORY_NAMES so the two can diverge.
 */
const GENERIC_SECTION_NAMES = new Set([
  "general", "general resources", "reference", "resources", "miscellaneous", "misc",
  "unsorted", "uncategorized", "unfiled", "personal", "work", "life", "learning",
  "education", "entertainment", "media", "social", "social media", "tools",
  "utilities", "technology", "tech", "finance", "health", "travel", "food",
  "productivity", "documents", "reading", "inbox", "bookmarks", "saved", "links",
  "web", "internet", "browsing", "stuff", "things",
]);

/** Qualifiers that don't narrow what a section is ABOUT — mirrors src/lib/sections/normalize.ts's REDUNDANT_SUFFIXES, applied here in any position rather than only the last word. */
const NON_IDENTIFYING_WORDS = new Set([
  "research", "resources", "materials", "study", "stuff", "notes", "docs",
  "documents", "links", "misc", "miscellaneous", "general", "other", "related",
  "various", "assorted",
]);

function normalizeName(name: string): string {
  return name.toLowerCase().trim().replace(/[^a-z0-9\s]/g, "").replace(/\s+/g, " ");
}

/** Lowercase, alphanumerics only — lets "ManageBac" match "managebac.com" and "Google Docs" match "... - Google Docs". */
function collapse(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Whether `name` is a broad category or generic bucket rather than a specific
 * topic/site. Membership in one of these is never gated — see
 * MembershipEvidence's "broad".
 */
export function isBroadSectionName(name: string): boolean {
  const normalized = normalizeName(name);
  if (!normalized) return true;
  return CATEGORY_NAMES.has(normalized) || GENERIC_SECTION_NAMES.has(normalized);
}

/**
 * The tokens of `name` that actually identify its subject — "S2 Orbit
 * Research" identifies "orbit", not "research". Falls back to the unfiltered
 * tokens when stripping would leave nothing, so a section genuinely called
 * "Notes" still has something to match on.
 */
export function sectionIdentityTokens(name: string): string[] {
  const all = tokenize(name);
  const identifying = all.filter((t) => !NON_IDENTIFYING_WORDS.has(t));
  return identifying.length > 0 ? identifying : all;
}

/**
 * Direct textual evidence that this tab is about `sectionName`: the name
 * appears in the tab's own title, URL or domain, or the tab's significant
 * tokens include one of the name's identifying tokens. This is the evidence a
 * "ManageBac" group can demand of a candidate and that genius.com or
 * aistudio.google.com cannot supply.
 */
export function tabNamesSection(tab: MembershipTab, sectionName: string): boolean {
  const collapsedName = collapse(sectionName);
  if (collapsedName.length >= MIN_SUBSTRING_NAME_LENGTH) {
    const haystack = collapse(`${tab.title ?? ""} ${tab.url} ${tab.domain}`);
    if (haystack.includes(collapsedName)) return true;
  }
  const identityTokens = sectionIdentityTokens(sectionName);
  if (identityTokens.length === 0) return false;
  const tokens = new Set(tabTokens(tab));
  return identityTokens.some((t) => tokens.has(t));
}

/**
 * The canonical site identity a majority of `cohort` shares, if any — the
 * thing that makes an "Instagram" or "ManageBac" section a SITE group rather
 * than a topic group. Generic springboards (google.com, bing.com — see
 * domain-identity.ts) never count.
 */
export function dominantSiteIdentity(cohort: CohortMember[]): string | undefined {
  if (cohort.length === 0) return undefined;
  const counts = new Map<string, number>();
  for (const member of cohort) {
    const identity = canonicalSiteIdentity(member.tab.domain);
    if (isGenericSiteIdentity(identity)) continue;
    counts.set(identity, (counts.get(identity) ?? 0) + 1);
  }
  const dominant = [...counts.entries()].sort((a, b) => b[1] - a[1])[0];
  if (!dominant) return undefined;
  const [identity, count] = dominant;
  if (count < DOMINANT_SITE_MIN_MEMBERS || count / cohort.length < DOMINANT_SITE_MIN_SHARE) return undefined;
  return identity;
}

/** Whether the tab is on the section's site — either the cohort's dominant site, or a site whose own brand name IS the section name (so a lone Instagram tab still belongs in "Instagram"). */
function tabIsOnSectionSite(tab: MembershipTab, sectionName: string, dominantIdentity: string | undefined): boolean {
  const identity = canonicalSiteIdentity(tab.domain);
  if (isGenericSiteIdentity(identity)) return false;
  if (dominantIdentity && identity === dominantIdentity) return true;
  return normalizeName(getDomainSectionName(tab.domain)) === normalizeName(sectionName);
}

/** A cohort member fit to vouch for others: one carrying direct site or name evidence of its own. */
function isAnchor(member: CohortMember, sectionName: string, dominantIdentity: string | undefined): boolean {
  return tabIsOnSectionSite(member.tab, sectionName, dominantIdentity) || tabNamesSection(member.tab, sectionName);
}

function sharedTokenCount(tokens: Set<string>, other: string[]): number {
  let shared = 0;
  for (const token of new Set(other)) if (tokens.has(token)) shared++;
  return shared;
}

/**
 * Why (if at all) `tab` belongs in the section named `sectionName`, given the
 * tabs already believed to be in it. Pure and side-effect free; callers decide
 * what to do with a "none" verdict.
 *
 * `cohort` is context that can only ever ADMIT a tab, never exclude one: with
 * it, a tab can earn "peer" evidence it couldn't earn alone. An empty cohort
 * therefore makes the check stricter, not laxer — which is the safe
 * direction, and why callers are expected to supply whatever they know
 * (see organizeTabsCollectively's `contextTabs`) rather than needing to.
 */
export function evaluateMembership(tab: MembershipTab, sectionName: string, cohort: CohortMember[] = []): MembershipEvidence {
  if (isBroadSectionName(sectionName)) return "broad";

  const dominantIdentity = dominantSiteIdentity(cohort);
  if (tabIsOnSectionSite(tab, sectionName, dominantIdentity)) return "site";
  if (tabNamesSection(tab, sectionName)) return "name";

  const tokens = new Set(tabTokens(tab));
  for (const member of cohort) {
    if (member.tab === tab) continue;
    if (!isAnchor(member, sectionName, dominantIdentity)) continue;
    if (sharedTokenCount(tokens, tabTokens(member.tab)) >= MIN_PEER_TOKENS) return "peer";
  }

  return "none";
}

/** Convenience wrapper for call sites that only care whether the tab is allowed in. */
export function tabBelongsInSection(tab: MembershipTab, sectionName: string, cohort: CohortMember[] = []): boolean {
  return evaluateMembership(tab, sectionName, cohort) !== "none";
}

/** Explanation stored on a tab that was pulled back out of a group it didn't belong in. */
export function evictionReason(sectionName: string): string {
  return `Didn't match "${sectionName}" closely enough to file it there.`;
}

export type MembershipValidation = {
  tabs: Tab[];
  /** Ids of tabs removed from a section they had no evidence for. */
  evictedIds: string[];
};

/**
 * The final gate before a generated organization is handed back: re-checks
 * every (tab, section) pair and unfiles the ones no evidence supports, so an
 * unrelated tab ends up unassigned — and therefore re-homed by the caller's
 * own deterministic fallback — rather than sitting inside a group it has
 * nothing to do with.
 *
 * Sections whose name is broad/generic are skipped entirely — they make no
 * topical claim to be wrong about.
 *
 * There is no exemption for how a tab got there: not for cluster membership,
 * not for model confidence, not for a group this run created itself. The one
 * thing it will not touch is a placement the user made by hand
 * (`sectionLocked`, or organizationStatus "manual") — a human decision
 * outranks this check exactly as it outranks the AI.
 */
export function validateSectionMembership(tabs: Tab[], sections: Section[]): MembershipValidation {
  const sectionsById = new Map(sections.map((s) => [s.id, s]));
  const membersBySection = new Map<string, Tab[]>();
  for (const tab of tabs) {
    if (!tab.sectionId) continue;
    const bucket = membersBySection.get(tab.sectionId);
    if (bucket) bucket.push(tab);
    else membersBySection.set(tab.sectionId, [tab]);
  }

  const evictedIds = new Set<string>();
  const reasonById = new Map<string, string>();

  for (const [sectionId, members] of membersBySection) {
    const section = sectionsById.get(sectionId);
    if (!section || isBroadSectionName(section.name)) continue;

    const cohort: CohortMember[] = members.map((tab) => ({ tab }));

    for (const tab of members) {
      if (tab.sectionLocked || tab.organizationStatus === "manual") continue;
      if (evaluateMembership(tab, section.name, cohort) !== "none") continue;
      evictedIds.add(tab.id);
      reasonById.set(tab.id, evictionReason(section.name));
    }
  }

  if (evictedIds.size === 0) return { tabs, evictedIds: [] };

  return {
    tabs: tabs.map((tab) =>
      evictedIds.has(tab.id)
        ? { ...tab, sectionId: undefined, organizationStatus: "uncertain" as const, organizationReason: reasonById.get(tab.id) }
        : tab
    ),
    evictedIds: [...evictedIds],
  };
}
