import type { AiProviderId } from "@/lib/providers/registry";
import type { DependencyType } from "@/lib/dependencies/types";
import type { KnowledgeItem, KnowledgeItemType } from "@/lib/memory/items";
import type { ItemKind } from "@/lib/memory/kinds";

/**
 * The knowledge graph: how a person's work connects across projects.
 *
 * Nodes are the things Hubble already holds — projects, the items in them
 * (conversations, sources, files, notes), every tab saved into a project
 * (a source Hubble holds no text for is still a source) and saved browser
 * sessions. Edges are relationships Hubble can *prove* from those records,
 * never inferred or invented to make the picture fuller:
 *
 *   contains         an item belongs to a project
 *   same-source      the same address is saved in two projects
 *   excerpt-of       an excerpt was taken from a page saved somewhere
 *   session-project  a session was saved for a project
 *   session-source   a session has a tab open on something a project saved
 *   linked           the person linked two saved tabs themselves
 *   depends-on       the person said one saved tab depends on another
 *
 * And one relationship Hubble *infers*, always labelled as such and never
 * used to place anything:
 *
 *   related          two AI conversations about the same work, by their
 *                    distinctive shared words and names
 *                    (lib/conversations/intelligence), with the evidence
 *
 * Ids are derived from the records' own ids, so a node keeps its identity
 * (and its place on the canvas) across edits, reloads and filter changes.
 */
export type GraphNodeKind = "project" | ItemKind | "session";

export type KnowledgeNode = {
  id: string;
  kind: GraphNodeKind;
  label: string;
  /** The project an item belongs to, or the project a session was saved for. */
  projectId?: string;
  /** Items only: the record behind the node, for opening it and its metadata. */
  item?: KnowledgeItem;
  type?: KnowledgeItemType;
  provider?: AiProviderId;
  /** Sessions only. */
  sessionId?: string;
  tabCount?: number;
  /** Projects only: how many items it holds (sizes the node). */
  size?: number;
  /** Projects only: the image the user uploaded as the project's icon (`Workspace.logo`). Absent means the generated glyph. */
  logo?: string;
  /** Projects only: the brief's words, which pick the generated glyph when the title names no subject. */
  context?: string;
  /** The most recent time anything happened to it. */
  at: number;
  /** Failed to read, still being read — drawn as unsettled, never hidden. */
  unsettled?: boolean;
  /** A tab saved into the project that Hubble holds no text for (a tab dump, an import): known by its title and address. */
  savedTab?: boolean;
  /** The icon Chrome showed for a saved tab's page (`Tab.favicon`), drawn before the site's own. */
  pageIcon?: string;
};

export type KnowledgeEdgeKind = "contains" | "same-source" | "excerpt-of" | "session-project" | "session-source" | "linked" | "depends-on" | "related";

export type KnowledgeEdge = {
  id: string;
  /** For `contains`, `session-project` and `depends-on`, the first end: the project, or the tab that depends. */
  source: string;
  target: string;
  kind: KnowledgeEdgeKind;
  /** `depends-on` only: the dependency record behind it. */
  dependency?: { id: string; type?: DependencyType };
  /** `related` only: how sure, and the words and names behind it. */
  evidence?: { score: number; shared: readonly string[] };
};

/** An inferred relationship between two saved conversations, by their items. */
export type ConversationLink = {
  a: { workspaceId: string; key: string };
  b: { workspaceId: string; key: string };
  score: number;
  shared: readonly string[];
};

/** Relationships Hubble inferred rather than proved. They never move a node. */
export const INFERRED_EDGE_KINDS: ReadonlySet<KnowledgeEdgeKind> = new Set(["related"]);

/** Relationships the person made, which they can also unmake. */
export const PERSONAL_EDGE_KINDS: ReadonlySet<KnowledgeEdgeKind> = new Set(["linked", "depends-on"]);

export type KnowledgeGraph = {
  nodes: KnowledgeNode[];
  edges: KnowledgeEdge[];
};

export type Point = { x: number; y: number };

export const EDGE_LABEL: Record<KnowledgeEdgeKind, string> = {
  contains: "In project",
  "same-source": "Same source",
  "excerpt-of": "Excerpt from",
  "session-project": "Session for project",
  "session-source": "Open in session",
  linked: "Linked by you",
  "depends-on": "Depends on",
  related: "Related conversation · inferred",
};
