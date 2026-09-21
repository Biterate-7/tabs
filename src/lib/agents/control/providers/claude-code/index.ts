export {
  createClaudeCodeControlAdapter,
  CLAUDE_CODE_CONTROL_CAPABILITIES,
  hasApprovalDetails,
  readApprovalDetails,
} from "./adapter";
export type {
  ClaudeApprovalDetails,
  ClaudeCodeControlAdapter,
  ClaudeCodeControlAdapterOptions,
} from "./adapter";
export { planForGrant, modeForGrant, isToolPermitted, scopeForTool } from "./permissions";
export { normalizeClaudeMessage, providerSessionIdOf } from "./normalize";
export type {
  ClaudePermissionDecision,
  ClaudePermissionRequest,
  ClaudeRuntime,
  ClaudeRuntimeHandle,
  ClaudeRuntimeMessage,
  ClaudeRuntimeStartOptions,
} from "./runtime";

/**
 * The browser seam lives in its own module so that importing it does not drag
 * the driving implementation into a bundle that must never drive anything.
 * Re-exported here for callers that already load this barrel.
 */
export { createClaudeCodeControlSeam, CLAUDE_CODE_CONTROL_DETAIL } from "./seam";
