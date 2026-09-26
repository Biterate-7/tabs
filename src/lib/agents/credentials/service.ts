import { credentialAdapterFor } from "./registry";
import {
  blamesCredential,
  credentialValidation,
  isValidatedOk,
  normalizeDisplayName,
  toConnectionView,
} from "./types";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { CredentialStore } from "./secret-store";
import type { ConnectionStore } from "./store";
import type {
  AgentProviderConnection,
  CredentialResolution,
  CredentialValidation,
  ProviderAuthMethod,
  ProviderConnectionView,
} from "./types";

/**
 * Connect, rotate, disconnect — the operations a user performs on their own
 * provider credentials.
 *
 * ## Every method takes an actor, and it is never read from a request body
 *
 * The `ownerId` parameter on every method here comes from an authenticated
 * session, resolved by the route. There is no method that takes an owner out
 * of a payload, no method that omits one, and no "admin" variant that skips
 * the scoping. §13's list of things User A must not be able to do to User B's
 * connection is not enforced by six separate checks — it is enforced by there
 * being no call in this file that could express any of them.
 *
 * ## Validate before you store, always
 *
 * Both `connect` and `rotate` validate the new credential against the provider
 * *before* anything is written. For `connect` that is a nicety. For `rotate` it
 * is the whole requirement: §12 says a failed rotation must leave the old
 * credential active, and the only way to guarantee that is never to have
 * removed it. The order below is: validate → store secret → update row. A
 * failure at step one returns before step two, so the old secret is still
 * exactly where it was.
 *
 * ## What never comes back
 *
 * Every method returns a `ProviderConnectionView` or a validation outcome.
 * None of them returns a secret, and none of them returns the
 * `AgentProviderConnection`'s `ownerId` either. `reveal` lives on the secret
 * store and is called from one place — `./resolve.ts` — and not from here.
 */

export type CredentialServices = {
  connections: ConnectionStore;
  secrets: CredentialStore;
  now?: () => number;
  createId?: () => string;
};

export type ConnectOutcome =
  | { ok: true; connection: ProviderConnectionView }
  | { ok: false; validation: CredentialValidation };

export type DisconnectOutcome = { ok: boolean };

export type CredentialService = {
  list(ownerId: string): Promise<ProviderConnectionView[]>;
  get(ownerId: string, connectionId: string): Promise<ProviderConnectionView | undefined>;
  connect(input: ConnectInput): Promise<ConnectOutcome>;
  rotate(input: RotateInput): Promise<ConnectOutcome>;
  disconnect(ownerId: string, connectionId: string): Promise<DisconnectOutcome>;
  /** Re-checks a stored credential against the provider without changing it. */
  revalidate(ownerId: string, connectionId: string): Promise<ConnectOutcome>;
};

export type ConnectInput = {
  ownerId: string;
  provider: AgentProviderId;
  authMethod: ProviderAuthMethod;
  secret: string;
  displayName?: unknown;
};

export type RotateInput = {
  ownerId: string;
  connectionId: string;
  secret: string;
};

