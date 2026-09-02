import type { Tab } from "@/lib/tabs/types";
import type { Section } from "@/lib/sections/types";

export type Group = {
  id: string;
  name: string;
  createdAt: number;
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
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceStore = {
  version: 1;
  currentId: string;
  workspaces: Workspace[];
};
