import type { Tab } from "@/lib/tabs/types";

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
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceStore = {
  version: 1;
  currentId: string;
  workspaces: Workspace[];
};
