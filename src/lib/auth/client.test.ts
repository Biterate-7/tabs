import { afterEach, describe, expect, it, vi } from "vitest";

const isDesktopMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/platform/detect", () => ({ isDesktop: isDesktopMock }));

const { fetchAuthState } = await import("./client");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  isDesktopMock.mockReset();
  fetchMock.mockReset();
});

/**
 * The desktop app's signed-out-by-design behaviour, pinned here because it
 * is a security property rather than a convenience: a packaged build is
 * served from tauri://localhost, which has no session cookie and which
 * Google Identity Services will not accept as an authorized origin. The
 * answer is to not offer sign-in, NOT to relax the cookie's SameSite/origin
 * rules. See docs/desktop-architecture.md.
 */
describe("fetchAuthState on desktop", () => {
  it("reports signed-out and unconfigured without calling the API at all", async () => {
    isDesktopMock.mockReturnValue(true);

    const state = await fetchAuthState();

    expect(state).toEqual({ authenticated: false, user: null, configured: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("reports `configured: false`, which is what hides the sign-in UI entirely", async () => {
    isDesktopMock.mockReturnValue(true);
    const state = await fetchAuthState();
    // A truthy `configured` would render a Google button that cannot work.
    expect(state.configured).toBe(false);
  });
});

describe("fetchAuthState on the web", () => {
  it("still asks the server, so the deployed site is unchanged", async () => {
    isDesktopMock.mockReturnValue(false);
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ({ authenticated: true, user: { id: "u1" }, configured: true }),
    });

    const state = await fetchAuthState();

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("/api/auth/me");
    expect(state.authenticated).toBe(true);
  });

  it("falls back to the signed-out state when the check cannot complete", async () => {
    isDesktopMock.mockReturnValue(false);
    fetchMock.mockRejectedValue(new Error("offline"));

    expect(await fetchAuthState()).toEqual({
      authenticated: false,
      user: null,
      configured: false,
    });
  });
});
