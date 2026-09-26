import "server-only";
import { ensureCredentialAdapters } from "./providers";
import {
  createAesCipher,
  createCredentialStore,
  createMemorySecretRows,
  readCredentialKey,
} from "./secret-store";
import { createPostgresCredentialStores } from "./store-postgres";
import { createCredentialService, resolveCredential } from "./service";
import { createMemoryConnectionStore } from "./store";
import type { AgentProviderId } from "@/lib/agents/connectors/types";
import type { CredentialStore } from "./secret-store";
import type { CredentialService } from "./service";
import type { ConnectionStore } from "./store";
import type { CredentialResolution } from "./types";

/**
 * The credential layer's infrastructure, resolved once per process.
 *
 * ## Fail closed, and say which half is missing
 *
 * Two things must be present: an encryption key and somewhere to put rows.
 * Missing either means the whole feature reports itself unavailable — no
 * connecting, no rotating, and therefore no sessions. It does **not** degrade
 * to plaintext storage and it does not degrade to a shared key. A deployment
 * that cannot encrypt a credential has no business holding one, and one that
 * cannot persist a connection would hand the user a "Connected" badge that
 * evaporates on the next request.
 *
 * `describeUnavailable` exists so an operator is told which half, because
 * "credentials are unavailable" is not a sentence anybody can act on.
 *
 * ## Why memory rows are a real mode rather than a test hook
 *
 * A developer running `next dev` with no Postgres still needs to connect their
 * own key, or nothing in this phase is reachable locally. So the memory path
 * is supported — and it is honest about itself: it holds the *same sealed
 * records* the Postgres path does, so it still requires a real encryption key,
 * and the connections it holds are gone on restart. Losing them is a visible
 * property of a store with no database rather than a hidden one.
 */

export type CredentialInfrastructure = {
  service: CredentialService;
  connections: ConnectionStore;
  secrets: CredentialStore;
  /** Whether connections survive a restart. Rendered, so nobody is surprised. */
  durable: boolean;
};

export type CredentialUnavailable =
  /** No TABDUMP_CREDENTIAL_KEY, or one that is not 32 base64-encoded bytes. */
  | "no-encryption-key";

let resolved: Promise<CredentialInfrastructure | undefined> | undefined;

export async function getCredentialInfrastructure(): Promise<CredentialInfrastructure | undefined> {
  resolved ??= (async () => {
    ensureCredentialAdapters();

    const key = readCredentialKey();
    // The one hard requirement. Checked before the database, because a
    // deployment with rows and no key can neither read what it has nor
    // safely accept anything new.
    if (!key) return undefined;

    const cipher = createAesCipher(key);

    // A database failure is not fatal here the way a missing key is: the
    // memory path is a supported mode. `catch(() => undefined)` rather than a
    // throw, matching how `remote/services.ts` treats the same construction.
    const postgres = await createPostgresCredentialStores().catch(() => undefined);

    const connections = postgres?.connections ?? createMemoryConnectionStore();
    const secrets = createCredentialStore(
      postgres?.secrets ?? createMemorySecretRows(),
      cipher
    );

    return {
      service: createCredentialService({ connections, secrets }),
      connections,
      secrets,
      durable: postgres !== undefined,
    };
  })().catch((error) => {
    // Not cached: the next request gets a fresh attempt rather than inheriting
    // one bad startup forever. Same reasoning as the remote services module.
    resolved = undefined;
    throw error;
  });

  return resolved;
}

/**
 * Why the credential layer is unavailable, for an operator.
 *
 * Returns `undefined` when it is available. Deliberately not carried into any
 * user-facing string: a sentence naming an environment variable is a sentence
 * a hosted deployment could render to anybody who opens settings.
 */
export function describeUnavailable(): CredentialUnavailable | undefined {
  return readCredentialKey() ? undefined : "no-encryption-key";
}

/**
 * The runtime's credential lookup, bound to nothing.
 *
 * `undefined` infrastructure resolves as `unavailable` rather than throwing,
 * so a runtime asking for a credential on a deployment that has no credential
 * layer gets a refusal it can report — not an exception that surfaces as
 * `provider_error` and sends the user looking for a broken agent.
 */
export async function resolveProviderCredential(
  ownerId: string,
  provider: AgentProviderId
): Promise<CredentialResolution> {
  const infrastructure = await getCredentialInfrastructure();
  if (!infrastructure) return { ok: false, reason: "unavailable" };

  return resolveCredential(
    { connections: infrastructure.connections, secrets: infrastructure.secrets },
    ownerId,
    provider
  );
}

/** Forgets the cached infrastructure. For tests, and for a deterministic shutdown. */
export function resetCredentialInfrastructure(): void {
  resolved = undefined;
}
