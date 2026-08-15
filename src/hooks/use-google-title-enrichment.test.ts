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

  it("retries a fileId after the effect is cancelled before the fetch resolves (bug 1 regression)", async () => {
    useSessionMock.mockReturnValue({ status: "authenticated" });

    let releaseFirstFetch: ((value: unknown) => void) | undefined;
    const firstFetch = new Promise((resolve) => {
      releaseFirstFetch = resolve;
    });
    resolveGoogleFileTitlesMock.mockReturnValueOnce(firstFetch);
    resolveGoogleFileTitlesMock.mockResolvedValueOnce({
      authenticated: true,
      metadataByFileId: new Map([["abc", { name: "Resolved On Retry", mimeType: "doc" }]]),
    });

    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];
    const onResolved = vi.fn();

    const { rerender } = renderHook(({ t, cb }) => useGoogleTitleEnrichment(t, cb), {
      initialProps: { t: tabs, cb: onResolved },
    });

    // First effect run fires the fetch and marks "abc" as attempted, but the
    // promise is left pending so we can cancel the effect before it settles.
    await waitFor(() => expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(1));

    // Rerender with a new `tabs` array reference and a new `onResolved` closure
    // so the effect's cleanup runs (cancelling the in-flight request) before
    // the first fetch has resolved.
    const onResolvedAfterRetry = vi.fn();
    rerender({ t: [...tabs], cb: onResolvedAfterRetry });

    // Settle the now-cancelled first fetch late. Its result must be ignored.
    releaseFirstFetch?.({
      authenticated: true,
      metadataByFileId: new Map([["abc", { name: "Stale Result", mimeType: "doc" }]]),
    });
    await new Promise((r) => setTimeout(r, 0));

    // Without the fix, "abc" stays permanently in attemptedFileIds after the
    // cancelled effect, so the second effect run would see no pending
    // candidates and never call the resolver again. With the fix, cleanup
    // un-marks "abc" so the fresh effect run retries it.
    await waitFor(() => expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(2));
    expect(resolveGoogleFileTitlesMock).toHaveBeenLastCalledWith(["abc"]);

    await waitFor(() =>
      expect(onResolvedAfterRetry).toHaveBeenCalledWith([{ id: "1", title: "Resolved On Retry" }])
    );
    expect(onResolved).not.toHaveBeenCalled();
  });

  it("clears a stale needsSignIn after re-authentication once all candidates were already attempted (bug 2 regression)", async () => {
    const tabs = [makeTab({ id: "1", url: "https://docs.google.com/document/d/abc/edit" })];
    const onResolved = vi.fn();

    // Pass 1: authenticated, resolver resolves "abc" to null, so it becomes
    // permanently attempted (a `null` result is never un-marked).
    useSessionMock.mockReturnValue({ status: "authenticated" });
    resolveGoogleFileTitlesMock.mockResolvedValueOnce({
      authenticated: true,
      metadataByFileId: new Map([["abc", null]]),
    });

    const { result, rerender } = renderHook(() => useGoogleTitleEnrichment(tabs, onResolved));

    await waitFor(() => expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(1));

    // Pass 2: session drops to unauthenticated with the same unresolved
    // candidate still present, so needsSignIn flips true.
    useSessionMock.mockReturnValue({ status: "unauthenticated" });
    rerender();

    await waitFor(() => expect(result.current.needsSignIn).toBe(true));

    // Pass 3: re-authenticate. "abc" is already in attemptedFileIds from pass
    // 1, so `pending` is empty on this run. Without the fix, the effect
    // returns early and needsSignIn stays stuck at true; with the fix it is
    // explicitly cleared.
    useSessionMock.mockReturnValue({ status: "authenticated" });
    rerender();

    await waitFor(() => expect(result.current.needsSignIn).toBe(false));
    expect(resolveGoogleFileTitlesMock).toHaveBeenCalledTimes(1);
  });

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
});
