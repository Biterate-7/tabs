import { afterEach, describe, expect, it, vi } from "vitest";

const isDesktopMock = vi.hoisted(() => vi.fn());
vi.mock("@/lib/platform/detect", () => ({ isDesktop: isDesktopMock }));
const invokeMock = vi.hoisted(() => vi.fn());
vi.mock("@tauri-apps/api/core", () => ({ invoke: invokeMock }));

const { fetchAuthState, signOutRequest } = await import("./client");

const fetchMock = vi.fn();
vi.stubGlobal("fetch", fetchMock);

afterEach(() => {
  isDesktopMock.mockReset();
  fetchMock.mockReset();
  invokeMock.mockReset();
});

/**
 * Hubble Desktop has no session cookie (its pages are served from
 * tauri://localhost, which Google Identity Services won't accept either). Its
 * account comes from the device token Rust holds (src-tauri/src/account.rs),
 * so the answer is asked of Rust — never of the cookie API, and never by
 * relaxing the cookie's SameSite/origin rules. See docs/auth-architecture.md.
 */
describe("fetchAuthState on desktop", () => {
  const user = { id: "u1", email: "a@example.com", name: "A", avatarUrl: null };

  it("asks the app, not the cookie API, and offers sign-in when signed out", async () => {
    isDesktopMock.mockReturnValue(true);
    invokeMock.mockResolvedValue({ state: "signed-out", user: null, origin: "https://hubble.example" });
    expect(await fetchAuthState()).toEqual({ authenticated: false, user: null, configured: true });
    expect(invokeMock).toHaveBeenCalledWith("account_status", {});
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("is signed in when the app's token resolves, and stays signed in offline", async () => {
    isDesktopMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({ state: "signed-in", user, origin: "x" }).mockResolvedValueOnce({ state: "offline", user, origin: "x" });
    expect(await fetchAuthState()).toEqual({ authenticated: true, user, configured: true });
    expect(await fetchAuthState()).toEqual({ authenticated: true, user, configured: true });
  });

  it("is signed out when the token was refused, or the app can't answer", async () => {
    isDesktopMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce({ state: "expired", user: null, origin: "x" }).mockRejectedValueOnce("command not found");
    expect(await fetchAuthState()).toMatchObject({ authenticated: false, user: null });
    expect(await fetchAuthState()).toMatchObject({ authenticated: false, user: null });
  });

  it("signs out through the app, and reports a failure the app gave", async () => {
    isDesktopMock.mockReturnValue(true);
    invokeMock.mockResolvedValueOnce(undefined).mockRejectedValueOnce("Couldn't reach Hubble to sign you out.");
    expect(await signOutRequest()).toEqual({ ok: true });
    expect(invokeMock).toHaveBeenLastCalledWith("account_sign_out", {});
    expect(await signOutRequest()).toEqual({ ok: false, error: { message: "Couldn't reach Hubble to sign you out.", status: 0 } });
    expect(fetchMock).not.toHaveBeenCalled();
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
