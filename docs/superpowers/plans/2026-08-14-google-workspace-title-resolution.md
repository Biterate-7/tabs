# Google Workspace Title Resolution Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a user pastes a `docs.google.com` Docs/Sheets/Slides URL, TabDump resolves and displays the real document title (via the Google Drive API) instead of the bare domain, falling back gracefully whenever the user isn't signed in or the lookup fails.

**Architecture:** TabDump is currently a 100% static, client-only Next.js app — no backend, no auth, no DB, no metadata fetching of any kind (`tab.title` exists on the type but is never populated). This feature adds the app's first server surface: Auth.js (NextAuth v5) with a Google provider and JWT (cookie-only, no DB) session storing the Drive `access_token`/`refresh_token`; a Route Handler that resolves Drive file metadata server-side (so raw tokens never reach the client); and a client-side hook that, after the existing synchronous parse/categorize pipeline renders tabs with their domain fallback, asynchronously resolves Google Workspace titles in the background and patches them in as they arrive.

**Tech Stack:** Next.js 16 (App Router, Route Handlers), React 19, `next-auth@beta` (Auth.js v5, Google provider, JWT session strategy — no database), native `fetch` for the Drive API and token refresh (no `googleapis`/`google-auth-library` dependency), Vitest + Testing Library (existing conventions).

## Global Constraints

- Reuse `tab.title` (`src/lib/tabs/types.ts:8`) as the single title field — it already flows through `tab-card.tsx:36` and `search.ts:20,39` with zero further UI changes needed.
- No database. Session/token storage is a JWT in an encrypted `httpOnly` cookie via Auth.js's default JWT strategy.
- Only request the `https://www.googleapis.com/auth/drive.metadata.readonly` scope (plus `openid email profile` for basic sign-in) — never broader Drive scopes.
- Only request Drive fields `id,name,mimeType`. Never fetch file content.
- Never log or expose `access_token`/`refresh_token` to the client. They live only in the encrypted session cookie and are read server-side inside the Route Handler via `auth()`.
- The synchronous `parseTabInput` → `Tab[]` pipeline (`src/lib/tabs/index.ts`) must not become async or block on network calls. Title resolution is a background enrichment pass after tabs are already rendered.
- Support exactly three URL patterns: `docs.google.com/document/d/<ID>/...`, `/spreadsheets/d/<ID>/...`, `/presentation/d/<ID>/...`. Do not add Drive folders, Forms, or other Google services.
- Do not change `src/lib/categories/rules.ts` — the existing `hostIs("docs.google.com", ...)` rule (rules.ts:79) already covers all three URL patterns; no categorization changes are needed or in scope.
- Keep card UI unchanged beyond the title itself: `tab-card.tsx`'s existing `primaryLine`/domain-subtitle structure stays as-is (spec's "Docs · domain" example is conditional — this codebase doesn't currently show a provider label, so don't add one).
- Test framework: Vitest + `@testing-library/react`, co-located `*.test.ts(x)` files, `npm test` (`vitest run`). Follow `src/lib/tabs/parse.test.ts` / `src/lib/categories/classify.test.ts` conventions (plain `describe`/`it`/`expect`, no exotic mocking helpers beyond `vi.mock`/`vi.stubGlobal` already used in `app-shell.test.tsx`).
- Don't introduce dependencies beyond `next-auth@beta`. Concurrency limiting and the Drive/refresh-token HTTP calls are hand-rolled with native `fetch` to avoid `p-limit`/`googleapis`/`google-auth-library`.

---

### Task 1: Dependency, env var, and gitignore scaffolding

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `.env.example`

**Interfaces:**
- Produces: `next-auth` package available for import (`next-auth`, `next-auth/react`, `next-auth/providers/google`, `next-auth/jwt`) in later tasks.

- [ ] **Step 1: Install next-auth**

Run:
```bash
npm install next-auth@beta
```

- [ ] **Step 2: Verify no breaking peer-dependency conflicts**

Run: `npm ls next-auth`
Expected: prints the installed version with no `UNMET PEER DEPENDENCY` errors for `react`/`react-dom`/`next`. If npm reports peer conflicts against React 19 / Next 16, rerun with `--legacy-peer-deps` only if there is no alternative version that resolves cleanly, and note it in the final summary.

- [ ] **Step 3: Allow `.env.example` past the blanket `.env*` ignore**

The repo's `.gitignore` (line 34) has `.env*`, which would also hide `.env.example`. Add a negation right after it:

```gitignore
# env files (can opt-in for committing if needed)
.env*
!.env.example
```

- [ ] **Step 4: Create `.env.example`**

```bash filename=".env.example"
# Google OAuth credentials used to resolve Google Docs/Sheets/Slides titles
# via the Drive API. Create these at https://console.cloud.google.com/apis/credentials
# for a project with the "Google Drive API" enabled.
#   - OAuth client type: Web application
#   - Authorized redirect URIs:
#       http://localhost:3000/api/auth/callback/google
#       https://<your-deployed-domain>/api/auth/callback/google
GOOGLE_CLIENT_ID=
GOOGLE_CLIENT_SECRET=

# Secret Auth.js uses to encrypt the session JWT cookie. Generate with:
#   npx auth secret
AUTH_SECRET=
```

- [ ] **Step 5: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example
git commit -m "chore: add next-auth dependency and Google OAuth env scaffolding"
```

---

### Task 2: Google Workspace URL matcher

**Files:**
- Create: `src/lib/google/workspace-url.ts`
- Test: `src/lib/google/workspace-url.test.ts`

**Interfaces:**
- Produces: `extractGoogleWorkspaceFile(url: string): { fileId: string; docType: "document" | "spreadsheet" | "presentation" } | null` — pure function, no I/O. Consumed by `use-google-title-enrichment.ts` (Task 10).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/google/workspace-url.test.ts
import { describe, expect, it } from "vitest";
import { extractGoogleWorkspaceFile } from "./workspace-url";

describe("extractGoogleWorkspaceFile", () => {
  it("extracts a Google Docs file id", () => {
    expect(
      extractGoogleWorkspaceFile("https://docs.google.com/document/d/1abc123/edit")
    ).toEqual({ fileId: "1abc123", docType: "document" });
  });

  it("extracts a Google Sheets file id", () => {
    expect(
      extractGoogleWorkspaceFile(
        "https://docs.google.com/spreadsheets/d/1abc123/edit#gid=0"
      )
    ).toEqual({ fileId: "1abc123", docType: "spreadsheet" });
  });

  it("extracts a Google Slides file id", () => {
    expect(
      extractGoogleWorkspaceFile(
        "https://docs.google.com/presentation/d/1abc123/edit"
      )
    ).toEqual({ fileId: "1abc123", docType: "presentation" });
  });

  it("extracts a file id with no trailing path", () => {
    expect(
      extractGoogleWorkspaceFile("https://docs.google.com/document/d/1abc123")
    ).toEqual({ fileId: "1abc123", docType: "document" });
  });

  it("returns null for a non-Google URL", () => {
    expect(extractGoogleWorkspaceFile("https://example.com/document/d/1abc123")).toBeNull();
  });

  it("returns null for drive.google.com (folders/other Drive links, out of scope)", () => {
    expect(
      extractGoogleWorkspaceFile("https://drive.google.com/drive/folders/1abc123")
    ).toBeNull();
  });

  it("returns null for an unsupported docs.google.com path (e.g. Forms)", () => {
    expect(
      extractGoogleWorkspaceFile("https://docs.google.com/forms/d/1abc123/edit")
    ).toBeNull();
  });

  it("returns null for a malformed URL without throwing", () => {
    expect(() => extractGoogleWorkspaceFile("not a url")).not.toThrow();
    expect(extractGoogleWorkspaceFile("not a url")).toBeNull();
  });

  it("returns null for an empty string", () => {
    expect(extractGoogleWorkspaceFile("")).toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- workspace-url`
