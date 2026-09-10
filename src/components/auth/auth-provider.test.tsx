import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { AuthProvider, useAuth } from "./auth-provider";
import { AccountSection } from "./account-section";
import { getStorageNamespace } from "@/lib/storage/namespace";

const CLIENT_ID = "1234567890-abcdef.apps.googleusercontent.com";

const ADA = {
  id: "11111111-1111-4111-8111-111111111111",
  email: "ada@example.com",
  name: "Ada Lovelace",
  avatarUrl: null,
};

let fetchMock: ReturnType<typeof vi.fn>;

/** Routes each auth endpoint to a canned response, so a test states only what it cares about. */
function mockAuthApi(handlers: Partial<Record<"me" | "logout" | "nonce" | "google", () => Response>>) {
  fetchMock.mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/api/auth/me")) {
      return handlers.me?.() ?? Response.json({ authenticated: false, user: null, configured: true });
    }
    if (url.includes("/api/auth/logout")) return handlers.logout?.() ?? Response.json({ ok: true });
    if (url.includes("/api/auth/nonce")) return handlers.nonce?.() ?? Response.json({ nonce: "n" });
    if (url.includes("/api/auth/google")) return handlers.google?.() ?? Response.json({ user: ADA, created: false });
    throw new Error(`unexpected fetch: ${url}`);
  });
}

/** Renders the current auth state as text, so assertions read as what a component would actually see. */
function AuthProbe() {
  const auth = useAuth()
  return (
    <div>
      <span data-testid="status">{auth.status}</span>
      <span data-testid="user">{auth.user?.email ?? "none"}</span>
      <span data-testid="namespace">{getStorageNamespace() ?? "anonymous"}</span>
    </div>
  )
}

beforeEach(() => {
  vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", CLIENT_ID);
  fetchMock = vi.fn();
  vi.stubGlobal("fetch", fetchMock);
  window.localStorage.clear();
});

afterEach(() => {
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  window.localStorage.clear();
});

describe("AuthProvider", () => {
  it("restores an existing session from the server on mount", async () => {
    mockAuthApi({ me: () => Response.json({ authenticated: true, user: ADA, configured: true }) });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
    expect(screen.getByTestId("user").textContent).toBe("ada@example.com");
  });

  it("asks the server rather than trusting anything remembered locally", async () => {
    // The point of Step 12: a previous render believing the user was signed
    // in counts for nothing, so /api/auth/me is always consulted.
    mockAuthApi({});

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("unauthenticated"));
    expect(fetchMock).toHaveBeenCalledWith("/api/auth/me", expect.objectContaining({ credentials: "same-origin" }));
  });

  it("renders nothing until the session check resolves", async () => {
    // Rendering the signed-out shell first would flash a sign-in prompt at
    // someone who is already signed in.
    mockAuthApi({ me: () => Response.json({ authenticated: true, user: ADA, configured: true }) });

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    expect(screen.queryByTestId("status")).toBeNull();
    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));
  });

  it("makes no auth request at all when the deployment has no client ID", async () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "");
    mockAuthApi({});

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    // TabDump behaves exactly as it did before accounts existed.
    expect(screen.getByTestId("status").textContent).toBe("unauthenticated");
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a failed session check as signed out rather than hanging on loading", async () => {
    fetchMock.mockRejectedValue(new Error("offline"));

    render(
      <AuthProvider>
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("unauthenticated"));
  });

  it("points local storage at the signed-in account, and back to anonymous after signing out", async () => {
    mockAuthApi({ me: () => Response.json({ authenticated: true, user: ADA, configured: true }) });

    render(
      <AuthProvider>
        <AccountSection showLabels />
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("namespace").textContent).toBe(ADA.id));

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Sign out/ }));

    await waitFor(() => expect(screen.getByTestId("namespace").textContent).toBe("anonymous"));
  });

  it("keeps the user signed in when the sign-out request fails", async () => {
    // Clearing local state over a session that is still live server-side is
    // the half-logout this avoids.
    mockAuthApi({
      me: () => Response.json({ authenticated: true, user: ADA, configured: true }),
      logout: () => Response.json({ error: "Couldn't sign you out." }, { status: 500 }),
    });

    render(
      <AuthProvider>
        <AccountSection showLabels />
        <AuthProbe />
      </AuthProvider>
    );

    await waitFor(() => expect(screen.getByTestId("status").textContent).toBe("authenticated"));

    await userEvent.click(screen.getByRole("button", { name: "Account" }));
    await userEvent.click(await screen.findByRole("menuitem", { name: /Sign out/ }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith("/api/auth/logout", expect.anything()));
    expect(screen.getByTestId("status").textContent).toBe("authenticated");
    expect(screen.getByTestId("namespace").textContent).toBe(ADA.id);
  });
});

describe("AccountSection", () => {
  it("offers sign-in when signed out", async () => {
    mockAuthApi({});

    render(
      <AuthProvider>
        <AccountSection showLabels />
      </AuthProvider>
    );

    expect(await screen.findByRole("button", { name: "Sign in to TabDump" })).toBeTruthy();
  });

  it("shows the signed-in account, with the Google-provided name and email", async () => {
    mockAuthApi({ me: () => Response.json({ authenticated: true, user: ADA, configured: true }) });

    render(
      <AuthProvider>
        <AccountSection showLabels />
      </AuthProvider>
    );

    const trigger = await screen.findByRole("button", { name: "Account" });
    await userEvent.click(trigger);

    expect(await screen.findByText("ada@example.com")).toBeTruthy();
    expect(screen.getAllByText("Ada Lovelace").length).toBeGreaterThan(0);
  });

  it("renders nothing on a deployment without accounts", () => {
    vi.stubEnv("NEXT_PUBLIC_GOOGLE_CLIENT_ID", "");
    mockAuthApi({});

    const { container } = render(
      <AuthProvider>
        <AccountSection showLabels />
      </AuthProvider>
    )

    expect(container.querySelector("button")).toBeNull();
  });

  it("renders nothing outside an AuthProvider, rather than throwing", () => {
    // The sidebar's own unit tests mount it with no provider.
    const { container } = render(<AccountSection showLabels />);
    expect(container.querySelector("button")).toBeNull();
  });
});
