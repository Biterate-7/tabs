import type { Tab } from "@/lib/tabs/types";
import type { Section } from "../types";

/** Diagnostic summary of one pipeline run — see spec §27: enough to judge organization quality without exposing raw model output in the UI. */
export type OrganizeReport = {
  totalTabs: number;
  /** Tabs still without a sectionId when the run finished — the pipeline's own measure of "how close to zero Other did we get." */
  unclassifiedCount: number;
  newCategoriesCreated: number;
  /** Subsections and projects combined (any created section with a parent). */
  newSubcategoriesCreated: number;
  /** Tabs whose sectionId differs from what it was before this run. */
  reclassifiedCount: number;
};

export function emptyReport(totalTabs: number): OrganizeReport {
  return { totalTabs, unclassifiedCount: 0, newCategoriesCreated: 0, newSubcategoriesCreated: 0, reclassifiedCount: 0 };
}

export function buildOrganizeReport(
  before: Tab[],
  after: Tab[],
  sectionsBefore: Section[],
  sectionsAfter: Section[]
): OrganizeReport {
  const beforeById = new Map(before.map((t) => [t.id, t]));
  let unclassifiedCount = 0;
  let reclassifiedCount = 0;
  for (const tab of after) {
    if (!tab.sectionId) unclassifiedCount++;
    const prior = beforeById.get(tab.id);
    if (prior && prior.sectionId !== tab.sectionId) reclassifiedCount++;
  }

  const beforeIds = new Set(sectionsBefore.map((s) => s.id));
  const newSections = sectionsAfter.filter((s) => !beforeIds.has(s.id));
  const newCategoriesCreated = newSections.filter((s) => s.parentId === null).length;
  const newSubcategoriesCreated = newSections.length - newCategoriesCreated;

  return { totalTabs: after.length, unclassifiedCount, newCategoriesCreated, newSubcategoriesCreated, reclassifiedCount };
}

/** Dev-only console diagnostic (spec §27: useful during development, never noisy in production UI). */
export function logOrganizeReport(report: OrganizeReport): void {
  if (process.env.NODE_ENV === "production") return;
  const pct = report.totalTabs > 0 ? Math.round((report.unclassifiedCount / report.totalTabs) * 100) : 0;
  console.info(
    `[organize] ${report.totalTabs} tabs analyzed — ${report.newCategoriesCreated} new categor${report.newCategoriesCreated === 1 ? "y" : "ies"}, ${report.newSubcategoriesCreated} new subcategor${report.newSubcategoriesCreated === 1 ? "y" : "ies"}, ${report.reclassifiedCount} reclassified, ${report.unclassifiedCount} unresolved (${pct}%).`
  );
}

/** Short, user-facing summary for a toast after a manual "Reorganize" run (see handleReorganizeSections in app-shell.tsx) — deliberately terser than logOrganizeReport's console line. */
export function summarizeReportForToast(report: OrganizeReport): string {
  const parts: string[] = [];
  if (report.newCategoriesCreated > 0) parts.push(`${report.newCategoriesCreated} new categor${report.newCategoriesCreated === 1 ? "y" : "ies"}`);
  if (report.newSubcategoriesCreated > 0) parts.push(`${report.newSubcategoriesCreated} new subcategor${report.newSubcategoriesCreated === 1 ? "y" : "ies"}`);
  if (report.unclassifiedCount > 0) parts.push(`${report.unclassifiedCount} left unsorted`);
  return parts.length > 0 ? parts.join(", ") : "everything found a home";
}
