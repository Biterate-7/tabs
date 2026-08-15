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

    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
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
