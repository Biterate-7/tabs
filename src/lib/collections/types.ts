export type Collection = {
  id: string;
  workspaceId: string;
  name: string;
  tabIds: string[];
  createdAt: number;
  updatedAt: number;
};

export type CollectionPersistedState = {
  version: 1;
  collections: Collection[];
};
