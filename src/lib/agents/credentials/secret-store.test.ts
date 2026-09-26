import { describe, expect, it } from "vitest";
import {
  createAesCipher,
  createCredentialStore,
  createMemorySecretRows,
  generateCredentialKey,
  readCredentialKey,
  CREDENTIAL_KEY_ENV_VAR,
} from "./secret-store";
import { LEAK_CANARY } from "./__fixtures__/source";

/**
 * The encrypted credential store.
 *
 * These are the assertions that make the rest of the phase's security claims
 * worth anything: if the cipher is wrong, every statement about "the database
 * holds nothing readable" is decoration.
 */

const KEY = Buffer.from(generateCredentialKey(), "base64");
const ALICE = "account:alice";
const BOB = "account:bob";

function newStore(key: Buffer = KEY) {
  const rows = createMemorySecretRows();
  return { rows, store: createCredentialStore(rows, createAesCipher(key)) };
}

describe("the master key", () => {
  it("accepts exactly 32 base64-encoded bytes", () => {
    const key = generateCredentialKey();
    expect(readCredentialKey({ [CREDENTIAL_KEY_ENV_VAR]: key })).toHaveLength(32);
  });

  it("refuses a short key rather than padding it", () => {
    // The failure this prevents: a deployment believing it has 256 bits of key
    // while actually having 64, because something helpfully zero-padded.
    const short = Buffer.alloc(8).toString("base64");
    expect(readCredentialKey({ [CREDENTIAL_KEY_ENV_VAR]: short })).toBeUndefined();
  });

  it("refuses a long key, an empty one, and an absent one", () => {
    expect(readCredentialKey({ [CREDENTIAL_KEY_ENV_VAR]: Buffer.alloc(64).toString("base64") })).toBeUndefined();
    expect(readCredentialKey({ [CREDENTIAL_KEY_ENV_VAR]: "   " })).toBeUndefined();
    expect(readCredentialKey({})).toBeUndefined();
  });

  it("refuses a non-base64 string of the right character count", () => {
    // `Buffer.from(_, "base64")` drops invalid characters instead of failing,
    // so the length check is what actually validates the input.
    expect(readCredentialKey({ [CREDENTIAL_KEY_ENV_VAR]: "!".repeat(44) })).toBeUndefined();
  });

  it("generates distinct keys", () => {
    const keys = new Set(Array.from({ length: 16 }, () => generateCredentialKey()));
    expect(keys.size).toBe(16);
  });
});

describe("sealing and opening", () => {
  it("round-trips a secret for its owner", async () => {
    const { store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);
    expect(await store.reveal("pc-1", ALICE)).toBe(LEAK_CANARY);
  });

  it("writes nothing resembling the plaintext to the row", async () => {
    const { rows, store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);

    const sealed = await rows.get("pc-1", ALICE);
    const serialized = JSON.stringify(sealed);

    // The whole point of the table. A dump of it is not a list of API keys.
    expect(serialized).not.toContain(LEAK_CANARY);
    expect(serialized).not.toContain("sk-ant");
    // Nor is the plaintext recoverable by base64-decoding the ciphertext,
    // which is what a "reversible encoding mistaken for encryption" bug looks
    // like from the outside.
    expect(Buffer.from(sealed!.ciphertext, "base64").toString("utf8")).not.toContain("sk-ant");
  });

  it("produces a different ciphertext each time, from a fresh IV", async () => {
    const { rows, store } = newStore();

    await store.store("pc-1", ALICE, LEAK_CANARY, 1);
    const first = await rows.get("pc-1", ALICE);
    await store.store("pc-1", ALICE, LEAK_CANARY, 2);
    const second = await rows.get("pc-1", ALICE);

    // Deterministic ciphertext would let anybody holding a dump tell that two
    // users had pasted the same key, without decrypting anything.
    expect(first!.ciphertext).not.toBe(second!.ciphertext);
    expect(first!.iv).not.toBe(second!.iv);
  });

  it("cannot be opened with a different key", async () => {
    const { rows } = newStore();
    const sealed = createAesCipher(KEY).seal(LEAK_CANARY, "pc-1");
    await rows.put("pc-1", ALICE, sealed, 1);

    const other = createCredentialStore(rows, createAesCipher(Buffer.from(generateCredentialKey(), "base64")));
    // `undefined`, not a throw and not garbage. A caller cannot tell a wrong
    // key from a tampered record, which is what stops this being an oracle.
    expect(await other.reveal("pc-1", ALICE)).toBeUndefined();
  });

  it("refuses a record moved to a different connection", async () => {
    const { rows, store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);
    const sealed = await rows.get("pc-1", ALICE);

    // The connection id is the additional authenticated data. Lifting a
    // ciphertext out of one row and into another fails to open rather than
    // handing the second connection the first one's credential — which is the
    // attack a plain encrypted column does not stop.
    await rows.put("pc-2", ALICE, sealed!, 2);
    expect(await store.reveal("pc-2", ALICE)).toBeUndefined();
  });

  it("refuses a tampered ciphertext, IV or auth tag", async () => {
    const { rows, store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);
    const sealed = (await rows.get("pc-1", ALICE))!;

    const flip = (value: string) => {
      const bytes = Buffer.from(value, "base64");
      bytes[0] = bytes[0]! ^ 0xff;
      return bytes.toString("base64");
    };

    for (const mutated of [
      { ...sealed, ciphertext: flip(sealed.ciphertext) },
      { ...sealed, iv: flip(sealed.iv) },
      { ...sealed, authTag: flip(sealed.authTag) },
    ]) {
      await rows.put("pc-1", ALICE, mutated, 3);
      expect(await store.reveal("pc-1", ALICE)).toBeUndefined();
    }
  });

  it("refuses a record sealed under an unknown scheme version", async () => {
    const { rows, store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);
    const sealed = (await rows.get("pc-1", ALICE))!;

    // A record from a future Hubble must not be handed to a cipher that
    // would misread it.
    await rows.put("pc-1", ALICE, { ...sealed, version: 2 as 1 }, 4);
    expect(await store.reveal("pc-1", ALICE)).toBeUndefined();
  });
});

describe("owner scoping", () => {
  it("does not reveal another owner's secret", async () => {
    const { store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);

    // Bob knows the connection id — the interesting case, because guessing one
    // is the only thing an attacker has to do.
    expect(await store.reveal("pc-1", BOB)).toBeUndefined();
  });

  it("does not let another owner delete a secret", async () => {
    const { store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);

    await store.forget("pc-1", BOB);
    expect(await store.reveal("pc-1", ALICE)).toBe(LEAK_CANARY);
  });

  it("forgets a secret for its own owner, idempotently", async () => {
    const { store } = newStore();
    await store.store("pc-1", ALICE, LEAK_CANARY, 1);

    await store.forget("pc-1", ALICE);
    expect(await store.reveal("pc-1", ALICE)).toBeUndefined();
    // Disconnecting twice is not an error.
    await expect(store.forget("pc-1", ALICE)).resolves.toBeUndefined();
  });
});

describe("the rows interface", () => {
  it("offers no way to enumerate secrets", () => {
    const rows = createMemorySecretRows();
    // Three methods, all of which require a connection id *and* an owner id.
    // No `list`, no `keys`, no iteration: no export, admin page or debug dump
    // can sweep them up, which is the same discipline the browser-side
    // session-credential module already follows.
    expect(Object.keys(rows).sort()).toEqual(["delete", "get", "put"]);
  });
});