Expected: FAIL — `Cannot find module './workspace-url'`

- [ ] **Step 3: Implement**

```ts
// src/lib/google/workspace-url.ts
export type GoogleWorkspaceDocType = "document" | "spreadsheet" | "presentation";

export type GoogleWorkspaceFile = {
  fileId: string;
  docType: GoogleWorkspaceDocType;
};

const PATH_PATTERN = /^\/(document|spreadsheets|presentation)\/d\/([a-zA-Z0-9_-]+)/;

export function extractGoogleWorkspaceFile(url: string): GoogleWorkspaceFile | null {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.hostname !== "docs.google.com") return null;

  const match = PATH_PATTERN.exec(parsed.pathname);
  if (!match) return null;

  const [, segment, fileId] = match;
  const docType: GoogleWorkspaceDocType =
    segment === "document" ? "document" : segment === "spreadsheets" ? "spreadsheet" : "presentation";

  return { fileId, docType };
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- workspace-url`
Expected: PASS (9 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/workspace-url.ts src/lib/google/workspace-url.test.ts
git commit -m "feat: extract Google Drive file id from Docs/Sheets/Slides URLs"
```

---

### Task 3: Bounded-concurrency map helper

**Files:**
- Create: `src/lib/google/concurrency.ts`
- Test: `src/lib/google/concurrency.test.ts`

**Interfaces:**
- Produces: `mapWithConcurrency<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]>` — results are in the same order as `items`. Consumed by the Drive metadata Route Handler (Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/google/concurrency.test.ts
import { describe, expect, it, vi } from "vitest";
import { mapWithConcurrency } from "./concurrency";

describe("mapWithConcurrency", () => {
  it("resolves results in input order regardless of completion order", async () => {
    const delays = [30, 10, 20];
    const results = await mapWithConcurrency(delays, 3, (ms) =>
      new Promise<number>((resolve) => setTimeout(() => resolve(ms), ms))
    );
    expect(results).toEqual([30, 10, 20]);
  });

  it("never runs more than `limit` tasks concurrently", async () => {
    let active = 0;
    let maxActive = 0;
    const items = Array.from({ length: 10 }, (_, i) => i);

    await mapWithConcurrency(items, 3, async (i) => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise((resolve) => setTimeout(resolve, 5));
      active -= 1;
      return i;
    });

    expect(maxActive).toBeLessThanOrEqual(3);
  });

  it("returns an empty array for empty input", async () => {
    const fn = vi.fn();
    const results = await mapWithConcurrency([], 4, fn);
    expect(results).toEqual([]);
    expect(fn).not.toHaveBeenCalled();
  });

  it("handles a limit larger than the item count", async () => {
    const results = await mapWithConcurrency([1, 2], 10, async (n) => n * 2);
    expect(results).toEqual([2, 4]);
  });

  it("propagates a rejection from any task", async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      })
    ).rejects.toThrow("boom");
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- concurrency`
Expected: FAIL — `Cannot find module './concurrency'`

- [ ] **Step 3: Implement**

```ts
// src/lib/google/concurrency.ts
export async function mapWithConcurrency<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let cursor = 0;

  async function worker(): Promise<void> {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      results[index] = await fn(items[index]);
    }
  }

  const workerCount = Math.max(1, Math.min(limit, items.length));
  await Promise.all(Array.from({ length: workerCount }, () => worker()));

  return results;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- concurrency`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/concurrency.ts src/lib/google/concurrency.test.ts
git commit -m "feat: add bounded-concurrency async map helper"
```

---

### Task 4: Drive file metadata fetch (server-side)

**Files:**
- Create: `src/lib/google/drive-metadata.ts`
- Test: `src/lib/google/drive-metadata.test.ts`

**Interfaces:**
- Produces: `fetchDriveFileMetadata(fileId: string, accessToken: string): Promise<DriveFileMetadata | null>` where `DriveFileMetadata = { name: string; mimeType: string }`. Never throws. Consumed by the Drive metadata Route Handler (Task 8).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/google/drive-metadata.test.ts
import { describe, expect, it, vi, afterEach } from "vitest";
import { fetchDriveFileMetadata } from "./drive-metadata";

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function stubFetch(impl: typeof fetch) {
  vi.stubGlobal("fetch", impl);
}

describe("fetchDriveFileMetadata", () => {
  it("returns name and mimeType on a successful response", async () => {
    stubFetch(
      vi.fn(async () =>
        new Response(
          JSON.stringify({ id: "1abc", name: "Quarterly Product Strategy", mimeType: "application/vnd.google-apps.document" }),
          { status: 200 }
        )
      ) as unknown as typeof fetch
    );

    const result = await fetchDriveFileMetadata("1abc", "token-123");
    expect(result).toEqual({
      name: "Quarterly Product Strategy",
      mimeType: "application/vnd.google-apps.document",
    });
  });

  it("sends the access token as a bearer header and requests only id,name,mimeType", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ name: "Doc" }), { status: 200 }));
    stubFetch(fetchMock as unknown as typeof fetch);

    await fetchDriveFileMetadata("file-1", "my-token");

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain("/drive/v3/files/file-1");
    expect(url).toContain("fields=id%2Cname%2CmimeType");
    expect((init.headers as Record<string, string>).Authorization).toBe("Bearer my-token");
  });

  it("returns null when the file doesn't exist (404)", async () => {
    stubFetch(vi.fn(async () => new Response("", { status: 404 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("missing", "token")).toBeNull();
  });

  it("returns null when access is denied (403)", async () => {
    stubFetch(vi.fn(async () => new Response("", { status: 403 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("forbidden", "token")).toBeNull();
  });

  it("returns null on a server/rate-limit error (500/429)", async () => {
    stubFetch(vi.fn(async () => new Response("", { status: 429 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("rate-limited", "token")).toBeNull();
  });

  it("returns null when the response body is missing a name", async () => {
    stubFetch(vi.fn(async () => new Response(JSON.stringify({ id: "x" }), { status: 200 })) as unknown as typeof fetch);
    expect(await fetchDriveFileMetadata("x", "token")).toBeNull();
  });

  it("returns null on a network failure without throwing", async () => {
    stubFetch(vi.fn(async () => { throw new TypeError("network error"); }) as unknown as typeof fetch);
    await expect(fetchDriveFileMetadata("x", "token")).resolves.toBeNull();
  });

  it("aborts and returns null when the request exceeds the timeout", async () => {
    stubFetch(
      vi.fn((_url: string, init?: RequestInit) => {
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")));
        });
      }) as unknown as typeof fetch
    );

    vi.useFakeTimers();
    const promise = fetchDriveFileMetadata("slow", "token");
    await vi.advanceTimersByTimeAsync(6000);
    await expect(promise).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- drive-metadata`
