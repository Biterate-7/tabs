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
