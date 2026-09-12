import { describe, expect, it } from "vitest";
import {
  SYNC_LIMITS,
  isLegacyEntityId,
  isUuid,
  validateCollectionPayload,
  validateDependencyPayload,
  validateGroupPayload,
  validateSectionPayload,
  validateTabPayload,
  validateWorkspacePayload,
} from "./validation";

/**
 * The sync boundary is the first place TabDump will accept workspace data
 * from outside the device that created it, so these treat every payload as
 * hostile. TypeScript proves nothing at runtime; this is what actually
 * stands between a request body and the database.
 */

const UUID_A = "11111111-1111-4111-8111-111111111111";
const UUID_B = "22222222-2222-4222-8222-222222222222";
const UUID_C = "33333333-3333-4333-8333-333333333333";
const T0 = 1_700_000_000_000;

function workspace(over: Record<string, unknown> = {}) {
  return { id: UUID_A, name: "General", createdAt: T0, updatedAt: T0, ...over };
}
function tab(over: Record<string, unknown> = {}) {
  return { id: UUID_A, url: "https://example.com/a", ...over };
}
function section(over: Record<string, unknown> = {}) {
  return { id: UUID_A, parentId: null, name: "Projects", source: "ai", createdAt: T0, updatedAt: T0, ...over };
}
function collection(over: Record<string, unknown> = {}) {
  return { id: UUID_A, name: "Reading", tabIds: [], createdAt: T0, updatedAt: T0, ...over };
}
function dependency(over: Record<string, unknown> = {}) {
  return { parentTabId: UUID_A, childTabId: UUID_B, createdAt: T0, ...over };
}

/** Every error string for a result that must have failed. Fails loudly if it unexpectedly succeeded. */
function errorsOf(result: { ok: boolean; errors?: string[] }): string {
  if (result.ok) throw new Error("expected validation to fail, but it succeeded");
  return (result.errors ?? []).join(" | ");
}

describe("identity", () => {
  it("accepts a UUID and rejects everything that merely looks like an id", () => {
    expect(isUuid(UUID_A)).toBe(true);
    expect(isUuid(UUID_A.toUpperCase())).toBe(true);
    expect(isUuid("")).toBe(false);
    expect(isUuid("not-a-uuid")).toBe(false);
    expect(isUuid(`${UUID_A} `)).toBe(false);
    expect(isUuid(`${UUID_A}${UUID_A}`)).toBe(false);
    expect(isUuid(123)).toBe(false);
    expect(isUuid(null)).toBe(false);
    expect(isUuid({ toString: () => UUID_A })).toBe(false);
  });

  it("recognises pre-UUID ids so they can be reported precisely rather than as malformed", () => {
    // Phase 1 deliberately preserved these rather than rewriting them, so
    // they exist in the wild and the upload path has to say something honest
    // about them. See SYNC_INITIAL_POLICY.
    expect(isLegacyEntityId("ws-1699123456789-1")).toBe(true);
    expect(isLegacyEntityId("tab-1699123456789-42")).toBe(true);
    expect(isLegacyEntityId(UUID_A)).toBe(false);
    expect(isLegacyEntityId("garbage")).toBe(false);
  });

  it("names a legacy id as legacy instead of calling it malformed", () => {
    const result = validateWorkspacePayload(workspace({ id: "ws-1699123456789-1" }));
    expect(errorsOf(result)).toContain("legacy");
  });

  it("rejects a workspace whose id is not a UUID", () => {
    expect(errorsOf(validateWorkspacePayload(workspace({ id: "nope" })))).toContain("id: must be a UUID");
    expect(errorsOf(validateWorkspacePayload(workspace({ id: null })))).toContain("id");
    expect(errorsOf(validateWorkspacePayload(workspace({ id: undefined })))).toContain("id");
  });

  it("rejects payloads that are not objects at all", () => {
    for (const bad of [null, undefined, 42, "workspace", [], [workspace()]]) {
      expect(validateWorkspacePayload(bad).ok).toBe(false);
      expect(validateTabPayload(bad).ok).toBe(false);
    }
  });
});

