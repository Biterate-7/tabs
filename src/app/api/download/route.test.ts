// @vitest-environment node
import { describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));
vi.mock("@/lib/downloads/counter-server", () => ({ getDownloadCounter: vi.fn(async () => undefined) }));

import { DESKTOP_BUILDS, downloadUrl } from "@/lib/desktop/release";
import { GET, HEAD } from "./route";

const CHROME = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36";
const req = (query: string, method = "GET") =>
  new Request(`https://hubble-hq.vercel.app/api/download${query}`, { method, headers: { "user-agent": CHROME } });

describe("/api/download", () => {
  it("serves the shipped release state: Windows redirects only once release.ts marks it published", async () => {
    for (const handler of [GET, HEAD]) {
      const response = await handler(req("?platform=windows", handler === GET ? "GET" : "HEAD"));
      if (DESKTOP_BUILDS.windows.status === "published") {
        expect(response.status).toBe(302);
        expect(response.headers.get("location")).toBe(downloadUrl("windows"));
      } else {
        expect(response.status).toBe(404);
        expect(response.headers.get("location")).toBeNull();
      }
    }
  });

  it("refuses an unknown platform and any destination parameter", async () => {
    expect((await GET(req("?platform=banana"))).status).toBe(400);
    const open = await GET(req("?platform=windows&url=https://evil.example"));
    expect(open.status).toBe(400);
    expect(open.headers.get("location")).toBeNull();
  });
});
