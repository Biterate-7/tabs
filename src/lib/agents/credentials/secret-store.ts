import "server-only";
import {
  createCipheriv,
  createDecipheriv,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";

/**
 * Where provider credentials actually live.
 *
 * ## Why this is its own module rather than a column
 *
 * The brief's chain is
 *
 * ```
 * ProviderConnection → CredentialReference → encrypted secret storage
 * ```
 *
 * and the indirection is the point. A connection row is read constantly — to
 * render a settings page, to decide whether a session may start, to list what
 * a user has. If the secret were a column on it, every one of those reads
 * would pull the secret into memory, and one `SELECT *` in a support session
 * or one `console.log(connection)` while debugging would put it somewhere it
 * can never be taken back from.
 *
 * So the connection holds a *reference*, the secret lives in a separate table
 * nothing but this module reads, and the only function that returns plaintext
 * is `reveal` — one caller, at the moment a runtime starts.
 *
 * ## The encryption, and what it is honestly worth
 *
 * AES-256-GCM, one random 96-bit IV per record, the connection id bound in as
 * additional authenticated data. The key comes from `TABDUMP_CREDENTIAL_KEY`
 * (32 bytes, base64). GCM rather than CBC because a credential store needs to
 * detect tampering, not merely resist reading: a ciphertext that has been
 * swapped for another row's fails the auth tag rather than decrypting to
 * somebody else's key. Binding the connection id as AAD is what makes *that*
 * true even between two rows encrypted under the same key.
 *
 * What this protects against, precisely: a leaked database dump, a backup on
 * a laptop, a replica somebody can read, a `SELECT` in a support session. What
 * it does not protect against: an attacker who already has the application's
 * environment, because they have the key. That is the honest boundary of
 * envelope encryption with a deployment-held key, and pretending otherwise
 * would be the sort of invented guarantee this codebase refuses elsewhere.
 * A KMS-held key is the upgrade, and it is one implementation of
 * `CredentialCipher` below rather than a rewrite.
 *
 * ## Fail closed
 *
 * No key configured means no cipher, which means `createSecretStore` returns
 * `undefined` and the whole provider-connection feature reports itself
 * unavailable. It does **not** fall back to storing plaintext, and it does not
 * fall back to a key derived from something else that happens to be lying
 * around. A deployment that cannot encrypt a credential has no business
 * holding one.
 */

/** The environment variable carrying the master key. Named here once. */
export const CREDENTIAL_KEY_ENV_VAR = "TABDUMP_CREDENTIAL_KEY";

/** AES-256 needs exactly this many bytes of key. */
const KEY_BYTES = 32;
/** GCM's standard IV length. Not 16 — 96 bits is the size GCM is specified and fastest for. */
const IV_BYTES = 12;
const ALGORITHM = "aes-256-gcm";

/**
 * A sealed credential, as stored.
 *
 * Three opaque base64 strings and a version. The version is not decoration: a
 * store that one day holds records sealed under two schemes needs to know
 * which is which, and adding that field after the fact means a migration over
 * rows nobody can read to find out.
 */
export type SealedSecret = {
  version: 1;
  iv: string;
  ciphertext: string;
  authTag: string;
};

/**
 * The cipher seam.
 *
 * Exists so a KMS-backed implementation is a drop-in, and so the store's
 * behaviour can be tested — including its failure behaviour — without a real
 * key or a real network.
 */
export type CredentialCipher = {
  /** `aad` binds the ciphertext to the record that owns it. */
  seal(plaintext: string, aad: string): SealedSecret;
  /** Returns `undefined` for anything that does not authenticate. Never throws at callers. */
  open(sealed: SealedSecret, aad: string): string | undefined;
};

/**
 * Reads the master key.
 *
 * Accepts base64 and refuses everything else, including a key of the wrong
 * length. A short key silently zero-padded is the classic way a deployment
 * ends up with far less entropy than its operator believes, so the wrong
 * length is an error rather than something to correct.
 */
export function readCredentialKey(
  env: Readonly<Record<string, string | undefined>> = process.env
): Buffer | undefined {
  const raw = env[CREDENTIAL_KEY_ENV_VAR]?.trim();
  if (!raw) return undefined;

  let decoded: Buffer;
  try {
    decoded = Buffer.from(raw, "base64");
  } catch {
    return undefined;
  }

  // `Buffer.from(_, "base64")` is famously tolerant — it drops invalid
  // characters rather than failing — so the length check is what actually
  // validates the input, not the decode.
  return decoded.length === KEY_BYTES ? decoded : undefined;
}

/** Generates a key an operator can paste into their environment. Used by the migration script. */
export function generateCredentialKey(): string {
  return randomBytes(KEY_BYTES).toString("base64");
}

export function createAesCipher(key: Buffer): CredentialCipher {
  return {
    seal(plaintext, aad) {
      const iv = randomBytes(IV_BYTES);
      const cipher = createCipheriv(ALGORITHM, key, iv);
      cipher.setAAD(Buffer.from(aad, "utf8"));

      const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);

      return {
        version: 1,
        iv: iv.toString("base64"),
        ciphertext: ciphertext.toString("base64"),
        authTag: cipher.getAuthTag().toString("base64"),
      };
    },

    open(sealed, aad) {
      // Every failure below returns `undefined` rather than throwing, and they
      // are deliberately indistinguishable: a wrong key, a tampered
      // ciphertext, a record moved between connections and a truncated row all
      // produce exactly "could not open". A caller that could tell them apart
      // would be an oracle.
      if (sealed.version !== 1) return undefined;

      try {
        const iv = Buffer.from(sealed.iv, "base64");
        const authTag = Buffer.from(sealed.authTag, "base64");
        if (iv.length !== IV_BYTES || authTag.length !== 16) return undefined;

        const decipher = createDecipheriv(ALGORITHM, key, iv);
        decipher.setAAD(Buffer.from(aad, "utf8"));
        decipher.setAuthTag(authTag);

        return Buffer.concat([
          decipher.update(Buffer.from(sealed.ciphertext, "base64")),
          decipher.final(),
        ]).toString("utf8");
      } catch {
        return undefined;
      }
    },
  };
}

