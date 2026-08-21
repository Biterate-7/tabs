import { describe, expect, it, afterEach, vi } from "vitest";
import { getExtensionInstallInfo, EXTENSION_DOWNLOAD_URL } from "./extension-config";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getExtensionInstallInfo", () => {
  it("defaults to download mode when no store URL is configured", () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_STORE_URL", "");
    expect(getExtensionInstallInfo()).toEqual({ mode: "download" });
  });

  it("returns download mode in development too, since the ZIP works there as well", () => {
    vi.stubEnv("NODE_ENV", "development");
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_STORE_URL", "");
    expect(getExtensionInstallInfo()).toEqual({ mode: "download" });
  });

  it("returns the real store URL once configured", () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_STORE_URL", "https://chromewebstore.google.com/detail/real-listing");
    expect(getExtensionInstallInfo()).toEqual({
      mode: "store",
      url: "https://chromewebstore.google.com/detail/real-listing",
    });
  });

  it("never fabricates a Chrome Web Store URL that wasn't configured", () => {
    vi.stubEnv("NEXT_PUBLIC_EXTENSION_STORE_URL", "");
    expect(getExtensionInstallInfo()).not.toHaveProperty("url");
  });
});

describe("EXTENSION_DOWNLOAD_URL", () => {
  it("is a site-root-relative path (no hardcoded domain, works on any origin)", () => {
    expect(EXTENSION_DOWNLOAD_URL).toBe("/tabdump-extension.zip");
    expect(EXTENSION_DOWNLOAD_URL.startsWith("http")).toBe(false);
  });
});
