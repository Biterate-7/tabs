import { findDependency, isSelfDependency } from "./relations";
import type { TabDependency } from "./types";

export type DependencyValidation =
  | { ok: true }
  | { ok: false; reason: "self" | "duplicate" };

/** UI-facing check used by the dependency dialog to disable/explain an invalid pick before the user commits to it. */
export function validateDependency(
  dependencies: TabDependency[],
  parentTabId: string,
  childTabId: string
): DependencyValidation {
  if (isSelfDependency(parentTabId, childTabId)) return { ok: false, reason: "self" };
  if (findDependency(dependencies, parentTabId, childTabId)) return { ok: false, reason: "duplicate" };
  return { ok: true };
}