/* ------------------------------------------------------------------ *
 * The store
 * ------------------------------------------------------------------ */

/**
 * The persistence the secret store needs, as its own seam.
 *
 * Deliberately smaller than a general key-value store: there is no `list`, no
 * `keys` and no iteration. A secret can be fetched by the connection that owns
 * it and otherwise cannot be enumerated, so no export, no admin page and no
 * debug dump can sweep them all up — the same discipline the connector layer's
 * session-credential module already follows in the browser, applied to the one
 * place that is allowed to be durable.
 */
export type SealedSecretRows = {
  put(connectionId: string, ownerId: string, sealed: SealedSecret, at: number): Promise<void>;
  get(connectionId: string, ownerId: string): Promise<SealedSecret | undefined>;
  delete(connectionId: string, ownerId: string): Promise<void>;
};

/**
 * The credential store.
 *
 * Every method takes an `ownerId` and every one of them passes it down into
 * the predicate. A connection id belonging to another account resolves to
 * nothing here — not to a refusal, to nothing — which is the same shape the
 * remote store uses for projects and for the same reason: an access check that
 * a new call site can forget is not access control.
 */
export type CredentialStore = {
  /** Stores or replaces the secret for a connection. */
  store(connectionId: string, ownerId: string, secret: string, at: number): Promise<void>;
  /**
   * The plaintext, for the one caller that starts a runtime.
   *
   * The single reader in the entire codebase. `security.test.ts` asserts that
   * nothing outside `./resolve.ts` calls it.
   */
  reveal(connectionId: string, ownerId: string): Promise<string | undefined>;
  /** Removes the secret. Idempotent: disconnecting twice is not an error. */
  forget(connectionId: string, ownerId: string): Promise<void>;
};

export function createCredentialStore(
  rows: SealedSecretRows,
  cipher: CredentialCipher
): CredentialStore {
  return {
    async store(connectionId, ownerId, secret, at) {
      // The connection id is the AAD. A sealed record lifted out of one row
      // and dropped into another fails to open rather than handing the second
      // connection the first one's key.
      await rows.put(connectionId, ownerId, cipher.seal(secret, connectionId), at);
    },

    async reveal(connectionId, ownerId) {
      const sealed = await rows.get(connectionId, ownerId);
      if (!sealed) return undefined;
      return cipher.open(sealed, connectionId);
    },

    async forget(connectionId, ownerId) {
      await rows.delete(connectionId, ownerId);
    },
  };
}

/* ------------------------------------------------------------------ *
 * In-memory rows
 * ------------------------------------------------------------------ */

/**
 * Sealed records in process memory.
 *
 * For local development and for tests. Note what it is *not*: an unencrypted
 * shortcut. It holds the same sealed records the Postgres implementation does,
 * so a test that exercises encryption exercises the real cipher, and a
 * development deployment still needs a real key configured. The only thing
 * that differs is durability, and losing your connections on restart is an
 * honest property of a store with no database rather than a hidden one.
 */
export function createMemorySecretRows(): SealedSecretRows {
  const rows = new Map<string, { ownerId: string; sealed: SealedSecret }>();

  return {
    async put(connectionId, ownerId, sealed) {
      rows.set(connectionId, { ownerId, sealed });
    },

    async get(connectionId, ownerId) {
      const row = rows.get(connectionId);
      // Constant-time on the owner comparison. The timing signal here is
      // tiny and the fix is one line, and "tiny" is not a property that
      // survives somebody later putting this behind a public endpoint.
      if (!row || !sameOwner(row.ownerId, ownerId)) return undefined;
      return row.sealed;
    },

    async delete(connectionId, ownerId) {
      const row = rows.get(connectionId);
      if (row && sameOwner(row.ownerId, ownerId)) rows.delete(connectionId);
    },
  };
}

function sameOwner(a: string, b: string): boolean {
  const left = Buffer.from(a, "utf8");
  const right = Buffer.from(b, "utf8");
  // `timingSafeEqual` throws on a length mismatch, which is itself the
  // comparison for differently-sized ids. Nothing secret is revealed by the
  // length of an owner id.
  return left.length === right.length && timingSafeEqual(left, right);
}