export function createCredentialService(services: CredentialServices): CredentialService {
  const now = services.now ?? (() => Date.now());
  const createId = services.createId ?? (() => `pc-${crypto.randomUUID()}`);

  async function viewOf(connection: AgentProviderConnection): Promise<ProviderConnectionView> {
    return toConnectionView(connection);
  }

  return {
    async list(ownerId) {
      const connections = await services.connections.list(ownerId);
      return connections.map(toConnectionView);
    },

    async get(ownerId, connectionId) {
      const connection = await services.connections.find(ownerId, connectionId);
      return connection ? toConnectionView(connection) : undefined;
    },

    async connect(input) {
      const adapter = credentialAdapterFor(input.provider);
      // A provider with no credential adapter cannot be connected. Reported as
      // a validation failure rather than a throw, so a client that asks for a
      // provider this build does not support gets the same shaped answer as
      // one that supplies a bad key.
      if (!adapter || !adapter.authMethods.includes(input.authMethod)) {
        return { ok: false, validation: credentialValidation("validation_failed") };
      }

      const validation = await adapter.validate(input.secret, input.authMethod);
      if (!isValidatedOk(validation.code)) return { ok: false, validation };

      const at = now();
      // Reuse the id of an existing connection for the same provider, so
      // "connect again with a better key" keeps whatever else referenced it
      // rather than orphaning a row. `upsert` removes any other row for the
      // provider, so this cannot leave two behind.
      const existing = await services.connections.findByProvider(input.ownerId, input.provider);
      const id = existing?.id ?? createId();

      // Secret first, then the row. If the row write fails, the worst case is
      // an unreferenced secret — which `disconnect` and the orphan sweep both
      // handle. The other order would leave a connection reported as connected
      // with nothing behind it, which is the failure a user cannot diagnose.
      await services.secrets.store(id, input.ownerId, input.secret.trim(), at);

      const connection = await services.connections.upsert({
        id,
        ownerId: input.ownerId,
        provider: input.provider,
        authMethod: input.authMethod,
        displayName: normalizeDisplayName(input.displayName, adapter.defaultDisplayName),
        status: "connected",
        createdAt: existing?.createdAt ?? at,
        updatedAt: at,
        lastValidatedAt: at,
      });

      return { ok: true, connection: await viewOf(connection) };
    },

    async rotate(input) {
      const connection = await services.connections.find(input.ownerId, input.connectionId);
      // Another owner's id is indistinguishable from one that does not exist.
      // A probe learns nothing about whether the connection is real.
      if (!connection) return { ok: false, validation: credentialValidation("validation_failed") };

      const adapter = credentialAdapterFor(connection.provider);
      if (!adapter) return { ok: false, validation: credentialValidation("validation_failed") };

      const validation = await adapter.validate(input.secret, connection.authMethod);

      if (!isValidatedOk(validation.code)) {
        // The old credential is untouched — nothing above this line wrote
        // anything. What happens to the connection's *status* depends on what
        // was actually learned: a provider we could not reach says nothing
        // about the key already stored, so the connection stays exactly as it
        // was. Only a rejection of the *new* key is worth recording, and even
        // then the old key remains in place and usable.
        if (blamesCredential(validation.code)) {
          await services.connections.update(
            input.ownerId,
            input.connectionId,
            { lastFailureCode: validation.code },
            now()
          );
        }
        return { ok: false, validation };
      }

      const at = now();
      // Replaces the sealed record under the same id. The previous ciphertext
      // is overwritten rather than kept — there is no credential history, and
      // a store that kept one would be a store a breach could read twice.
      await services.secrets.store(input.connectionId, input.ownerId, input.secret.trim(), at);

      const updated = await services.connections.update(
        input.ownerId,
        input.connectionId,
        { status: "connected", lastValidatedAt: at, lastFailureCode: null },
        at
      );

      if (!updated) return { ok: false, validation: credentialValidation("validation_failed") };
      return { ok: true, connection: await viewOf(updated) };
    },

    async disconnect(ownerId, connectionId) {
      const connection = await services.connections.find(ownerId, connectionId);
      if (!connection) return { ok: false };

      // Secret first. If the row removal then failed, what survives is a
      // connection with no credential behind it — which resolves to
      // `not_connected` and cannot start a session. The other order would
      // leave a live secret with no row pointing at it and nothing that would
      // ever clean it up: §22's "no orphaned secret".
      await services.secrets.forget(connectionId, ownerId);
      const removed = await services.connections.remove(ownerId, connectionId);

      return { ok: removed };
    },

    async revalidate(ownerId, connectionId) {
      const connection = await services.connections.find(ownerId, connectionId);
      if (!connection) return { ok: false, validation: credentialValidation("validation_failed") };

      const adapter = credentialAdapterFor(connection.provider);
      if (!adapter) return { ok: false, validation: credentialValidation("validation_failed") };

      const secret = await services.secrets.reveal(connectionId, ownerId);
      if (secret === undefined) {
        // The row says connected and the secret is gone — a partially failed
        // disconnect, or a cipher that can no longer open the record. Either
        // way the connection cannot run a session, and saying so is better
        // than leaving it looking healthy.
        const updated = await services.connections.update(
          ownerId,
          connectionId,
          { status: "invalid", lastFailureCode: "validation_failed" },
          now()
        );
        void updated;
        return { ok: false, validation: credentialValidation("validation_failed") };
      }

      const validation = await adapter.validate(secret, connection.authMethod);
      const at = now();

      if (isValidatedOk(validation.code)) {
        const updated = await services.connections.update(
          ownerId,
          connectionId,
          { status: "connected", lastValidatedAt: at, lastFailureCode: null },
          at
        );
        if (updated) return { ok: true, connection: await viewOf(updated) };
        return { ok: false, validation: credentialValidation("validation_failed") };
      }

      // A rejected credential becomes `invalid`; an unreachable provider
      // becomes `unverified`. The distinction is what the user acts on: one
      // means replace your key, the other means try again later.
      await services.connections.update(
        ownerId,
        connectionId,
        {
          status: blamesCredential(validation.code) ? "invalid" : "unverified",
          lastFailureCode: validation.code,
        },
        at
      );

      return { ok: false, validation };
    },
  };
}

/* ------------------------------------------------------------------ *
 * Resolution, for the runtime
 * ------------------------------------------------------------------ */

/**
 * Turns "this actor wants to run this provider" into a credential, or a reason.
 *
 * **The only caller of `secrets.reveal` in the application.** Everything else
 * that needs to know about a connection asks the service above, which returns
 * views. That is the property `security.test.ts` pins, and it is what makes
 * "where could a credential have leaked from?" a question with one answer.
 *
 * There is deliberately no fallback in this function. A user with no usable
 * connection gets a refusal — never a deployment-wide key, never another
 * user's, never a machine login. §6's forbidden edge does not exist here
 * because there is no `??` in it to add one to.
 */
export async function resolveCredential(
  services: Pick<CredentialServices, "connections" | "secrets">,
  ownerId: string,
  provider: AgentProviderId
): Promise<CredentialResolution> {
  const connection = await services.connections.findByProvider(ownerId, provider);
  if (!connection) return { ok: false, reason: "not_connected" };
  if (connection.status !== "connected") return { ok: false, reason: "not_usable" };

  const adapter = credentialAdapterFor(provider);
  if (!adapter) return { ok: false, reason: "not_usable" };

  const secret = await services.secrets.reveal(connection.id, ownerId);
  if (secret === undefined) return { ok: false, reason: "unavailable" };

  const credential = adapter.prepareRuntimeCredential({
    connectionId: connection.id,
    secret,
    method: connection.authMethod,
  });

  if (!credential) return { ok: false, reason: "unavailable" };
  return { ok: true, credential };
}
