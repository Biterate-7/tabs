import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { shouldPlayIntro, prefersReducedMotion, isMobileViewport } from "./intro";
import { getSettings, DEFAULT_SOUND, type Settings } from "./settings";
import { DEFAULT_APPEARANCE_SETTINGS } from "./appearance/defaults";

vi.mock("./settings", async (importOriginal) => ({
  ...(await importOriginal<typeof import("./settings")>()),
  getSettings: vi.fn(),
}));

function settingsWith(playIntro: boolean): Settings {
  return { playIntro, sound: DEFAULT_SOUND, ...DEFAULT_APPEARANCE_SETTINGS };
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("shouldPlayIntro", () => {
  it("plays when the setting is on", () => {
    vi.mocked(getSettings).mockReturnValue(settingsWith(true));
    expect(shouldPlayIntro()).toBe(true);
  });

  it("does not play when the setting is off", () => {
    vi.mocked(getSettings).mockReturnValue(settingsWith(false));
    expect(shouldPlayIntro()).toBe(false);
  });

  it("has no memory of a previous call — every call re-reads the setting fresh", () => {
    vi.mocked(getSettings).mockReturnValue(settingsWith(true));
    expect(shouldPlayIntro()).toBe(true);
    expect(shouldPlayIntro()).toBe(true);
    expect(shouldPlayIntro()).toBe(true);
    // Three "loads" in a row, all playing — nothing here ever flips it off,
    // because shouldPlayIntro itself never writes anything.
    expect(getSettings).toHaveBeenCalledTimes(3);
  });
});

describe("prefersReducedMotion", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("reflects the media query", () => {
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    expect(prefersReducedMotion()).toBe(true);
  });

  it("defaults to false when matchMedia is unavailable", () => {
    vi.stubGlobal("matchMedia", undefined);
    expect(prefersReducedMotion()).toBe(false);
  });
});

describe("isMobileViewport", () => {
  const originalWidth = window.innerWidth;
  afterEach(() => {
    Object.defineProperty(window, "innerWidth", { value: originalWidth, writable: true, configurable: true });
  });

  it("is true under 640px", () => {
    Object.defineProperty(window, "innerWidth", { value: 375, writable: true, configurable: true });
    expect(isMobileViewport()).toBe(true);
  });

  it("is false at desktop widths", () => {
    Object.defineProperty(window, "innerWidth", { value: 1280, writable: true, configurable: true });
    expect(isMobileViewport()).toBe(false);
  });

  it("treats a 0px width as unknown, not mobile", () => {
    Object.defineProperty(window, "innerWidth", { value: 0, writable: true, configurable: true });
    expect(isMobileViewport()).toBe(false);
  });
});
