import { describe, expect, it } from "vitest";
import { addDependency } from "./relations";
import { validateDependency } from "./validation";

describe("validateDependency", () => {
  it("rejects a self dependency", () => {
    expect(validateDependency([], "a", "a")).toEqual({ ok: false, reason: "self" });
  });

  it("rejects a duplicate of an existing dependency", () => {
    const deps = addDependency([], "a", "b");
    expect(validateDependency(deps, "a", "b")).toEqual({ ok: false, reason: "duplicate" });
  });

  it("allows the reverse direction of an existing dependency", () => {
    const deps = addDependency([], "a", "b");
    expect(validateDependency(deps, "b", "a")).toEqual({ ok: true });
  });

  it("allows a brand new pair", () => {
    expect(validateDependency([], "a", "b")).toEqual({ ok: true });
  });
});
