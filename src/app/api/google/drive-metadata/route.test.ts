import { describe, expect, it, vi, beforeEach } from "vitest";
import { POST } from "./route";

const getTokenMock = vi.fn();
const fetchDriveFileMetadataMock = vi.fn();

vi.mock("next-auth/jwt", () => ({
  getToken: (...args: unknown[]) => getTokenMock(...args),
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
  getTokenMock.mockReset();
  fetchDriveFileMetadataMock.mockReset();
});

describe("POST /api/google/drive-metadata", () => {
  it("returns authenticated:false and no results when there is no session", async () => {
    getTokenMock.mockResolvedValue(null);

    const res = await POST(postRequest({ fileIds: ["a"] }));
    const data = await res.json();

    expect(res.status).toBe(200);
    expect(data).toEqual({ authenticated: false, results: {} });
    expect(fetchDriveFileMetadataMock).not.toHaveBeenCalled();
  });

  it("returns authenticated:false when the token carries a refresh error", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "stale", error: "RefreshAccessTokenError" });

    const res = await POST(postRequest({ fileIds: ["a"] }));
    const data = await res.json();

    expect(data.authenticated).toBe(false);
    expect(fetchDriveFileMetadataMock).not.toHaveBeenCalled();
  });

  it("resolves metadata for each requested file id when authenticated", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-123" });
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
    getTokenMock.mockResolvedValue({ accessToken: "token-123" });
    fetchDriveFileMetadataMock.mockResolvedValue({ name: "Doc", mimeType: "doc" });

    const res = await POST(postRequest({ fileIds: ["dup", "dup", "dup"] }));
    const data = await res.json();

    expect(fetchDriveFileMetadataMock).toHaveBeenCalledTimes(1);
    expect(data.results).toEqual({ dup: { name: "Doc", mimeType: "doc" } });
  });

  it("returns 400 for a malformed body without crashing", async () => {
    getTokenMock.mockResolvedValue({ accessToken: "token-123" });

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
    getTokenMock.mockResolvedValue({ accessToken: "token-123" });
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
