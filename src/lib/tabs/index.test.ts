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

  it("runs the full parse -> normalize -> dedupe -> categorize pipeline", () => {
    const { tabs, invalidCount } = parseTabInput(
      "https://github.com/a, https://arxiv.org/abs/1, not-a-url-!!, https://github.com/a"
    );
    expect(invalidCount).toBe(1);
    expect(tabs).toHaveLength(3);
    expect(tabs[0].category).toBe("projects");
    expect(tabs[1].category).toBe("research");
    expect(tabs[2].isDuplicate).toBe(true);
    expect(tabs[2].category).toBe("projects");
  });
});