Expected: FAIL — `Cannot find module './drive-metadata'`

- [ ] **Step 3: Implement**

```ts
// src/lib/google/drive-metadata.ts
export type DriveFileMetadata = {
  name: string;
  mimeType: string;
};

const DRIVE_FILE_FIELDS = "id,name,mimeType";
const REQUEST_TIMEOUT_MS = 5000;

export async function fetchDriveFileMetadata(
  fileId: string,
  accessToken: string
): Promise<DriveFileMetadata | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { name?: string; mimeType?: string };
    if (!data.name) return null;

    return { name: data.name, mimeType: data.mimeType ?? "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- drive-metadata`
Expected: PASS (8 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/drive-metadata.ts src/lib/google/drive-metadata.test.ts
git commit -m "feat: fetch Drive file metadata with timeout and graceful fallback"
```

---

### Task 5: Google OAuth token refresh helper

**Files:**
- Create: `src/lib/google/refresh-token.ts`
- Test: `src/lib/google/refresh-token.test.ts`

**Interfaces:**
- Produces: `refreshGoogleAccessToken(refreshToken: string, credentials: { clientId: string; clientSecret: string }): Promise<RefreshedGoogleToken | null>` where `RefreshedGoogleToken = { accessToken: string; expiresAt: number; refreshToken: string }` (`expiresAt` is an absolute `Date.now()`-style ms timestamp). Never throws. Consumed by `src/auth.ts` (Task 6).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/google/refresh-token.test.ts
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { refreshGoogleAccessToken } from "./refresh-token";

const CREDENTIALS = { clientId: "client-1", clientSecret: "secret-1" };

beforeEach(() => {
  vi.useFakeTimers().setSystemTime(new Date("2026-01-01T00:00:00Z"));
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("refreshGoogleAccessToken", () => {
  it("returns a new access token and absolute expiry on success", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: "new-token", expires_in: 3600 }),
          { status: 200 }
        )
      )
    );

    const result = await refreshGoogleAccessToken("refresh-1", CREDENTIALS);

    expect(result).toEqual({
      accessToken: "new-token",
      expiresAt: Date.now() + 3600 * 1000,
      refreshToken: "refresh-1",
    });
  });

  it("posts to Google's token endpoint with grant_type=refresh_token", async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({ access_token: "t", expires_in: 60 }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    await refreshGoogleAccessToken("refresh-1", CREDENTIALS);

    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://oauth2.googleapis.com/token");
    const body = new URLSearchParams(init.body as string);
    expect(body.get("grant_type")).toBe("refresh_token");
    expect(body.get("refresh_token")).toBe("refresh-1");
    expect(body.get("client_id")).toBe("client-1");
    expect(body.get("client_secret")).toBe("secret-1");
  });

  it("uses Google's rotated refresh token when one is returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        new Response(
          JSON.stringify({ access_token: "t", expires_in: 60, refresh_token: "rotated" }),
          { status: 200 }
        )
      )
    );

    const result = await refreshGoogleAccessToken("refresh-1", CREDENTIALS);
    expect(result?.refreshToken).toBe("rotated");
  });

  it("returns null when Google responds with an error status", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => new Response("", { status: 400 })));
    expect(await refreshGoogleAccessToken("refresh-1", CREDENTIALS)).toBeNull();
  });

  it("returns null on network failure without throwing", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("network down");
      })
    );
    await expect(refreshGoogleAccessToken("refresh-1", CREDENTIALS)).resolves.toBeNull();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- refresh-token`
Expected: FAIL — `Cannot find module './refresh-token'`

- [ ] **Step 3: Implement**

```ts
// src/lib/google/refresh-token.ts
export type RefreshedGoogleToken = {
  accessToken: string;
  expiresAt: number;
  refreshToken: string;
};

export async function refreshGoogleAccessToken(
  refreshToken: string,
  credentials: { clientId: string; clientSecret: string }
): Promise<RefreshedGoogleToken | null> {
  try {
    const response = await fetch("https://oauth2.googleapis.com/token", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: credentials.clientId,
        client_secret: credentials.clientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });

    if (!response.ok) return null;

    const data = (await response.json()) as {
      access_token: string;
      expires_in: number;
      refresh_token?: string;
    };

    return {
      accessToken: data.access_token,
      expiresAt: Date.now() + data.expires_in * 1000,
      refreshToken: data.refresh_token ?? refreshToken,
    };
  } catch {
    return null;
  }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- refresh-token`
Expected: PASS (5 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/refresh-token.ts src/lib/google/refresh-token.test.ts
git commit -m "feat: add Google OAuth access token refresh helper"
```

---

### Task 6: Auth.js configuration and route handler

**Files:**
- Create: `src/auth.ts`
- Create: `src/types/next-auth.d.ts`
- Create: `src/app/api/auth/[...nextauth]/route.ts`

**Interfaces:**
- Consumes: `refreshGoogleAccessToken` from `src/lib/google/refresh-token.ts` (Task 5).
- Produces: `auth()` (server-only session getter returning `{ ..., accessToken?: string, error?: "RefreshAccessTokenError" }`), plus `handlers`, `signIn`, `signOut` re-exported from `next-auth`. Consumed by the Drive metadata Route Handler (Task 8) and by `next-auth/react`'s `useSession`/`signIn` on the client (Tasks 10–11).

- [ ] **Step 1: Add the session/JWT type augmentation**

```ts
// src/types/next-auth.d.ts
import type { DefaultSession } from "next-auth";

declare module "next-auth" {
  interface Session extends DefaultSession {
    accessToken?: string;
    error?: "RefreshAccessTokenError";
  }
}

declare module "next-auth/jwt" {
  interface JWT {
    accessToken?: string;
    refreshToken?: string;
    expiresAt?: number;
    error?: "RefreshAccessTokenError";
  }
}
```

- [ ] **Step 2: Write the Auth.js config**

```ts
// src/auth.ts
import NextAuth from "next-auth";
import Google from "next-auth/providers/google";
import { refreshGoogleAccessToken } from "@/lib/google/refresh-token";

const DRIVE_METADATA_SCOPE = "https://www.googleapis.com/auth/drive.metadata.readonly";
const REFRESH_SKEW_MS = 60_000;

export const { handlers, auth, signIn, signOut } = NextAuth({
  providers: [
    Google({
      clientId: process.env.GOOGLE_CLIENT_ID,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET,
      authorization: {
        params: {
          scope: `openid email profile ${DRIVE_METADATA_SCOPE}`,
          access_type: "offline",
          prompt: "consent",
        },
      },
    }),
  ],
  callbacks: {
    async jwt({ token, account }) {
      if (account) {
        token.accessToken = account.access_token;
        token.refreshToken = account.refresh_token;
        token.expiresAt = account.expires_at ? account.expires_at * 1000 : 0;
        token.error = undefined;
        return token;
      }

      if (typeof token.expiresAt === "number" && Date.now() < token.expiresAt - REFRESH_SKEW_MS) {
        return token;
      }

      if (typeof token.refreshToken !== "string") {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      const clientId = process.env.GOOGLE_CLIENT_ID;
      const clientSecret = process.env.GOOGLE_CLIENT_SECRET;
      if (!clientId || !clientSecret) {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      const refreshed = await refreshGoogleAccessToken(token.refreshToken, { clientId, clientSecret });
      if (!refreshed) {
        return { ...token, error: "RefreshAccessTokenError" };
      }

      return {
        ...token,
        accessToken: refreshed.accessToken,
        expiresAt: refreshed.expiresAt,
        refreshToken: refreshed.refreshToken,
        error: undefined,
      };
    },
    async session({ session, token }) {
      session.accessToken = typeof token.accessToken === "string" ? token.accessToken : undefined;
      session.error = token.error;
      return session;
    },
  },
});
```

- [ ] **Step 3: Add the route handler**

```ts
// src/app/api/auth/[...nextauth]/route.ts
import { handlers } from "@/auth";

export const { GET, POST } = handlers;
```

- [ ] **Step 4: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors from `src/auth.ts`, `src/types/next-auth.d.ts`, or the new route file. (Full-project type-check happens again in the final verification task — this is a scoped check to catch mistakes early.)

- [ ] **Step 5: Commit**

```bash
git add src/auth.ts src/types/next-auth.d.ts "src/app/api/auth/[...nextauth]/route.ts"
git commit -m "feat: configure Auth.js with Google provider and JWT token refresh"
```

---

### Task 7: SessionProvider wiring

**Files:**
- Create: `src/components/providers.tsx`
- Modify: `src/app/layout.tsx`

**Interfaces:**
- Produces: `<Providers>` client-component wrapper. Required so `next-auth/react`'s `useSession()` (used by the hook in Task 10 and transitively by `AppShell`) has a context to read from in the real app (not in tests — those mock the hook/module directly, see Tasks 9 and 12).

- [ ] **Step 1: Create the client wrapper**

`layout.tsx` is a Server Component; `SessionProvider` requires a Client Component boundary.

```tsx
// src/components/providers.tsx
"use client"

import { SessionProvider } from "next-auth/react"

export function Providers({ children }: { children: React.ReactNode }) {
  return <SessionProvider>{children}</SessionProvider>
}
```

- [ ] **Step 2: Wrap the app in `layout.tsx`**

```tsx
// src/app/layout.tsx
import type { Metadata } from "next";
import { Geist, Geist_Mono } from "next/font/google";
import { Toaster } from "@/components/ui/sonner";
import { Providers } from "@/components/providers";
import "./globals.css";

const geistSans = Geist({
  variable: "--font-geist-sans",
  subsets: ["latin"],
});

const geistMono = Geist_Mono({
  variable: "--font-geist-mono",
  subsets: ["latin"],
});

export const metadata: Metadata = {
  title: "TabDump",
  description: "Paste your browser tabs. Turn the chaos into an organized workspace.",
};

export default function RootLayout({ children }: LayoutProps<"/">) {
  return (
    <html
      lang="en"
      className={`dark ${geistSans.variable} ${geistMono.variable} h-full antialiased`}
    >
      <body className="min-h-full flex flex-col">
        <Providers>
          {children}
          <Toaster position="bottom-right" />
        </Providers>
      </body>
    </html>
  );
}
```

- [ ] **Step 3: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 4: Commit**

```bash
git add src/components/providers.tsx src/app/layout.tsx
git commit -m "feat: wrap app in Auth.js SessionProvider"
```

---

### Task 8: Drive metadata Route Handler

**Files:**
- Create: `src/app/api/google/drive-metadata/route.ts`
- Test: `src/app/api/google/drive-metadata/route.test.ts`

**Interfaces:**
- Consumes: `auth()` from `@/auth` (Task 6, mocked in tests), `fetchDriveFileMetadata` from `@/lib/google/drive-metadata` (Task 4, mocked in tests), `mapWithConcurrency` from `@/lib/google/concurrency` (Task 3, real).
- Produces: `POST /api/google/drive-metadata` accepting `{ fileIds: string[] }`, returning `{ authenticated: boolean; results: Record<string, { name: string; mimeType: string } | null> }`. Consumed by `resolveGoogleFileTitles` (Task 9).

- [ ] **Step 1: Write the failing tests**

```ts
// src/app/api/google/drive-metadata/route.test.ts
import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "./route";

const authMock = vi.fn();
const fetchDriveFileMetadataMock = vi.fn();

vi.mock("@/auth", () => ({
  auth: () => authMock(),
}));

vi.mock("@/lib/google/drive-metadata", () => ({
  fetchDriveFileMetadata: (fileId: string, token: string) => fetchDriveFileMetadataMock(fileId, token),
}));

function postRequest(body: unknown) {
  return new Request("http://localhost/api/google/drive-metadata", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

beforeEach(() => {
  authMock.mockReset();
  fetchDriveFileMetadataMock.mockReset();
});

describe("POST /api/google/drive-metadata", () => {
  it("returns authenticated:false and no results when there is no session", async () => {
    authMock.mockResolvedValue(null);

    const res = await POST(postRequest({ fileIds: ["a"] }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ authenticated: false, results: {} });
    expect(fetchDriveFileMetadataMock).not.toHaveBeenCalled();
  });

  it("returns authenticated:false when the session carries a refresh error", async () => {
    authMock.mockResolvedValue({ accessToken: "stale", error: "RefreshAccessTokenError" });

    const res = await POST(postRequest({ fileIds: ["a"] }));
    const data = await res.json();

    expect(data.authenticated).toBe(false);
    expect(fetchDriveFileMetadataMock).not.toHaveBeenCalled();
  });

  it("resolves metadata for each requested file id when authenticated", async () => {
    authMock.mockResolvedValue({ accessToken: "token-123" });
    fetchDriveFileMetadataMock.mockImplementation(async (fileId: string) =>
      fileId === "a" ? { name: "Quarterly Product Strategy", mimeType: "doc" } : null
    );

    const res = await POST(postRequest({ fileIds: ["a", "b"] }));
    const data = await res.json();

    expect(data.authenticated).toBe(true);
    expect(data.results).toEqual({
      a: { name: "Quarterly Product Strategy", mimeType: "doc" },
      b: null,
    });
    expect(fetchDriveFileMetadataMock).toHaveBeenCalledWith("a", "token-123");
    expect(fetchDriveFileMetadataMock).toHaveBeenCalledWith("b", "token-123");
  });

  it("de-duplicates repeated file ids into a single upstream call", async () => {
    authMock.mockResolvedValue({ accessToken: "token-123" });
    fetchDriveFileMetadataMock.mockResolvedValue({ name: "Doc", mimeType: "doc" });

    const res = await POST(postRequest({ fileIds: ["dup", "dup", "dup"] }));
    const data = await res.json();

    expect(fetchDriveFileMetadataMock).toHaveBeenCalledTimes(1);
    expect(data.results).toEqual({ dup: { name: "Doc", mimeType: "doc" } });
  });

  it("returns 400 for a malformed body without crashing", async () => {
    authMock.mockResolvedValue({ accessToken: "token-123" });

    const res = await POST(postRequest({ fileIds: "not-an-array" }));
    expect(res.status).toBe(400);
    expect(fetchDriveFileMetadataMock).not.toHaveBeenCalled();
  });

  it("returns 400 for invalid JSON without crashing", async () => {
    const req = new Request("http://localhost/api/google/drive-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: "{not json",
    });

    const res = await POST(req);
    expect(res.status).toBe(400);
  });

  it("one failing file id does not affect the others (partial failure)", async () => {
    authMock.mockResolvedValue({ accessToken: "token-123" });
    fetchDriveFileMetadataMock.mockImplementation(async (fileId: string) => {
      if (fileId === "broken") return null;
      return { name: `Title for ${fileId}`, mimeType: "doc" };
    });

    const res = await POST(postRequest({ fileIds: ["ok-1", "broken", "ok-2"] }));
    const data = await res.json();

    expect(data.results["ok-1"]).toEqual({ name: "Title for ok-1", mimeType: "doc" });
    expect(data.results.broken).toBeNull();
    expect(data.results["ok-2"]).toEqual({ name: "Title for ok-2", mimeType: "doc" });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- drive-metadata/route`
Expected: FAIL — `Cannot find module './route'`

- [ ] **Step 3: Implement**

```ts
// src/app/api/google/drive-metadata/route.ts
import { NextResponse } from "next/server";
import { auth } from "@/auth";
import { fetchDriveFileMetadata, type DriveFileMetadata } from "@/lib/google/drive-metadata";
import { mapWithConcurrency } from "@/lib/google/concurrency";

const CONCURRENCY = 4;
const MAX_FILE_IDS = 200;

type ResultsByFileId = Record<string, DriveFileMetadata | null>;

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 });
  }

  const fileIds = parseFileIds(body);
  if (!fileIds) {
    return NextResponse.json({ error: "fileIds must be an array of strings" }, { status: 400 });
  }

  const session = await auth();
  const accessToken = session?.accessToken;

  if (!accessToken || session?.error) {
    return NextResponse.json({ authenticated: false, results: {} as ResultsByFileId });
  }

  const uniqueFileIds = Array.from(new Set(fileIds)).slice(0, MAX_FILE_IDS);
  const metadataList = await mapWithConcurrency(uniqueFileIds, CONCURRENCY, (fileId) =>
    fetchDriveFileMetadata(fileId, accessToken)
  );

  const results: ResultsByFileId = {};
  uniqueFileIds.forEach((fileId, index) => {
    results[fileId] = metadataList[index];
  });

  return NextResponse.json({ authenticated: true, results });
}

function parseFileIds(body: unknown): string[] | null {
  if (typeof body !== "object" || body === null || !("fileIds" in body)) return null;
  const { fileIds } = body as { fileIds: unknown };
  if (!Array.isArray(fileIds) || !fileIds.every((id) => typeof id === "string")) return null;
  return fileIds;
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- drive-metadata/route`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add "src/app/api/google/drive-metadata/route.ts" "src/app/api/google/drive-metadata/route.test.ts"
git commit -m "feat: add Drive metadata resolution route handler"
```

---

### Task 9: Client-side resolver with session cache

**Files:**
- Create: `src/lib/google/resolve-titles.ts`
- Test: `src/lib/google/resolve-titles.test.ts`

**Interfaces:**
- Produces: `resolveGoogleFileTitles(fileIds: string[]): Promise<{ authenticated: boolean; metadataByFileId: Map<string, DriveFileMetadata | null> }>` and `__resetGoogleTitleCacheForTests()`. Consumed by `useGoogleTitleEnrichment` (Task 10).

- [ ] **Step 1: Write the failing tests**

```ts
// src/lib/google/resolve-titles.test.ts
import { describe, expect, it, vi, afterEach, beforeEach } from "vitest";
import { resolveGoogleFileTitles, __resetGoogleTitleCacheForTests } from "./resolve-titles";

beforeEach(() => {
  __resetGoogleTitleCacheForTests();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetchJson(data: unknown, ok = true) {
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => new Response(JSON.stringify(data), { status: ok ? 200 : 500 }))
  );
}

describe("resolveGoogleFileTitles", () => {
  it("posts the requested file ids and returns metadata keyed by id", async () => {
    stubFetchJson({
      authenticated: true,
      results: { a: { name: "Doc A", mimeType: "doc" }, b: null },
    });

    const result = await resolveGoogleFileTitles(["a", "b"]);

    expect(result.authenticated).toBe(true);
    expect(result.metadataByFileId.get("a")).toEqual({ name: "Doc A", mimeType: "doc" });
    expect(result.metadataByFileId.get("b")).toBeNull();
  });

  it("caches resolved results and does not re-fetch the same file id", async () => {
    const fetchMock = vi.fn(async () =>
      new Response(JSON.stringify({ authenticated: true, results: { a: { name: "Doc A", mimeType: "doc" } } }), {
        status: 200,
      })
    );
    vi.stubGlobal("fetch", fetchMock);

    await resolveGoogleFileTitles(["a"]);
    const second = await resolveGoogleFileTitles(["a"]);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(second.metadataByFileId.get("a")).toEqual({ name: "Doc A", mimeType: "doc" });
  });

  it("only requests the uncached subset when some ids are already cached", async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as { fileIds: string[] };
      const results = Object.fromEntries(body.fileIds.map((id) => [id, { name: id, mimeType: "doc" }]));
      return new Response(JSON.stringify({ authenticated: true, results }), { status: 200 });
    });
    vi.stubGlobal("fetch", fetchMock);

    await resolveGoogleFileTitles(["a"]);
    await resolveGoogleFileTitles(["a", "b"]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    const secondCallBody = JSON.parse(String((fetchMock.mock.calls[1][1] as RequestInit).body));
    expect(secondCallBody.fileIds).toEqual(["b"]);
  });

  it("signals authenticated:false without caching failures as permanent", async () => {
    stubFetchJson({ authenticated: false, results: {} });

    const result = await resolveGoogleFileTitles(["a"]);
    expect(result.authenticated).toBe(false);
    expect(result.metadataByFileId.has("a")).toBe(false);
  });

  it("falls back gracefully (authenticated:true, empty map) on a network failure", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => {
        throw new TypeError("offline");
      })
    );

    const result = await resolveGoogleFileTitles(["a"]);
    expect(result.authenticated).toBe(true);
    expect(result.metadataByFileId.size).toBe(0);
  });

  it("falls back gracefully on a non-ok HTTP response", async () => {
    stubFetchJson({}, false);

    const result = await resolveGoogleFileTitles(["a"]);
    expect(result.authenticated).toBe(true);
    expect(result.metadataByFileId.size).toBe(0);
  });

  it("returns an empty result without a network call for an empty input", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const result = await resolveGoogleFileTitles([]);
    expect(fetchMock).not.toHaveBeenCalled();
    expect(result).toEqual({ authenticated: true, metadataByFileId: new Map() });
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- resolve-titles`
Expected: FAIL — `Cannot find module './resolve-titles'`

- [ ] **Step 3: Implement**

```ts
// src/lib/google/resolve-titles.ts
import type { DriveFileMetadata } from "./drive-metadata";

export type { DriveFileMetadata };

export type ResolveTitlesResult = {
  authenticated: boolean;
  metadataByFileId: Map<string, DriveFileMetadata | null>;
};

const cache = new Map<string, DriveFileMetadata | null>();

export async function resolveGoogleFileTitles(fileIds: string[]): Promise<ResolveTitlesResult> {
  if (fileIds.length === 0) {
    return { authenticated: true, metadataByFileId: new Map() };
  }

  const uncached = fileIds.filter((id) => !cache.has(id));
  if (uncached.length === 0) {
    return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
  }

  try {
    const response = await fetch("/api/google/drive-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: uncached }),
    });

    if (!response.ok) {
      return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
    }

    const data = (await response.json()) as {
      authenticated: boolean;
      results: Record<string, DriveFileMetadata | null>;
    };

    if (!data.authenticated) {
      return { authenticated: false, metadataByFileId: pickFromCache(fileIds) };
    }

    for (const [fileId, metadata] of Object.entries(data.results)) {
      cache.set(fileId, metadata);
    }

    return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
  } catch {
    return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
  }
}

function pickFromCache(fileIds: string[]): Map<string, DriveFileMetadata | null> {
  const out = new Map<string, DriveFileMetadata | null>();
  for (const id of fileIds) {
    if (cache.has(id)) out.set(id, cache.get(id) ?? null);
  }
  return out;
}

export function __resetGoogleTitleCacheForTests(): void {
  cache.clear();
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- resolve-titles`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/lib/google/resolve-titles.ts src/lib/google/resolve-titles.test.ts
git commit -m "feat: add session-cached client resolver for Drive titles"
```

---

### Task 10: `useGoogleTitleEnrichment` hook

**Files:**
- Create: `src/hooks/use-google-title-enrichment.ts`
- Test: `src/hooks/use-google-title-enrichment.test.ts`

**Interfaces:**
- Consumes: `extractGoogleWorkspaceFile` (Task 2), `resolveGoogleFileTitles` (Task 9), `useSession` from `next-auth/react` (mocked in tests).
- Produces: `useGoogleTitleEnrichment(tabs: Tab[], onResolved: (updates: { id: string; title: string }[]) => void): { needsSignIn: boolean }`. Consumed by `AppShell` (Task 12).

- [ ] **Step 1: Write the failing tests**

```ts
// src/hooks/use-google-title-enrichment.test.ts
import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useGoogleTitleEnrichment } from "./use-google-title-enrichment";
import type { Tab } from "@/lib/tabs/types";

const useSessionMock = vi.fn();
vi.mock("next-auth/react", () => ({
  useSession: () => useSessionMock(),
}));

const resolveGoogleFileTitlesMock = vi.fn();
vi.mock("@/lib/google/resolve-titles", () => ({
  resolveGoogleFileTitles: (ids: string[]) => resolveGoogleFileTitlesMock(ids),
}));

function makeTab(over: Partial<Tab>): Tab {
  return {
    id: over.id ?? "id",
    url: over.url ?? "https://example.com",
    normalizedUrl: over.url ?? "https://example.com",
    domain: "example.com",
    ...over,
  };
}

beforeEach(() => {
  useSessionMock.mockReset();
  resolveGoogleFileTitlesMock.mockReset();
});

afterEach(() => {
  vi.clearAllMocks();
});

describe("useGoogleTitleEnrichment", () => {
  it("does nothing for tabs with no Google Workspace URLs", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" });
    const onResolved = vi.fn();
    const tabs = [makeTab({ id: "1", url: "https://github.com/a" })];

    renderHook(() => useGoogleTitleEnrichment(tabs, onResolved));

    await new Promise((r) => setTimeout(r, 0));
    expect(resolveGoogleFileTitlesMock).not.toHaveBeenCalled();
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("reports needsSignIn and does not call the resolver while unauthenticated", async () => {
    useSessionMock.mockReturnValue({ status: "unauthenticated" });
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];

    const { result } = renderHook(() => useGoogleTitleEnrichment(tabs, vi.fn()));

    await waitFor(() => expect(result.current.needsSignIn).toBe(true));
    expect(resolveGoogleFileTitlesMock).not.toHaveBeenCalled();
  });

  it("does nothing while the session is still loading", async () => {
    useSessionMock.mockReturnValue({ status: "loading" });
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];

    renderHook(() => useGoogleTitleEnrichment(tabs, vi.fn()));

    await new Promise((r) => setTimeout(r, 0));
    expect(resolveGoogleFileTitlesMock).not.toHaveBeenCalled();
  });

  it("resolves a matching tab's title when authenticated and reports it via onResolved", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" });
    resolveGoogleFileTitlesMock.mockResolvedValue({
      authenticated: true,
      metadataByFileId: new Map([["abc", { name: "Quarterly Product Strategy", mimeType: "doc" }]]),
    });
    const onResolved = vi.fn();
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];

    renderHook(() => useGoogleTitleEnrichment(tabs, onResolved));

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith([{ id: "1", title: "Quarterly Product Strategy" }])
    );
  });

  it("does not call onResolved when the resolver returns null for the file", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" });
    resolveGoogleFileTitlesMock.mockResolvedValue({
      authenticated: true,
      metadataByFileId: new Map([["abc", null]]),
    });
    const onResolved = vi.fn();
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];

    renderHook(() => useGoogleTitleEnrichment(tabs, onResolved));

    await waitFor(() => expect(resolveGoogleFileTitlesMock).toHaveBeenCalled());
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("does not re-request a file id that was already attempted", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" });
    resolveGoogleFileTitlesMock.mockResolvedValue({
      authenticated: true,
      metadataByFileId: new Map([["abc", null]]),
    });
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];

    const { rerender } = renderHook(({ t }) => useGoogleTitleEnrichment(t, vi.fn()), {
      initialProps: { t: tabs },
    });

    await waitFor(() => expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(1));
    rerender({ t: [...tabs] });
    await new Promise((r) => setTimeout(r, 0));

    expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(1);
  });

  it("does not call onResolved once a tab already has a title", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" });
    const onResolved = vi.fn();
    const tabs = [
      makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit", title: "Already resolved" }),
    ];

    renderHook(() => useGoogleTitleEnrichment(tabs, onResolved));

    await new Promise((r) => setTimeout(r, 0));
    expect(resolveGoogleFileTitlesMock).not.toHaveBeenCalled();
  });
});
```

- [ ] **Step 2: Run tests to verify they fail**

Run: `npm test -- use-google-title-enrichment`
Expected: FAIL — `Cannot find module './use-google-title-enrichment'`

- [ ] **Step 3: Implement**

```ts
// src/hooks/use-google-title-enrichment.ts
"use client"

