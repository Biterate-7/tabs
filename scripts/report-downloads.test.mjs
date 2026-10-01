// @vitest-environment node
import { describe, expect, it } from "vitest";
import { summarise } from "./report-downloads.mjs";

describe("downloads:report", () => {
  it("totals by platform, version and day", () => {
    expect(
      summarise([
        { day: "2026-10-01", platform: "windows", version: "0.1.0", downloads: 3 },
        { day: "2026-10-02", platform: "windows", version: "0.1.0", downloads: 2 },
        { day: "2026-10-02", platform: "windows", version: "0.2.0", downloads: 1 },
      ])
    ).toEqual({
      total: 6,
      byPlatform: { windows: 6 },
      byVersion: { "0.1.0": 5, "0.2.0": 1 },
      byDay: { "2026-10-01": 3, "2026-10-02": 3 },
    });
    expect(summarise([])).toMatchObject({ total: 0 });
  });
});
