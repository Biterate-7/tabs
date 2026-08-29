import type { LucideIcon } from "lucide-react";
import { FileText, FlaskConical, Database, BookMarked, Wrench, MoreHorizontal } from "lucide-react";

export type DependencyType = "main-document" | "research" | "data-source" | "reference" | "tool" | "other";

export const DEPENDENCY_TYPE_ORDER: DependencyType[] = [
  "main-document",
  "research",
  "data-source",
  "reference",
  "tool",
  "other",
];

export type DependencyTypeDefinition = {
  id: DependencyType;
  name: string;
  icon: LucideIcon;
};

export const DEPENDENCY_TYPES: Record<DependencyType, DependencyTypeDefinition> = {
  "main-document": { id: "main-document", name: "Main document", icon: FileText },
  research: { id: "research", name: "Research", icon: FlaskConical },
  "data-source": { id: "data-source", name: "Data source", icon: Database },
  reference: { id: "reference", name: "Reference", icon: BookMarked },
  tool: { id: "tool", name: "Tool", icon: Wrench },
  other: { id: "other", name: "Other", icon: MoreHorizontal },
};

/**
 * A → B: B is a dependency/resource of A (A depends on B). Directional and
 * distinct from graph/types.ts's ManualConnection, which is a symmetric
 * "these are related" link — see AGENTS.md section 1/26 for the conceptual
 * split this type is meant to preserve.
 */
export type TabDependency = {
  id: string;
  parentTabId: string;
  childTabId: string;
  /** Optional — a dependency without a type is still a valid dependency. */
  type?: DependencyType;
  createdAt: number;
};

export type DependencyPersistedState = {
  version: 1;
  dependencies: TabDependency[];
};