import { useEffect, useRef, useState } from "react"
import { useSession } from "next-auth/react"
import { extractGoogleWorkspaceFile } from "@/lib/google/workspace-url"
import { resolveGoogleFileTitles } from "@/lib/google/resolve-titles"
import type { Tab } from "@/lib/tabs/types"

type TitleUpdate = { id: string; title: string }

export function useGoogleTitleEnrichment(
  tabs: Tab[],
  onResolved: (updates: TitleUpdate[]) => void
): { needsSignIn: boolean } {
  const { status } = useSession()
  const attemptedFileIds = useRef<Set<string>>(new Set())
  const [needsSignIn, setNeedsSignIn] = useState(false)

  useEffect(() => {
    if (status === "loading") return

    const candidates = tabs
      .map((tab) => {
        if (tab.title?.trim()) return null
        const match = extractGoogleWorkspaceFile(tab.url)
        return match ? { tab, fileId: match.fileId } : null
      })
      .filter((c): c is { tab: Tab; fileId: string } => c !== null)

    if (candidates.length === 0) {
      setNeedsSignIn(false)
      return
    }

    if (status !== "authenticated") {
      setNeedsSignIn(true)
      return
    }

    const pending = candidates.filter((c) => !attemptedFileIds.current.has(c.fileId))
    if (pending.length === 0) return

    pending.forEach((c) => attemptedFileIds.current.add(c.fileId))
    let cancelled = false

    resolveGoogleFileTitles(pending.map((c) => c.fileId)).then((result) => {
      if (cancelled) return

      if (!result.authenticated) {
        pending.forEach((c) => attemptedFileIds.current.delete(c.fileId))
        setNeedsSignIn(true)
        return
      }

      setNeedsSignIn(false)
      const updates = pending
        .map((c) => {
          const metadata = result.metadataByFileId.get(c.fileId)
          return metadata ? { id: c.tab.id, title: metadata.name } : null
        })
        .filter((u): u is TitleUpdate => u !== null)

      if (updates.length > 0) onResolved(updates)
    })

    return () => {
      cancelled = true
    }
  }, [tabs, status, onResolved])

  return { needsSignIn }
}
```

- [ ] **Step 4: Run tests to verify they pass**

Run: `npm test -- use-google-title-enrichment`
Expected: PASS (7 tests)

- [ ] **Step 5: Commit**

```bash
git add src/hooks/use-google-title-enrichment.ts src/hooks/use-google-title-enrichment.test.ts
git commit -m "feat: add background hook that enriches Google Workspace tab titles"
```

---

### Task 11: Sign-in banner component

**Files:**
- Create: `src/components/workspace/google-signin-banner.tsx`

**Interfaces:**
- Produces: `<GoogleSignInBanner />` — no props. Consumed by `WorkspaceView` (Task 12).

- [ ] **Step 1: Implement**

Visually consistent with the existing `AttentionStrip` pattern (`src/components/workspace/attention-strip.tsx:30`), reusing the same border/background/`Button` treatment already established in the codebase.

```tsx
// src/components/workspace/google-signin-banner.tsx
"use client"

