import type { Tab } from "@/lib/tabs/types";

export type Workspace = {
  id: string;
  name: string;
  tabs: Tab[];
  createdAt: number;
  updatedAt: number;
};

export type WorkspaceStore = {
  version: 1;
  currentId: string;
  workspaces: Workspace[];
};
