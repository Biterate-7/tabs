/**
 * What an agent session may do with the TabDump workspace it was started from
 * (Phase J.3, formalized in J.4).
 *
 * ## Two grant scopes, five capabilities
 *
 * The user grants an agent two things, in Connect Agent, per project:
 *
 *   `read_workspace`   → workspace.read · tabs.read · collections.read · relationships.read
 *   `write_workspace`  → collections.write            (and every single write still asks)
 *
 * A session's capabilities are derived **once, by the runtime**, from that
 * grant plus the workspace the session was started from — never from the
 * request, the agent or the provider (`sessionContextAccessFor` in
 * runtime/host.ts, `capabilitiesFor` here). There is no call anywhere that
 * widens them afterwards, and no request field that can name one: a client
 * that sends `capabilities: ["collections.write"]` is sending a field nothing
 * reads.
 *
 * Read never implies write. There is no `workspace.admin`, no delete and no
 * cross-workspace anything. A capability is added here deliberately, with the
 * tool that uses it, or not at all.
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

export const WRITE_CAPABILITIES: readonly SessionContextCapability[] = ["collections.write"] as const;

export function isSessionContextCapability(value: unknown): value is SessionContextCapability {
  return typeof value === "string" && (SESSION_CONTEXT_CAPABILITIES as readonly string[]).includes(value);
}

export function isWriteCapability(capability: SessionContextCapability): boolean {
  return (WRITE_CAPABILITIES as readonly string[]).includes(capability);
}

/** How much of its workspace a session may touch. Chosen when the session starts; never widened after. */
export type SessionContextAccess = "read" | "read_write";

export function isSessionContextAccess(value: unknown): value is SessionContextAccess {
  return value === "read" || value === "read_write";
}

export function capabilitiesFor(access: SessionContextAccess): readonly SessionContextCapability[] {
  return access === "read_write" ? [...READ_CAPABILITIES, ...WRITE_CAPABILITIES] : [...READ_CAPABILITIES];
}

/**
 * The session MCP server's tools and the capability each needs.
 *
 * The server registers a tool only when the session holds its capability, so
 * a read-only session's agent does not even see the write tools — and every
 * tool is authorized again when called (./authorization.ts).
 */
export const SESSION_TOOL_CAPABILITY = {
  get_context_status: "workspace.read",
  get_context_changes: "workspace.read",
  get_current_workspace: "workspace.read",
  list_workspaces: "workspace.read",
  get_workspace: "workspace.read",
  list_tabs: "tabs.read",
  get_tabs: "tabs.read",
  search_tabs: "tabs.read",
  list_collections: "collections.read",
  get_collection: "collections.read",
  get_tab_graph: "relationships.read",
  create_collection: "collections.write",
  rename_collection: "collections.write",
  add_tabs_to_collection: "collections.write",
} as const satisfies Record<string, SessionContextCapability>;

export type SessionContextTool = keyof typeof SESSION_TOOL_CAPABILITY;

export const SESSION_CONTEXT_TOOLS = Object.keys(SESSION_TOOL_CAPABILITY) as SessionContextTool[];

export function isSessionContextTool(value: unknown): value is SessionContextTool {
  return typeof value === "string" && Object.prototype.hasOwnProperty.call(SESSION_TOOL_CAPABILITY, value);
}

/** What the Command Centre says a session can read or change, in words. */
export const SESSION_CONTEXT_ACCESS_LABELS: Record<SessionContextCapability, string> = {
  "workspace.read": "Workspace",
  "tabs.read": "Tabs and search",
  "collections.read": "Collections",
  "relationships.read": "Relationships",
  "collections.write": "Collections",
};