import { LogIn } from "lucide-react"
import { signIn } from "next-auth/react"
import { Button } from "@/components/ui/button"

export function GoogleSignInBanner() {
  return (
    <div className="flex items-center gap-2 rounded-lg border border-subtle bg-primary/[0.06] px-3 py-2">
      <LogIn className="size-4 shrink-0 text-accent-text" aria-hidden />
      <p className="text-body-sm text-foreground">
        Sign in with Google to show real titles for Docs, Sheets, and Slides links.
      </p>
      <Button
        variant="ghost"
        size="sm"
        className="ml-auto shrink-0"
        onClick={() => signIn("google")}
      >
        Sign in
      </Button>
    </div>
  )
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no new errors.

- [ ] **Step 3: Commit**

```bash
git add src/components/workspace/google-signin-banner.tsx
git commit -m "feat: add unobtrusive Google sign-in banner"
```

---

### Task 12: Wire enrichment into AppShell and WorkspaceView

**Files:**
- Modify: `src/components/app-shell.tsx`
- Modify: `src/components/app-shell.test.tsx`
- Modify: `src/components/workspace/workspace-view.tsx`

**Interfaces:**
- Consumes: `useGoogleTitleEnrichment` (Task 10), `GoogleSignInBanner` (Task 11).
- Produces: `WorkspaceView` gains an optional `googleSignInPrompt?: boolean` prop (default falsy, so existing callers/tests are unaffected).

- [ ] **Step 1: Update `app-shell.tsx`**

```tsx
// src/components/app-shell.tsx
"use client"

import { useCallback, useEffect, useState } from "react"
import { toast } from "sonner"
import { LandingView } from "@/components/landing-view"
import { WorkspaceView } from "@/components/workspace/workspace-view"
import { useGoogleTitleEnrichment } from "@/hooks/use-google-title-enrichment"
import {
  clearWorkspaceStorage,
  isStorageAvailable,
  loadWorkspace,
  saveWorkspace,
} from "@/lib/workspace/persistence"
import type { Tab } from "@/lib/tabs/types"

export function AppShell() {
  const [workspaceTabs, setWorkspaceTabs] = useState<Tab[] | null>(null)
  const [hydrated, setHydrated] = useState(false)
  const [canPersist, setCanPersist] = useState(true)

  useEffect(() => {
    // Hydrating from localStorage: this can only run post-mount (SSR has no
    // access to it, and reading it during render would cause a hydration
    // mismatch), so there is no way to derive this during render instead —
    // it's exactly the "synchronize with an external system on mount" case
    // effects exist for, not the derived-state anti-pattern this rule targets.
    const available = isStorageAvailable()
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCanPersist(available)
    if (available) {
      const persisted = loadWorkspace()
      if (persisted && persisted.length > 0) setWorkspaceTabs(persisted)
    } else {
      toast.info("Your workspace won't be saved between visits", {
        description: "Local storage isn't available in this browser.",
      })
    }
    setHydrated(true)
  }, [])

  function persist(tabs: Tab[]) {
    if (canPersist) saveWorkspace(tabs)
  }

  function handleDump(tabs: Tab[]) {
    setWorkspaceTabs(tabs)
    persist(tabs)
  }

  function handleTabsChange(tabs: Tab[]) {
    setWorkspaceTabs(tabs)
    persist(tabs)
  }

  function handleClear() {
    setWorkspaceTabs(null)
    clearWorkspaceStorage()
  }

  const handleGoogleTitlesResolved = useCallback(
    (updates: { id: string; title: string }[]) => {
      setWorkspaceTabs((prev) => {
        if (!prev) return prev
        const titleById = new Map(updates.map((u) => [u.id, u.title]))
        const next = prev.map((t) => (titleById.has(t.id) ? { ...t, title: titleById.get(t.id) } : t))
        if (canPersist) saveWorkspace(next)
        return next
      })
    },
    [canPersist]
  )

  const { needsSignIn } = useGoogleTitleEnrichment(workspaceTabs ?? [], handleGoogleTitlesResolved)

  if (!hydrated) return null

  if (!workspaceTabs) {
    return <LandingView onDump={handleDump} />
  }

  return (
    <WorkspaceView
      tabs={workspaceTabs}
      onTabsChange={handleTabsChange}
      onClear={handleClear}
      googleSignInPrompt={needsSignIn}
    />
  )
}
```

- [ ] **Step 2: Accept and render the prompt in `WorkspaceView`**

```tsx
// src/components/workspace/workspace-view.tsx — updated signature and render
```

Add the import near the other workspace component imports (after the `AttentionStrip` import, `workspace-view.tsx:34`):

```tsx
import { GoogleSignInBanner } from "@/components/workspace/google-signin-banner"
```

Update the props type (`workspace-view.tsx:62-70`):

```tsx
export function WorkspaceView({
  tabs,
  onTabsChange,
  onClear,
  googleSignInPrompt = false,
}: {
  tabs: Tab[]
  onTabsChange: (tabs: Tab[]) => void
  onClear: () => void
  googleSignInPrompt?: boolean
}) {
```

Render the banner above the existing `AttentionStrip` (`workspace-view.tsx:361-365`), keeping `AttentionStrip` itself untouched:

```tsx
      <main className="mx-auto max-w-6xl px-6 py-8">
        {googleSignInPrompt && (
          <div className="mb-4">
            <GoogleSignInBanner />
          </div>
        )}
        <AttentionStrip
          attention={attention}
          onCleanup={() => setCleanupOpen(true)}
          onViewOther={() => handleCategoryFilter("other")}
        />
```

- [ ] **Step 3: Update `app-shell.test.tsx` to mock the enrichment hook**

Existing tests render `<AppShell />` directly, with no `SessionProvider` ancestor, so the real hook (which calls `next-auth/react`'s `useSession`) would throw. Mock the hook itself so these tests stay focused on persistence behavior, which is unaffected by this feature:

```tsx
// src/components/app-shell.test.tsx — add near the top, after existing imports
import { describe, expect, it, beforeEach, afterEach, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AppShell } from "./app-shell";

vi.mock("@/hooks/use-google-title-enrichment", () => ({
  useGoogleTitleEnrichment: () => ({ needsSignIn: false }),
}));

beforeEach(() => {
  window.localStorage.clear();
});
```

(Only the `vi.mock` block and its import lines are new; the rest of the file, including every existing `it(...)`, is unchanged.)

- [ ] **Step 4: Run the full test suite**

Run: `npm test`
Expected: PASS — all existing tests plus every new test from Tasks 2–10.

- [ ] **Step 5: Commit**

```bash
git add src/components/app-shell.tsx src/components/app-shell.test.tsx src/components/workspace/workspace-view.tsx
git commit -m "feat: wire Google title enrichment and sign-in prompt into the workspace"
```

---

### Task 13: Non-blocking bulk import behavior test

**Files:**
- Modify: `src/hooks/use-google-title-enrichment.test.ts`

**Interfaces:**
- Consumes: everything from Task 10, unchanged.

- [ ] **Step 1: Add a test proving initial (fallback) state is available before resolution completes**

Append to the `describe("useGoogleTitleEnrichment", ...)` block from Task 10:

```ts
  it("does not block on the resolver: state stays synchronous until the promise settles", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" })
    let resolvePromise!: (value: {
      authenticated: boolean
      metadataByFileId: Map<string, { name: string; mimeType: string } | null>
    }) => void
    resolveGoogleFileTitlesMock.mockReturnValue(
      new Promise((resolve) => {
        resolvePromise = resolve
      })
    )
    const onResolved = vi.fn()
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })]

    const { result } = renderHook(() => useGoogleTitleEnrichment(tabs, onResolved))

    // The hook has kicked off the request but nothing has resolved yet —
    // callers (AppShell) already rendered the fallback-titled tab by this point.
    expect(onResolved).not.toHaveBeenCalled()
    expect(result.current.needsSignIn).toBe(false)

    resolvePromise({
      authenticated: true,
      metadataByFileId: new Map([["abc", { name: "Resolved Later", mimeType: "doc" }]]),
    })

    await waitFor(() =>
      expect(onResolved).toHaveBeenCalledWith([{ id: "1", title: "Resolved Later" }])
    )
  })

  it("resolves 50 distinct Google Workspace tabs in a single batched call, not one request per tab", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" })
    resolveGoogleFileTitlesMock.mockResolvedValue({ authenticated: true, metadataByFileId: new Map() })
    const tabs = Array.from({ length: 50 }, (_, i) =>
      makeTab({ id: `${i}`, url: `https://docs.google.com/document/d/file-${i}/edit` })
    )

    renderHook(() => useGoogleTitleEnrichment(tabs, vi.fn()))

    await waitFor(() => expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(1))
    expect(resolveGoogleFileTitlesMock.mock.calls[0][0]).toHaveLength(50)
  })
