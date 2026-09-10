import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import { AuthProvider } from "./auth-provider";
import { SignInDialog } from "./sign-in-dialog";

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";

let fetchMock: ReturnType<typeof vi.fn>;

/**
 * Stands in for the Google Identity Services script, which the loader finds
 * already present on `window` and so never fetches.
 *
 * Defined once for the whole file rather than per test, because loadGsi()
 * caches its resolved API for the lifetime of the page — a fresh object per
 * test would leave every test after the first asserting against a stale
 * one. The mocks are cleared between tests instead.
 */
const initialize = vi.fn();
const renderButton = vi.fn();
const fakeGsi = { accounts: { id: { initialize, renderButton, disableAutoSelect: vi.fn() } } };

function calledPaths(): string[] {
  return fetchMock.mock.calls.map(([input]) => String(input));
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", CLIENT_ID);
  initialize.mockClear();
  renderButton.mockClear();

  fetchMock = vi.fn(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) return Response.json({ authenticated: false, user: null, configured: true });
    if (url.includes("/api/auth/nonce")) return Response.json({ nonce: "nonce-value" });
    throw new Error(`unexpected fetch: ${url}`);
  });
  vi.stubGlobal("fetch", fetchMock);
  vi.stubGlobal("google", fakeGsi);
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
});

describe("SignInDialog", () => {
  it("costs nothing while closed — no nonce issued, no Google script touched", async () => {
    // A nonce cookie set on every page load would be pure waste, and would
    // mean a sign-in nobody started.
    render(
      <AuthProvider>
        <SignInDialog open={false} onOpenChange={() => {}} />
      </AuthProvider>
    );

    await waitFor(() => expect(calledPaths()).toContain("/api/auth/me"));

    expect(calledPaths().some((path) => path.includes("/api/auth/nonce"))).toBe(false);
    expect(initialize).not.toHaveBeenCalled();
  });

  it("is TabDump-branded, with no third-party auth provider named", async () => {
    render(
      <AuthProvider>
        <SignInDialog open onOpenChange={() => {}} />
      </AuthProvider>
    );

    expect(await screen.findByText("Sign in to TabDump")).toBeTruthy();

    // Google appears only as the identity provider's own button (rendered
    // by GIS itself, so it contributes no text here). Nothing in TabDump's
    // own copy names an authentication platform.
    const text = document.body.textContent ?? "";
    for (const vendor of ["Clerk", "Auth0", "Supabase", "Firebase", "Powered by"]) {
      expect(text).not.toContain(vendor);
    }
  });

  it("asks for a fresh nonce and hands it to Google when opened", async () => {
    render(
      <AuthProvider>
        <SignInDialog open onOpenChange={() => {}} />
      </AuthProvider>
    );

    await waitFor(() => expect(initialize).toHaveBeenCalled());

    const options = initialize.mock.calls[0][0];
    expect(options.client_id).toBe(CLIENT_ID);
    // The nonce is what binds the credential Google returns to this browser
    // and this attempt.
    expect(options.nonce).toBe("nonce-value");
    // Never sign someone in without them asking.
    expect(options.auto_select).toBe(false);
    expect(renderButton).toHaveBeenCalled();
  });

  it("surfaces a friendly error, and a retry, when the nonce request fails", async () => {
    fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.includes("/api/auth/me")) return Response.json({ authenticated: false, user: null, configured: true });
      return Response.json({ error: "Too many sign-in attempts — try again shortly." }, { status: 429 });
    });

    render(
      <AuthProvider>
        <SignInDialog open onOpenChange={() => {}} />
      </AuthProvider>
    );

    expect(await screen.findByRole("alert")).toBeTruthy();
    expect(screen.getByText("Too many sign-in attempts — try again shortly.")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Try again" })).toBeTruthy();
    expect(initialize).not.toHaveBeenCalled();
  });
});
