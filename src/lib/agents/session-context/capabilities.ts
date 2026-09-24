/**
 * What an agent session may do with the TabDump workspace it was started from
 * (Phase J.3).
 *
 * ## Small, and read never implies write
 *
 * Five capabilities. Four read, one writes. A session gets the reads when it
 * is bound to a workspace at all; it gets `collections.write` only when the
 * user approved the agent to change workspace content (the `write_workspace`
 * scope) — and even then every single write still asks, because the write
 * tool raises a TabDump approval itself (./registry.ts `requestAction`).
 *
 * There is no `workspace.admin`, no delete, no rename and no cross-workspace
 * anything. A capability is added here deliberately, with the tool that uses
 * it, or not at all.
 */

export type SessionContextCapability =
  | "workspace.read"
  | "tabs.read"
  | "collections.read"
  | "relationships.read"
  | "collections.write";

export const SESSION_CONTEXT_CAPABILITIES: readonly SessionContextCapability[] = [
  "workspace.read",
  "tabs.read",
  "collections.read",
  "relationships.read",
  "collections.write",
] as const;

export const READ_CAPABILITIES: readonly SessionContextCapability[] = [
  "workspace.read",
  "tabs.read",
  "collections.read",
  "relationships.read",
] as const;

/** How much of its workspace a session may touch. Chosen when the session starts; never widened after. */
export type SessionContextAccess = "read" | "read_write";

export function isSessionContextAccess(value: unknown): value is SessionContextAccess {
  return value === "read" || value === "read_write";
}

export function capabilitiesFor(access: SessionContextAccess): readonly SessionContextCapability[] {
  return access === "read_write" ? [...READ_CAPABILITIES, "collections.write"] : [...READ_CAPABILITIES];
}

/**
 * The session MCP server's tools and the capability each needs.
 *
 * The server registers a tool only when the session holds its capability, so
 * a read-only session's agent does not even see the write tool — and the tool
 * checks again when called.
 */
export const SESSION_TOOL_CAPABILITY = {
  get_current_workspace: "workspace.read",
  list_workspaces: "workspace.read",
  get_workspace: "workspace.read",
  get_tabs: "tabs.read",
  search_tabs: "tabs.read",
  get_collection: "collections.read",
  get_tab_graph: "relationships.read",
  create_collection: "collections.write",
} as const satisfies Record<string, SessionContextCapability>;

export type SessionContextTool = keyof typeof SESSION_TOOL_CAPABILITY;

export const SESSION_CONTEXT_TOOLS = Object.keys(SESSION_TOOL_CAPABILITY) as SessionContextTool[];

/** What the Command Centre says a session can do, in words. */
export const SESSION_CONTEXT_ACCESS_LABELS: Record<SessionContextCapability, string> = {
  "workspace.read": "Workspace search",
  "tabs.read": "Tabs",
  "collections.read": "Collections",
  "relationships.read": "Relationships",
  "collections.write": "Create collections",
};