```

- [ ] **Step 2: Run tests to verify they pass**

Run: `npm test -- use-google-title-enrichment`
Expected: PASS (9 tests total for this file)

- [ ] **Step 3: Commit**

```bash
git add src/hooks/use-google-title-enrichment.test.ts
git commit -m "test: verify Google title enrichment doesn't block bulk imports"
```

---

### Task 14: Final verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full test suite**

Run: `npm test`
Expected: all tests pass, including every pre-existing test file untouched by this plan.

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit`
Expected: no errors.

- [ ] **Step 3: Lint**

Run: `npm run lint`
Expected: no errors.

- [ ] **Step 4: Production build**

Run: `npm run build`
Expected: build succeeds. Confirm the build log shows `ƒ /api/auth/[...nextauth]` and `ƒ /api/google/drive-metadata` as dynamic Route Handlers.

- [ ] **Step 5: Manual verification (requires real Google OAuth credentials — see plan summary)**

With `GOOGLE_CLIENT_ID`, `GOOGLE_CLIENT_SECRET`, and `AUTH_SECRET` set in `.env.local` and matching redirect URIs configured in Google Cloud Console:

1. `npm run dev`, open the app, paste a private Google Doc URL you can access. Confirm it first shows `docs.google.com`, then a `GoogleSignInBanner` appears.
2. Click "Sign in", complete the Google OAuth consent flow (including granting `drive.metadata.readonly`).
3. Confirm the pasted Doc's card updates to the real title without a page reload.
4. Paste a Sheet and a Slides URL; confirm both resolve to their real names.
5. Paste a Google Workspace URL you don't have access to (e.g., a doc ID that doesn't exist); confirm it falls back to `docs.google.com` with no error toast/crash.
6. Paste a mix of ~20 URLs (some Google Workspace, most not); confirm the non-Google tabs render immediately and only the Google Workspace ones update afterward.
7. Paste the same Google Doc URL twice in one batch; confirm (via Network tab) only one Drive API lookup occurs for that file id.

