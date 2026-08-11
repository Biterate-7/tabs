import {
  FlaskConical,
  GraduationCap,
  FolderGit2,
  ShoppingCart,
  Palette,
  Newspaper,
  Bookmark,
  CircleHelp,
} from "lucide-react";
import type { CategoryDefinition, CategoryId } from "./types";

export const CATEGORY_ORDER: CategoryId[] = [
  "research",
  "school",
  "projects",
  "shopping",
  "creative",
  "news",
  "read-later",
  "other",
];

export const CATEGORIES: Record<CategoryId, CategoryDefinition> = {
  research: {
    id: "research",
    name: "Research",
    icon: FlaskConical,
    description: "Papers, journals, and academic sources.",
    accentColor: "--category-research",
  },
  school: {
    id: "school",
    name: "School",
    icon: GraduationCap,
    description: "Coursework, learning platforms, and class materials.",
    accentColor: "--category-school",
  },
  projects: {
    id: "projects",
    name: "Projects",
    icon: FolderGit2,
    description: "Code, deployment, and product-building tools.",
    accentColor: "--category-projects",
  },
  shopping: {
    id: "shopping",
    name: "Shopping",
    icon: ShoppingCart,
    description: "Product pages, carts, and marketplaces.",
    accentColor: "--category-shopping",
  },
  creative: {
    id: "creative",
    name: "Creative",
    icon: Palette,
    description: "Design, illustration, and portfolio tools.",
    accentColor: "--category-creative",
  },
  news: {
    id: "news",
    name: "News",
    icon: Newspaper,
    description: "Articles from news and media outlets.",
    accentColor: "--category-news",
  },
  "read-later": {
    id: "read-later",
    name: "Read Later",
    icon: Bookmark,
    description: "Blogs, long-form writing, and docs worth revisiting.",
    accentColor: "--category-read-later",
  },
  other: {
    id: "other",
    name: "Other",
    icon: CircleHelp,
    description: "Anything that doesn't confidently fit elsewhere.",
    accentColor: "--category-other",
  },
};
