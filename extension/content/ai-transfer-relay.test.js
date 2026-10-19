// Use in AI's relay in the content script, against jsdom's real window and
// postMessage with only chrome.* stubbed: the hello is answered on the spot,
// a transfer goes to the background and its answer comes back under the same
// opId, progress reaches the page, and nothing from another window counts.
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

const SOURCE = "tabdump-extension";
let extensionListeners = [];
let sendMessage;

beforeAll(async () => {
  delete window.__tabdumpBridgeRegistered;
  sendMessage = vi.fn();
  globalThis.chrome = { runtime: { onMessage: { addListener: (fn) => extensionListeners.push(fn) }, sendMessage: (...args) => sendMessage(...args) } };
  await import("./content-script.js");
});

afterAll(() => {
  delete globalThis.chrome;
});

beforeEach(() => {
  sendMessage = vi.fn();
});

/** Posts as the page does, and collects what the content script posts back of `type`. */
function pageSays(type, payload, wanted) {
  return new Promise((resolve) => {
    const onMessage = (event) => {
      if (event.data?.source !== SOURCE || event.data.type !== wanted) return;
      window.removeEventListener("message", onMessage);
      resolve(event.data.payload);
    };
    window.addEventListener("message", onMessage);
    window.postMessage({ source: SOURCE, type, payload }, window.location.origin);
  });
}

describe("Use in AI relay", () => {
  it("answers the hello itself with its protocol version", async () => {
    expect(await pageSays("HUBBLE_AI_TRANSFER_HELLO", { requestId: "r1" }, "HUBBLE_AI_TRANSFER_HELLO_RESULT")).toEqual({ requestId: "r1", protocol: 1 });
    expect(sendMessage).not.toHaveBeenCalled();
  });

  it("hands a transfer to the background and posts its answer back under the same opId", async () => {
    sendMessage.mockResolvedValue({ opId: "op_0123456789", ok: true, state: "ready-for-review", attached: [], notAttached: [], usedFallback: false, reusedTab: false });
    const payload = { opId: "op_0123456789", provider: "claude", mode: "prepare", text: "Hi", files: [] };
    const result = await pageSays("HUBBLE_AI_TRANSFER", payload, "HUBBLE_AI_TRANSFER_RESULT");
    expect(sendMessage).toHaveBeenCalledWith({ type: "HUBBLE_AI_TRANSFER", payload });
    expect(result).toMatchObject({ opId: "op_0123456789", ok: true, state: "ready-for-review" });
  });

  it("says the transfer was interrupted when the background never answers", async () => {
    sendMessage.mockRejectedValue(new Error("The message port closed before a response was received."));
    expect(await pageSays("HUBBLE_AI_TRANSFER", { opId: "op_abcdefgh12" }, "HUBBLE_AI_TRANSFER_RESULT")).toEqual({ opId: "op_abcdefgh12", ok: false, error: "interrupted" });
    sendMessage.mockResolvedValue(undefined);
    expect(await pageSays("HUBBLE_AI_TRANSFER", { opId: "op_abcdefgh13" }, "HUBBLE_AI_TRANSFER_RESULT")).toEqual({ opId: "op_abcdefgh13", ok: false, error: "interrupted" });
  });

  it("passes the background's progress to the page", async () => {
    const heard = new Promise((resolve) => {
      const onMessage = (event) => {
        if (event.data?.type !== "HUBBLE_AI_TRANSFER_PROGRESS") return;
        window.removeEventListener("message", onMessage);
        resolve(event.data.payload);
      };
      window.addEventListener("message", onMessage);
    });
    for (const listener of extensionListeners) listener({ type: "HUBBLE_AI_TRANSFER_PROGRESS", payload: { opId: "op_0123456789", state: "attaching", extra: "dropped" } }, {}, () => {});
    expect(await heard).toEqual({ opId: "op_0123456789", state: "attaching" });
  });

  it("ignores a transfer posted by another window", async () => {
    const frame = document.createElement("iframe");
    document.body.append(frame);
    window.dispatchEvent(new MessageEvent("message", { data: { source: SOURCE, type: "HUBBLE_AI_TRANSFER", payload: { opId: "op_fromframe1" } }, origin: window.location.origin, source: frame.contentWindow }));
    window.dispatchEvent(new MessageEvent("message", { data: { source: SOURCE, type: "HUBBLE_AI_TRANSFER", payload: { opId: "op_fromelsewhere" } }, origin: "https://evil.example", source: window }));
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(sendMessage).not.toHaveBeenCalled();
  });
});
