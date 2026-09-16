import { createConnectorCore } from "../base";
import { hasSessionCredential } from "../session-credentials";
import { connectorError } from "../types";
import type { AgentConnector, AgentProviderId, ProviderDescriptor } from "../types";

/**
 * A provider that is registered, described and honest about not working yet.
 *
 * ## Why this is a real implementation and not a placeholder
 *
 * The temptation in a phase like this is to make four provider cards light up
 * green. This module exists to make that impossible. A declared connector
 * genuinely implements the contract — it has a descriptor, a status, a
 * lifecycle, listeners and disposal, and the manager treats it exactly like
 * any other — but it has **no observation source**, so it can never emit an
 * observation, never create a run, and never show activity. The failure mode
 * is structural: there is no code path here that produces a
 * `ConnectorObservation`, so no amount of UI work could make one appear.
 *
 * ## What connecting one does
 *
 * It tells the truth about why it cannot work:
 *
 *   - `unavailable` — this environment has no way to observe the provider.
 *     Not actionable by the user. This is where OpenAI/Codex, Gemini and Grok
 *     sit today: observing them would mean reading local state in a format
 *     TabDump has not verified against a real installation, and guessing at
 *     one would produce a connector that reports confident nonsense.
 *   - `configuration_required` — observation is possible in principle, but
 *     something the user must supply is missing. Reached when a provider
 *     declares `requiresCredential` and none has been entered this session.
 *
 * Both are terminal for this phase, and both say so on screen. That is the
 * point: a user who connects Gemini learns in one sentence that TabDump
 * cannot watch it yet, instead of waiting for activity that will never come.
 *
 * ## The implementation seam
 *
 * A future phase replaces a registration in ./catalog.ts with a connector
 * that has a real source, in its own file beside claude-code.ts. Nothing in
 * the manager, the registry, the hooks, the domain or the UI changes — which
 * is the property this whole layer exists to have.
 */

export type DeclaredConnectorOptions = {
  descriptor: ProviderDescriptor;
  /**
   * Whether this provider would need a secret to be observed.
   *
   * Changes what connecting reports: a provider that needs a credential and
   * has none is `configuration_required` (the user can act), while one that
   * simply cannot be observed here is `unavailable` (they cannot).
   */
  requiresCredential?: boolean;
  /**
   * The sentence shown for the state connecting lands in.
   *
   * Required rather than defaulted: every unavailable connector has a
   * specific reason, and a generic "not supported" would be the beginning of
   * exactly the vagueness this phase is meant to remove.
   */
  unavailableDetail: string;
  now?: () => number;
};

export function createDeclaredConnector(options: DeclaredConnectorOptions): AgentConnector {
  const { descriptor, unavailableDetail } = options;
  const provider: AgentProviderId = descriptor.provider;
  const now = options.now ?? (() => Date.now());

  const core = createConnectorCore({
    provider,
    initialKind: "disconnected",
    now,
  });

  return {
    provider,
    descriptor,

    getStatus: () => core.getStatus(),

    async connect() {
      if (core.isDisposed()) return core.getStatus();

      if (options.requiresCredential && !hasSessionCredential(provider)) {
        core.setStatus("configuration_required", {
          error: connectorError("configuration"),
          detail: descriptor.requirement ?? unavailableDetail,
        });
        return core.getStatus();
      }

      // Deliberately never reaches `connected`. There is no source to connect
      // to, and a connector that reported otherwise would be the fake live
      // state this phase forbids.
      core.setStatus("unavailable", {
        error: connectorError("unsupported"),
        detail: unavailableDetail,
      });

      return core.getStatus();
    },

    disconnect() {
      core.setStatus("disconnected", { error: null, detail: null });
    },

    // Accepted and stored so the contract is uniform — and so a future real
    // implementation is a change of source rather than a change of shape.
    // Nothing ever notifies them, because nothing here observes anything.
    subscribe: (observer) => core.subscribe(observer),
    watchStatus: (listener) => core.watchStatus(listener),

    dispose: () => core.dispose(),
  };
}
