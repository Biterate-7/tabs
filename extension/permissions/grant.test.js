// The permission window: it names the app, asks Chrome for exactly that
// app's origins on the person's click, and tells the background the answer.
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { initGrant } from "./grant.js";
import { MSG_AI_PERMISSION_ANSWER } from "../src/ai-transfer.js";

const here = path.dirname(fileURLToPath(import.meta.url));

beforeEach(() => {
  document.body.innerHTML = readFileSync(path.join(here, "grant.html"), "utf8").replace(/^[\s\S]*<body[^>]*>/, "").replace(/<\/body>[\s\S]*$/, "");
  globalThis.chrome = { permissions: { request: vi.fn(async () => true) }, runtime: { sendMessage: vi.fn(async () => ({ ok: true })) } };
  vi.spyOn(window, "close").mockImplementation(() => {});
});

afterEach(() => {
  delete globalThis.chrome;
  vi.restoreAllMocks();
});

describe("grant window", () => {
  it("names the app and asks for only its origins when Allow is clicked", async () => {
    initGrant(document, "?provider=chatgpt&op=op_0123456789");
    expect(document.getElementById("grant-heading").textContent).toBe("Let Hubble use ChatGPT?");
    expect(document.getElementById("grant-why").textContent).toContain("chatgpt.com and chat.openai.com");
    document.getElementById("grant-allow").click();
    await vi.waitFor(() => expect(window.close).toHaveBeenCalled());
    expect(chrome.permissions.request).toHaveBeenCalledWith({ origins: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG_AI_PERMISSION_ANSWER, payload: { opId: "op_0123456789", provider: "chatgpt", granted: true } });
  });

  it("stays open and says so when Chrome's prompt is declined", async () => {
    chrome.permissions.request.mockResolvedValue(false);
    initGrant(document, "?provider=perplexity&op=op_0123456789");
    document.getElementById("grant-allow").click();
    await vi.waitFor(() => expect(document.getElementById("grant-status").hidden).toBe(false));
    expect(window.close).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).not.toHaveBeenCalled();
  });

  it("answers no on Not now", async () => {
    initGrant(document, "?provider=gemini&op=op_0123456789");
    document.getElementById("grant-cancel").click();
    await vi.waitFor(() => expect(window.close).toHaveBeenCalled());
    expect(chrome.permissions.request).not.toHaveBeenCalled();
    expect(chrome.runtime.sendMessage).toHaveBeenCalledWith({ type: MSG_AI_PERMISSION_ANSWER, payload: { opId: "op_0123456789", provider: "gemini", granted: false } });
  });

  it("offers nothing to allow for an app it doesn't know", () => {
    initGrant(document, "?provider=__proto__&op=x");
    expect(document.getElementById("grant-allow").hidden).toBe(true);
    expect(document.getElementById("grant-heading").textContent).toBe("Nothing to allow");
  });
});
