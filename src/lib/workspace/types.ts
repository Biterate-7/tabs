import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";

export type Group = {
  id: string;
  name: string;
  createdAt: number;
  updatedAt: number;
};

/**
 * A workspace's brief: two short, user-written lines. Deliberately small — a
 * purpose and a current focus, never a document — and never generated.
 */
export type WorkspaceBrief = {
  /** What the workspace is for. */
  description?: string;
  /** What is being worked on in it right now. */
  focus?: string;
  updatedAt: number;
};

export type Workspace = {
  id: string;
  name: string;
  tabs: Tab[];
  /** User-defined sub-groups within this workspace. Optional for backward compat with stores saved before groups existed. */
  groups?: Group[];
  /** This workspace's hierarchical organization tree (see src/lib/sections/types.ts). Optional for backward compat with stores saved before sections existed — see src/lib/sections/migrate.ts for how it gets seeded. */
  sections?: Section[];
  /** User-uploaded workspace icon, stored as a data URL (see src/lib/workspace/logo.ts for validation/resizing). Absent (not just empty) for the default icon — see updateWorkspaceLogo in store.ts. */
  logo?: string;
  /** What the workspace is for and what is being worked on now, in the user's words (Hubble 1.5 — see src/lib/workspace/brief.ts). Absent until the user writes one. */
  brief?: WorkspaceBrief;
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceStore = {
  version: 1;
  currentId: string;
  workspaces: Workspace[];
};
