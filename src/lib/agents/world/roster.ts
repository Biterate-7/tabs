import { CONNECTOR_STATUS_LABELS } from "@/lib/agents/connectors/types";
import type { ConnectorView } from "@/lib/agents/connectors/manager";
import type { ConnectorStatusKind } from "@/lib/agents/connectors/types";

/**
 * Who stands in the world when nothing is running.
 *
 * The one derivation behind both halves of the idle experience — the
 * stand-in figures the scene builder places, and the roster strip the
 * dedicated Agent World view lists beneath the stage. They come from the same
 * function so the room and the list cannot disagree about which agents exist
 * or what state each one is in.
 *
 * ## Why an unconnected provider may be drawn at all
 *
 * Phase 18 drew only providers reporting `connected`, on the principle that a
 * figure implies a working connection. That principle is kept — it is why
 * `presence` exists — but it was answering the wrong question for someone
 * opening the world for the first time. A brand-new user has connected
 * nothing, so "only connected providers" meant an empty room, and an empty
 * room teaches nobody what the room is for.
 *
 * The resolution is to draw the roster while being exact about what each
 * figure means. A `connected` stand-in is an agent that is here and has done
 * nothing yet. An `available` one is an agent this build ships and the user
 * has not connected — it stands in the arrival zone, labelled with its
 * connector's own status word ("Not connected", "Needs setup", "Unavailable"),
 * and its detail card says how to bring it in. Neither ever enters a working,
 * thinking or communicating state: those come from observed runs and from
 * nothing else, which is the invariant this whole layer is built on.
 */

/** What a stand-in figure actually is. Never applied to a character that has a run. */
export type WorldPresence =
  /** Connected and observable, with nothing observed in this workspace yet. */
  | "connected"
  /** Shipped by this build, not connected. Present so the world is explorable. */
  | "available";

/**
 * A provider with no work, ready to be placed.
 *
 * `statusLabel` is the connector layer's own word rather than one re-derived
 * here, for the reason `CONNECTOR_STATUS_LABELS` exists: the world and the
 * settings page must never report a connector differently.
 */
export type WorldRosterEntry = {
  provider: string;
  displayName: string;
  presence: WorldPresence;
  /** The connector's status, in the connector layer's words. */
  statusLabel: string;
  /** The raw status kind, for a caller that needs to style rather than read it. */
  statusKind: ConnectorStatusKind;
};

export type WorldRosterOptions = {
  /**
   * Whether providers that are not connected are included.
   *
   * On for the dedicated Agent World, which exists to be explored before
   * anything has been set up. Off for the panel over the graph canvas, which
   * is a small ambient window onto work in progress — filling it with five
   * agents that are not running would crowd out the one that is.
   */
  includeAvailable?: boolean;
};

/**
 * The world's roster, in catalogue order.
 *
 * Catalogue order rather than sorted, so the figures do not reshuffle as
 * connectors come and go — the same stability rule the layout engine follows
 * for runs.
 */
export function buildWorldRoster(
  connectors: readonly ConnectorView[],
  options: WorldRosterOptions = {}
): WorldRosterEntry[] {
  const { includeAvailable = false } = options;
  const roster: WorldRosterEntry[] = [];

  for (const view of connectors) {
    const connected = view.status.kind === "connected";
    if (!connected && !includeAvailable) continue;

    roster.push({
      provider: view.descriptor.provider,
      displayName: view.descriptor.displayName,
      presence: connected ? "connected" : "available",
      statusLabel: CONNECTOR_STATUS_LABELS[view.status.kind],
      statusKind: view.status.kind,
    });
  }

  return roster;
}