- [ ] **Step 6: Review the diff for scope creep**

Run: `git diff main --stat` (or the appropriate base branch)
Expected: every changed file traces back to a task in this plan. No incidental formatting, unrelated refactors, or unrelated UI changes.

---

## Manual Google Cloud / OAuth setup the user must complete

This cannot be done by the implementer — it requires access to a Google account and the Google Cloud Console:

1. Create (or reuse) a Google Cloud project.
2. Enable the **Google Drive API** for that project (APIs & Services → Library).
3. Configure the **OAuth consent screen**: add the `drive.metadata.readonly` scope; while unverified, add the Google accounts that will test sign-in as **Test users** (an unverified app is capped at 100 test users and shows an "unverified app" warning — full production use of this sensitive scope requires Google's app verification review).
4. Create an **OAuth 2.0 Client ID** (Web application). Add authorized redirect URIs:
   - `http://localhost:3000/api/auth/callback/google` (local dev)
   - `https://tabsdump.vercel.app/api/auth/callback/google` (production)
5. Set `GOOGLE_CLIENT_ID` / `GOOGLE_CLIENT_SECRET` in `.env.local` (local) and in the Vercel project's environment variables (production/preview).
6. Generate `AUTH_SECRET` (`npx auth secret` or `openssl rand -base64 33`) and set it the same way.