describe("ownership cannot be asserted by the payload", () => {
  it("ignores any owner field a client invents", () => {
    // The threat: a client submitting {"userId": "someone-else"} to claim
    // another account's workspace. There is no owner field in the contract,
    // so a supplied one is neither read nor carried forward — ownership
    // comes from the session and is applied by the repository's WHERE.
    const result = validateWorkspacePayload(
      workspace({ userId: "someone-else", user_id: "someone-else", ownerId: "someone-else" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("userId");
    expect(result.value).not.toHaveProperty("user_id");
    expect(result.value).not.toHaveProperty("ownerId");
    expect(Object.keys(result.value).sort()).toEqual(["createdAt", "id", "name", "updatedAt"]);
  });

  it("does not let a tab smuggle a workspace id", () => {
    const result = validateTabPayload(tab({ workspaceId: UUID_C, workspace_id: UUID_C }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("workspaceId");
    expect(result.value).not.toHaveProperty("workspace_id");
  });

  it("does not let a payload set its own sync version", () => {
    const result = validateTabPayload(tab({ syncVersion: 9_999, sync_version: 9_999 }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value).not.toHaveProperty("syncVersion");
    expect(result.value).not.toHaveProperty("sync_version");
  });
});

describe("URLs", () => {
  it("accepts http and https and preserves the string byte-for-byte", () => {
    const url = "https://example.com/foo_bar?x=1&y=%20#frag";
    const result = validateTabPayload(tab({ url }));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Re-normalizing here would make a round trip lossy and would silently
    // change what the user saved.
    expect(result.value.url).toBe(url);
  });

  it("rejects every scheme the client already refuses to save", () => {
    for (const url of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "chrome://settings",
      "vbscript:msgbox(1)",
      "about:blank",
      "ftp://example.com/x",
      "  javascript:alert(1)",
    ]) {
      const result = validateTabPayload(tab({ url }));
      expect(result.ok, `expected ${url} to be rejected`).toBe(false);
    }
  });

  it("rejects a URL past the length cap", () => {
    const long = `https://example.com/${"a".repeat(SYNC_LIMITS.url)}`;
    expect(errorsOf(validateTabPayload(tab({ url: long })))).toContain("url");
  });

  it("rejects a non-string url", () => {
    for (const url of [null, undefined, 42, {}, ["https://example.com"]]) {
      expect(validateTabPayload(tab({ url })).ok).toBe(false);
    }
  });
});

describe("timestamps", () => {
  it("requires finite, integer, non-negative epoch-ms", () => {
    for (const bad of [Number.NaN, Infinity, -Infinity, -1, 1.5, "1700000000000", null, {}]) {
      expect(validateWorkspacePayload(workspace({ createdAt: bad })).ok, `createdAt=${String(bad)}`).toBe(false);
    }
  });

  it("rejects updatedAt before createdAt", () => {
    expect(errorsOf(validateWorkspacePayload(workspace({ createdAt: T0, updatedAt: T0 - 1 })))).toContain(
      "must not precede createdAt"
    );
  });

  it("accepts updatedAt equal to createdAt, which is what creation produces", () => {
    expect(validateWorkspacePayload(workspace({ createdAt: T0, updatedAt: T0 })).ok).toBe(true);
  });

  it("lets a tab carry no timestamps, exactly as one saved before Phase 2 does", () => {
    const result = validateTabPayload(tab());
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // Absent, not zero. Inventing a creation time here would be the same lie
    // the client refuses to tell on load.
    expect(result.value).not.toHaveProperty("createdAt");
    expect(result.value).not.toHaveProperty("updatedAt");
  });

  it("still orders a tab's timestamps when it has both", () => {
    expect(validateTabPayload(tab({ createdAt: T0, updatedAt: T0 - 1 })).ok).toBe(false);
    expect(validateTabPayload(tab({ createdAt: T0, updatedAt: T0 + 1 })).ok).toBe(true);
  });

  it("requires a dependency's createdAt but not its updatedAt", () => {
    expect(validateDependencyPayload(dependency()).ok).toBe(true);
    expect(validateDependencyPayload(dependency({ createdAt: undefined })).ok).toBe(false);
    expect(validateDependencyPayload(dependency({ updatedAt: T0 - 1 })).ok).toBe(false);
  });
});

describe("string limits", () => {
  it("rejects an oversized name", () => {
    const name = "a".repeat(SYNC_LIMITS.name + 1);
    expect(validateWorkspacePayload(workspace({ name })).ok).toBe(false);
    expect(validateSectionPayload(section({ name })).ok).toBe(false);
    expect(validateGroupPayload({ id: UUID_A, name, createdAt: T0, updatedAt: T0 }).ok).toBe(false);
    expect(validateCollectionPayload(collection({ name })).ok).toBe(false);
  });

  it("rejects pathological tab strings", () => {
    expect(validateTabPayload(tab({ title: "a".repeat(SYNC_LIMITS.title + 1) })).ok).toBe(false);
    expect(validateTabPayload(tab({ notes: "a".repeat(SYNC_LIMITS.notes + 1) })).ok).toBe(false);
    expect(validateTabPayload(tab({ category: "a".repeat(SYNC_LIMITS.category + 1) })).ok).toBe(false);
    expect(
      validateTabPayload(tab({ organizationReason: "a".repeat(SYNC_LIMITS.organizationReason + 1) })).ok
    ).toBe(false);
  });

  it("rejects an oversized workspace logo", () => {
    expect(validateWorkspacePayload(workspace({ logo: "a".repeat(SYNC_LIMITS.logo + 1) })).ok).toBe(false);
    expect(validateWorkspacePayload(workspace({ logo: "data:image/png;base64,AAAA" })).ok).toBe(true);
  });

  it("rejects a collection holding an absurd number of tabs", () => {
    const tabIds = Array.from({ length: SYNC_LIMITS.collectionTabs + 1 }, (_, i) =>
      `${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`
    );
    expect(errorsOf(validateCollectionPayload(collection({ tabIds })))).toContain("tabIds");
  });
});

describe("enumerations", () => {
  it("accepts only the organization statuses the client can produce", () => {
    for (const status of ["classified", "uncertain", "fallback", "manual"]) {
      expect(validateTabPayload(tab({ organizationStatus: status })).ok, status).toBe(true);
    }
    expect(validateTabPayload(tab({ organizationStatus: "admin" })).ok).toBe(false);
    expect(validateTabPayload(tab({ organizationStatus: 1 })).ok).toBe(false);
  });

  it("accepts only the dependency types the client defines", () => {
    for (const type of ["main-document", "research", "data-source", "reference", "tool", "other"]) {
      expect(validateDependencyPayload(dependency({ type })).ok, type).toBe(true);
    }
    expect(validateDependencyPayload(dependency({ type: "arbitrary" })).ok).toBe(false);
  });

  it("accepts only 'ai' or 'user' as a section source", () => {
    expect(validateSectionPayload(section({ source: "user" })).ok).toBe(true);
    expect(validateSectionPayload(section({ source: "root" })).ok).toBe(false);
  });

  it("bounds confidence to 0..1 and visit counts to non-negative integers", () => {
    expect(validateTabPayload(tab({ confidence: 0 })).ok).toBe(true);
    expect(validateTabPayload(tab({ confidence: 1 })).ok).toBe(true);
    expect(validateTabPayload(tab({ confidence: 1.01 })).ok).toBe(false);
    expect(validateTabPayload(tab({ confidence: -0.01 })).ok).toBe(false);
    expect(validateTabPayload(tab({ confidence: Number.NaN })).ok).toBe(false);
    expect(validateTabPayload(tab({ historyVisitCount: 3 })).ok).toBe(true);
    expect(validateTabPayload(tab({ historyVisitCount: -1 })).ok).toBe(false);
    expect(validateTabPayload(tab({ historyVisitCount: 1.5 })).ok).toBe(false);
  });
});

describe("relationships", () => {
  it("requires a section's parentId to be a UUID or explicitly null", () => {
    expect(validateSectionPayload(section({ parentId: null })).ok).toBe(true);
    expect(validateSectionPayload(section({ parentId: UUID_B })).ok).toBe(true);
    // Absent is not the same as "at the root" — a section that never states
    // a parent is a malformed payload, not a root.
    expect(validateSectionPayload(section({ parentId: undefined })).ok).toBe(false);
    expect(validateSectionPayload(section({ parentId: "nope" })).ok).toBe(false);
  });

  it("refuses a section that is its own parent", () => {
    expect(errorsOf(validateSectionPayload(section({ id: UUID_A, parentId: UUID_A })))).toContain("parentId");
  });

  it("refuses a tab whose section or group reference is not a UUID", () => {
    expect(validateTabPayload(tab({ sectionId: "nope" })).ok).toBe(false);
    expect(validateTabPayload(tab({ groupId: "nope" })).ok).toBe(false);
    expect(validateTabPayload(tab({ sectionId: UUID_B, groupId: UUID_C })).ok).toBe(true);
  });

  it("refuses a self-dependency", () => {
    expect(errorsOf(validateDependencyPayload(dependency({ parentTabId: UUID_A, childTabId: UUID_A })))).toContain(
      "itself"
    );
  });

  it("refuses a collection listing the same tab twice", () => {
    expect(errorsOf(validateCollectionPayload(collection({ tabIds: [UUID_B, UUID_B] })))).toContain("repeat");
  });

  it("refuses a collection whose tabIds are not UUIDs", () => {
    expect(validateCollectionPayload(collection({ tabIds: ["nope"] })).ok).toBe(false);
    expect(validateCollectionPayload(collection({ tabIds: "not-an-array" })).ok).toBe(false);
    expect(validateCollectionPayload(collection({ tabIds: [UUID_B, UUID_C] })).ok).toBe(true);
  });
});

describe("accepted payloads keep only contract fields", () => {
  it("drops unknown keys rather than passing them through to SQL", () => {
    const result = validateTabPayload(
      tab({ title: "Example", normalizedUrl: "https://example.com/a", domain: "example.com", isDuplicate: true, favicon: "x" })
    );
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    // These four are derived client-side and deliberately absent from the
    // contract; see schema.sql for the per-field reasoning.
    expect(result.value).not.toHaveProperty("normalizedUrl");
    expect(result.value).not.toHaveProperty("domain");
    expect(result.value).not.toHaveProperty("isDuplicate");
    expect(result.value).not.toHaveProperty("favicon");
    expect(result.value.title).toBe("Example");
  });

  it("reports every problem at once rather than only the first", () => {
    const result = validateTabPayload({ id: "nope", url: "javascript:alert(1)", title: 5 });
    expect(result.ok).toBe(false);
    if (result.ok) return;
    expect(result.errors.length).toBeGreaterThanOrEqual(3);
  });
});
