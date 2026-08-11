import type { LucideIcon } from "lucide-react";

export type CategoryId =
  | "research"
  | "school"
  | "projects"
  | "shopping"
  | "creative"
  | "news"
  | "read-later"
  | "other";

export type CategoryDefinition = {
  id: CategoryId;
  name: string;
  icon: LucideIcon;
  description: string;
  /** CSS variable name (defined in globals.css) carrying this category's subtle accent color. */
  accentColor: string;
};

export type UrlContext = {
  hostname: string;
  pathname: string;
  search: string;
  href: string;
};

export type CategoryScores = Record<CategoryId, number>;

export type Classification = {
  category: CategoryId;
  confidence: number;
  scores: CategoryScores;
};
