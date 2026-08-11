import { describe, expect, it } from "vitest";
import { CATEGORIES, CATEGORY_ORDER } from "./definitions";

describe("CATEGORIES", () => {
  it("defines exactly the 8 required categories in order", () => {
    expect(CATEGORY_ORDER).toEqual([
      "research",
      "school",
      "projects",
      "shopping",
      "creative",
      "news",
      "read-later",
      "other",
    ]);
  });

  it("gives every category an id, name, icon, description, and accent color", () => {
    for (const id of CATEGORY_ORDER) {
      const def = CATEGORIES[id];
      expect(def.id).toBe(id);
      expect(def.name.length).toBeGreaterThan(0);
      expect(def.icon).toBeTruthy();
      expect(def.description.length).toBeGreaterThan(0);
      expect(def.accentColor.length).toBeGreaterThan(0);
    }
  });
});
