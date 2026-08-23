import { searchTabsAction, getTabAction, listWorkspacesAction, getWorkspaceAction, listWorkspaceTabsAction } from "./read";
import { createWorkspaceAction, renameWorkspaceAction } from "./workspaces";
import { moveTabAction, moveTabsAction } from "./tabs";
import { createGroupAction, renameGroupAction } from "./groups";
import { proposeAutoOrganizeAction } from "./organize";
import { listBrowserTabsAction, getActiveTabAction, listBrowserWindowsAction } from "./browser-read";
import {
  openUrlAction,
  openTabsAction,
  closeTabAction,
  closeTabsAction,
  pinTabAction,
  unpinTabAction,
  moveTabsToWindowAction,
  createBrowserWindowAction,
  openWorkspaceInBrowserAction,
  importBrowserTabsToWorkspaceAction,
} from "./browser-write";
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
  // Auto-Organize (AGENTS.md's Auto-Organize spec) — read-only planning
  // action; see src/lib/actions/organize.ts and src/lib/actions/agent.ts's
  // special-casing of it.
  [proposeAutoOrganizeAction.name]: proposeAutoOrganizeAction,
  // Chrome browser control (Ask Tabs agent actions on top of the existing
  // TabDump actions above) — see AGENTS.md's Chrome Browser Control spec.
  [listBrowserTabsAction.name]: listBrowserTabsAction,
  [getActiveTabAction.name]: getActiveTabAction,
  [listBrowserWindowsAction.name]: listBrowserWindowsAction,
  [openUrlAction.name]: openUrlAction,
  [openTabsAction.name]: openTabsAction,
  [closeTabAction.name]: closeTabAction,
  [closeTabsAction.name]: closeTabsAction,
  [pinTabAction.name]: pinTabAction,
  [unpinTabAction.name]: unpinTabAction,
  [moveTabsToWindowAction.name]: moveTabsToWindowAction,
  [createBrowserWindowAction.name]: createBrowserWindowAction,
  [openWorkspaceInBrowserAction.name]: openWorkspaceInBrowserAction,
  [importBrowserTabsToWorkspaceAction.name]: importBrowserTabsToWorkspaceAction,
};

/**
 * Names of every browser-control action — used by plan.ts's confirmation
 * policy (open vs. bulk-close have different safety rules than ordinary
 * TabDump writes) and by agent.ts (which attaches the extra `args`/`data`
 * fields to a performed action's wire result ONLY for these, so a browser
 * action can actually be executed client-side afterward — see
 * src/lib/browser/execute.ts — without changing the wire shape of every
 * existing TabDump action and breaking their exact-equality tests.
 */
export const BROWSER_ACTION_NAMES = new Set([
  listBrowserTabsAction.name,
  getActiveTabAction.name,
  listBrowserWindowsAction.name,
  openUrlAction.name,
  openTabsAction.name,
  closeTabAction.name,
  closeTabsAction.name,
  pinTabAction.name,
  unpinTabAction.name,
  moveTabsToWindowAction.name,
  createBrowserWindowAction.name,
  openWorkspaceInBrowserAction.name,
  importBrowserTabsToWorkspaceAction.name,
]);

/** See src/lib/actions/organize.ts and agent.ts's special-casing of this action's success into an "organize" result kind. */
export const AUTO_ORGANIZE_ACTION_NAME = proposeAutoOrganizeAction.name;

export const ACTION_DECLARATIONS = Object.values(ACTIONS).map((action) => ({
  name: action.name,
  description: action.description,
  parameters: action.parameters,
}));
