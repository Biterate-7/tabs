import { describe, expect, it, beforeEach } from "vitest";
import { getSettings, setPlayIntro } from "./settings";

const STORAGE_KEY = "tabdump:settings:v1";

beforeEach(() => {
  window.localStorage.clear();
});

describe("settings", () => {
  it("defaults playIntro to true when no preference has ever been saved", () => {
    expect(getSettings().playIntro).toBe(true);
  });

  it("persists an explicit disable across separate reads", () => {
    setPlayIntro(false);
    expect(getSettings().playIntro).toBe(false);
    // A second, independent read (simulating a later reload) sees the same
    // persisted value — this is what "survives a refresh" means in practice.
    expect(getSettings().playIntro).toBe(false);
  });

  it("persists an explicit enable after a prior disable", () => {
    setPlayIntro(false);
    setPlayIntro(true);
    expect(getSettings().playIntro).toBe(true);
  });

  it("uses a dedicated versioned key, not bundled into unrelated app state", () => {
    setPlayIntro(false);
    const raw = window.localStorage.getItem(STORAGE_KEY);
    expect(raw).not.toBeNull();
    // Only asserts the one field this test owns — the object also carries
    // the appearance system's settings (theme, typography, …), which have
    // their own dedicated coverage in appearance/*.test.ts.
    expect(JSON.parse(raw as string)).toMatchObject({ playIntro: false });
  });

  it("ignores the old first-visit 'seen' key entirely — it never implies the new setting is off", () => {
    window.localStorage.setItem("tabdump:intro-seen:v1", "1");
    expect(getSettings().playIntro).toBe(true);
  });

  it("falls back to the default when storage is unavailable", () => {
    const original = window.localStorage.setItem;
    window.localStorage.setItem = () => {
      throw new Error("storage unavailable");
    };
    expect(getSettings().playIntro).toBe(true);
    window.localStorage.setItem = original;
  });

  it("falls back to the default when the stored value is malformed", () => {
    window.localStorage.setItem(STORAGE_KEY, "not json");
    expect(getSettings().playIntro).toBe(true);
  });
});
