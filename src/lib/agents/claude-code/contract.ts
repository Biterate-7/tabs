import type { AgentAdapterObservation } from "@/lib/agents/adapter";
import type { ClaudeDiscoveredSession } from "./types";

/**
 * The wire shape between the route and the browser.
 *
 * Its own module because both sides import it and neither should import the
 * other: the client must never pull in the reader (which is `server-only` and
 * would fail the build), and the route has no business importing the client
 * adapter.
 *
 * Everything here is already normalized and safe. There is no field for a
 * transcript, a prompt, a tool result or a command, which is the structural
 * reason none can be returned by mistake.
 */
export type ClaudeObservationResponse = {
  /**
   * False when no local Claude Code installation is visible — a hosted
   * deployment, or a machine that has never run it. The client shows a
   * disconnected state rather than pretending to observe anything.
   */
  available: boolean;
  /** Sessions found this poll, whether or not they are mapped to a workspace. */
  sessions: ClaudeDiscoveredSession[];
  /**
   * Ready to feed Phase 11's `ingestObservation`, except for `workspaceId`,
   * which the client fills in from its own account-scoped mapping. An
   * observation that gets none is reported by Phase 11 as `unattached` and
   * creates nothing.
   */
  observations: AgentAdapterObservation[];
  /** Opaque continuation token. Carries no filesystem path — see ./cursor.ts. */
  cursor: string;
};
