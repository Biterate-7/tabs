import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { RuntimeClient } from "@/lib/agents/runtime/client";
import type { RuntimeCommandResults, RuntimeHandoffPreview, RuntimeResult } from "@/lib/agents/runtime/protocol";
import type { SessionContextSnapshot } from "@/lib/agents/session-context/snapshot";
import type { HandoffInclude } from "./handoff";

/**
 * How the "Continue with…" dialog reaches whatever performs a handoff
 * (Hubble 1.4): the runtime's two commands in the Command Centre, the
 * landing page's deterministic demo on its own page. The dialog is the same
 * component either way; only this differs.
 */

export type HandoffStartInput = {
  preview: RuntimeHandoffPreview;
  include: HandoffInclude;
  instruction?: string;
  projectId?: string;
};

export type HandoffStartResult = RuntimeCommandResults["start_handoff"];

export type HandoffTransport = {
  prepare(targetProvider: AgentProviderId): Promise<RuntimeResult<RuntimeHandoffPreview>>;
  start(input: HandoffStartInput): Promise<RuntimeResult<HandoffStartResult>>;
};

/**
 * The runtime's transport, for one source session and one copy of its
 * workspace. The same snapshot goes with the preview and the confirmation,
 * so the fingerprint the runtime checks is of exactly what the person read.
 */
export function runtimeHandoffTransport(
  client: RuntimeClient,
  sourceSessionId: string,
  contextSnapshot: SessionContextSnapshot | undefined
): HandoffTransport {
  const snapshot = contextSnapshot ? { contextSnapshot } : {};
  return {
    prepare: (targetProvider) => client.send({ name: "prepare_handoff", sourceSessionId, targetProvider, ...snapshot }),
    start: ({ preview, include, instruction, projectId }) =>
      client.send({
        name: "start_handoff",
        sourceSessionId,
        targetProvider: preview.targetProvider,
        ...snapshot,
        fingerprint: preview.fingerprint,
        include,
        ...(instruction ? { instruction } : {}),
        ...(projectId ? { projectId } : {}),
      }),
  };
}
