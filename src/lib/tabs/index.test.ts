import { describe, expect, it } from "vitest";
import { parseTabInput } from "./index";

describe("parseTabInput", () => {
  it("parses and flags duplicates end-to-end, including tracking-param dupes", () => {
    const { tabs, invalidCount } = parseTabInput(
      "https://example.com/page?utm_source=test, https://example.com/page, not-a-url-!!, https://github.com/x"
    );
    expect(invalidCount).toBe(1);
    expect(tabs).toHaveLength(3);
    expect(tabs[0].isDuplicate).toBeFalsy();
    expect(tabs[1].isDuplicate).toBe(true);
    expect(tabs[2].isDuplicate).toBeFalsy();
  });
});
