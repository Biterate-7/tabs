import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const verifyIdTokenMock = vi.hoisted(() => vi.fn());

vi.mock("google-auth-library", () => ({
  OAuth2Client: class {
    verifyIdToken = verifyIdTokenMock;
  },
}));

const { verifyGoogleCredential } = await import("./google");
const { hashNonce } = await import("./tokens");

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";
const NONCE = "a-real-nonce-value";
const NONCE_HASH = hashNonce(NONCE);

/** The shape google-auth-library hands back: a ticket whose getPayload() returns the verified claims. */
function ticketWith(payload: Record<string, unknown>) {
  return { getPayload: () => payload };
}

function validPayload(overrides: Record<string, unknown> = {}) {
  return {
    sub: "115625890123456789012",
    email: "ada@example.com",
    email_verified: true,
    name: "Ada Lovelace",
    picture: "https://lh3.googleusercontent.com/ada",
    nonce: NONCE,
    ...overrides,
  };
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", CLIENT_ID);
});

afterEach(() => {
  verifyIdTokenMock.mockReset();
  vi.unstubAllEnvs();
});

describe("verifyGoogleCredential", () => {
  it("asks the library to check the token against this app's client ID", async () => {
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload()));

    await verifyGoogleCredential("a.b.c", NONCE_HASH);

    // The audience check is what stops a token minted for someone else's
    // Google app from signing anyone in here.
    expect(verifyIdTokenMock).toHaveBeenCalledWith({ idToken: "a.b.c", audience: CLIENT_ID });
  });

  it("returns the verified identity on success", async () => {
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload()));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result).toEqual({
      ok: true,
      identity: {
        googleSub: "115625890123456789012",
        email: "ada@example.com",
        name: "Ada Lovelace",
        avatarUrl: "https://lh3.googleusercontent.com/ada",
      },
    });
  });

  it("refuses to run at all without a configured client ID", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "");
    vi.stubEnv("GOOGLE_CLIENT_ID", "");

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result).toEqual({ ok: false, reason: "not-configured" });
    // Never verified against a guessed or absent audience.
    expect(verifyIdTokenMock).not.toHaveBeenCalled();
  });

  it("rejects a credential whose nonce doesn't match this browser's", async () => {
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload({ nonce: "someone-elses-nonce" })));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result).toEqual({ ok: false, reason: "nonce-mismatch" });
  });

  it("rejects a credential carrying no nonce at all", async () => {
    // Otherwise the check could be sidestepped simply by omitting the claim.
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload({ nonce: undefined })));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result).toEqual({ ok: false, reason: "nonce-mismatch" });
  });

  it("rejects an unverified email address", async () => {
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload({ email_verified: false })));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result).toEqual({ ok: false, reason: "unverified-email" });
  });

  it("rejects a token missing the claims an account needs", async () => {
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload({ sub: undefined })));
    expect((await verifyGoogleCredential("a.b.c", NONCE_HASH)).ok).toBe(false);

    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload({ email: undefined })));
    expect((await verifyGoogleCredential("a.b.c", NONCE_HASH)).ok).toBe(false);
  });

  it("rejects an empty payload", async () => {
    verifyIdTokenMock.mockResolvedValue({ getPayload: () => undefined });

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result.ok).toBe(false);
  });

  it("falls back to the email's local part when Google shares no name", async () => {
    verifyIdTokenMock.mockResolvedValue(ticketWith(validPayload({ name: undefined, picture: undefined })));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.identity.name).toBe("ada");
    expect(result.identity.avatarUrl).toBeNull();
  });

  it("classifies an expired token distinctly from a bad one", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("Token used too late, 1700000000 > 1699999999"));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("expired-credential");
  });

  it("classifies a token issued for a different OAuth client", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("Wrong recipient, payload audience != requiredAudience"));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("wrong-audience");
  });

  it("classifies an unreachable Google as a network problem, not a bad credential", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("fetch failed"));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("network-error");
  });

  it("falls back to a generic rejection for anything unrecognised", async () => {
    // A message the library might change: the fallback must be the
    // restrictive branch, never an accepting one.
    verifyIdTokenMock.mockRejectedValue(new Error("some future wording"));

    const result = await verifyGoogleCredential("a.b.c", NONCE_HASH);

    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.reason).toBe("invalid-credential");
  });

  it("never accepts a credential the library rejected, whatever the payload would have said", async () => {
    verifyIdTokenMock.mockRejectedValue(new Error("invalid signature"));
    expect((await verifyGoogleCredential("forged", NONCE_HASH)).ok).toBe(false);
  });
});
