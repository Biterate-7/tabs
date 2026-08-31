import { createWorkspaceAction } from "./workspaces";
import { moveTabsAction } from "./tabs";
import { createGroupAction } from "./groups";
import { assignTabsToGroupAction } from "./group-membership";
import type { ActionDefinition } from "./types";

/**
 * Every mutation Auto-Organize can apply (see src/lib/organize/apply.ts) —
 * this registry used to also back a chat-driven tool-calling agent that has
 * since been removed; these four are what's left, and what
 * applyOrganizationPlan dispatches by name via runAction.
 */
export const ACTIONS: Record<string, ActionDefinition> = {
  [createWorkspaceAction.name]: createWorkspaceAction,
  [moveTabsAction.name]: moveTabsAction,
  [createGroupAction.name]: createGroupAction,
  [assignTabsToGroupAction.name]: assignTabsToGroupAction,
};
