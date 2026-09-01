import { describe, expect, it } from "vitest";
import { findSimilarSibling } from "./normalize";

describe("findSimilarSibling", () => {
  it("returns null when there are no siblings", () => {
    expect(findSimilarSibling([], "Physics")).toBeNull();
  });

  it("finds an exact case-insensitive match", () => {
    expect(findSimilarSibling(["Physics", "Economics"], "physics")).toBe("Physics");
  });

  it("collapses a redundant-suffix variant onto the existing name", () => {
    expect(findSimilarSibling(["Physics"], "Physics Research")).toBe("Physics");
    expect(findSimilarSibling(["Physics"], "Physics Resources")).toBe("Physics");
  });

  it("resolves known synonyms to the same section", () => {
    expect(findSimilarSibling(["University"], "College")).toBe("University");
    expect(findSimilarSibling(["Machine Learning"], "ML")).toBe("Machine Learning");
  });

  it("does not match clearly unrelated names", () => {
    expect(findSimilarSibling(["Physics", "Shopping"], "Economics")).toBeNull();
  });

  it("returns null for a blank candidate", () => {
    expect(findSimilarSibling(["Physics"], "   ")).toBeNull();
  });
});
