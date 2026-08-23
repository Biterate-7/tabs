import { searchTabsAction, getTabAction, listWorkspacesAction, getWorkspaceAction, listWorkspaceTabsAction } from "./read";
import { createWorkspaceAction, renameWorkspaceAction } from "./workspaces";
import { moveTabAction, moveTabsAction } from "./tabs";
import { createGroupAction, renameGroupAction } from "./groups";
import type { ActionDefinition } from "./types";

export const ACTIONS: Record<string, ActionDefinition> = {
  [searchTabsAction.name]: searchTabsAction,
  [getTabAction.name]: getTabAction,
  [listWorkspacesAction.name]: listWorkspacesAction,
  [getWorkspaceAction.name]: getWorkspaceAction,
  [listWorkspaceTabsAction.name]: listWorkspaceTabsAction,
  [createWorkspaceAction.name]: createWorkspaceAction,
  [renameWorkspaceAction.name]: renameWorkspaceAction,
  [moveTabAction.name]: moveTabAction,
  [moveTabsAction.name]: moveTabsAction,
  [createGroupAction.name]: createGroupAction,
  [renameGroupAction.name]: renameGroupAction,
};

export const ACTION_DECLARATIONS = Object.values(ACTIONS).map((action) => ({
  name: action.name,
  description: action.description,
  parameters: action.parameters,
}));
