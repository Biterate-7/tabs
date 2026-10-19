import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import * as extension from "../../../extension/src/ai-transfer.js";
import { AI_PROVIDER_IDS, AI_PROVIDERS, isNewChatUrl } from "@/lib/providers/registry";
import {
  AI_TRANSFER_PROTOCOL,
  AI_TRANSFER_WIRE_LIMITS,
  base64Bytes,
  checkTransferRequest,
  errorWords,
  isOpId,
  MSG_AI_TRANSFER,
  MSG_AI_TRANSFER_HELLO,
  MSG_AI_TRANSFER_HELLO_RESULT,
  MSG_AI_TRANSFER_PROGRESS,
  MSG_AI_TRANSFER_RESULT,
  newOpId,
  readTransferProgress,
  readTransferResult,
  stateWords,
  TRANSFER_ERRORS,
} from "./protocol";

/**
 * The page and the extension speak one protocol from two copies (the
 * extension has no build step). These tests hold the copies together, and
 * check that what the page accepts from the extension can only ever be a
 * success it reported in full, or a named failure.
 */

const pdf = Buffer.from("%PDF-1.4 tiny").toString("base64");

function request(patch: Record<string, unknown> = {}) {
  return { opId: "op_0123456789abcdef", provider: "claude", mode: "prepare", text: "Summarize this.", files: [{ name: "a.pdf", type: "application/pdf", size: 13, data: pdf }], ...patch };
}

describe("parity with the extension", () => {
  it("uses the same message names, protocol version and limits", () => {
    expect([extension.MSG_AI_TRANSFER, extension.MSG_AI_TRANSFER_PROGRESS, extension.MSG_AI_TRANSFER_RESULT, extension.MSG_AI_TRANSFER_HELLO, extension.MSG_AI_TRANSFER_HELLO_RESULT]).toEqual([
      MSG_AI_TRANSFER,
      MSG_AI_TRANSFER_PROGRESS,
      MSG_AI_TRANSFER_RESULT,
      MSG_AI_TRANSFER_HELLO,
      MSG_AI_TRANSFER_HELLO_RESULT,
    ]);
    expect(extension.AI_TRANSFER_PROTOCOL).toBe(AI_TRANSFER_PROTOCOL);
    expect(extension.AI_TRANSFER_LIMITS).toEqual({ ...AI_TRANSFER_WIRE_LIMITS });
  });

  it("knows the same AI apps: hosts, new-chat page and where a new chat starts", () => {
    expect(Object.keys(extension.TRANSFER_PROVIDERS).sort()).toEqual([...AI_PROVIDER_IDS].sort());
    for (const id of AI_PROVIDER_IDS) {
      const theirs = extension.TRANSFER_PROVIDERS[id];
      expect(theirs.hosts, id).toEqual(AI_PROVIDERS[id].hosts);
      expect(theirs.homeUrl, id).toBe(AI_PROVIDERS[id].homeUrl);
      expect(theirs.origins, id).toEqual(AI_PROVIDERS[id].hosts.map((host) => `https://${host}/*`));
      expect(theirs.submit, id).toBe(AI_PROVIDERS[id].capabilities.autoSubmit.supported);
      for (const url of [AI_PROVIDERS[id].homeUrl, `${AI_PROVIDERS[id].homeUrl}x/abc`, "https://example.com/"]) {
        expect(extension.isNewChatTab(id, url), `${id} ${url}`).toBe(isNewChatUrl(id, url));
      }
    }
  });

  it("asks only for the AI apps' own origins, as optional permissions", () => {
    const manifest = JSON.parse(readFileSync(path.resolve(__dirname, "../../../extension/manifest.json"), "utf8"));
    const wanted = Object.values(extension.TRANSFER_PROVIDERS).flatMap((provider) => provider.origins);
    expect([...manifest.optional_host_permissions].sort()).toEqual([...wanted].sort());
    for (const origin of wanted) expect(manifest.host_permissions).not.toContain(origin);
  });

  it("the content script relays the same message names", () => {
    const script = readFileSync(path.resolve(__dirname, "../../../extension/content/content-script.js"), "utf8");
    for (const name of [MSG_AI_TRANSFER, MSG_AI_TRANSFER_PROGRESS, MSG_AI_TRANSFER_RESULT, MSG_AI_TRANSFER_HELLO, MSG_AI_TRANSFER_HELLO_RESULT]) expect(script).toContain(`"${name}"`);
    expect(script).toContain(`const AI_TRANSFER_PROTOCOL = ${AI_TRANSFER_PROTOCOL};`);
  });

  it("accepts and refuses the same requests on both sides", () => {
    const cases = [
      request(),
      request({ mode: "send" }),
      request({ fallbackText: "All as text." }),
      request({ opId: "short" }),
      request({ provider: "grok" }),
      request({ mode: "auto" }),
      request({ text: "" }),
      request({ text: "x".repeat(AI_TRANSFER_WIRE_LIMITS.text + 1) }),
      request({ files: [{ name: "a.pdf", type: "application/pdf", size: 99, data: pdf }] }),
      request({ files: [{ name: "a.pdf", type: "application/pdf", size: 13, data: "not base64!" }] }),
      request({ files: Array.from({ length: AI_TRANSFER_WIRE_LIMITS.files + 1 }, () => ({ name: "a.pdf", type: "application/pdf", size: 13, data: pdf })) }),
    ];
    for (const value of cases) expect(extension.readTransferRequest(value).ok, JSON.stringify(value).slice(0, 80)).toBe(checkTransferRequest(value) !== undefined);
    expect(cases.filter((value) => checkTransferRequest(value)).length).toBe(3);
  });
});

describe("requests", () => {
  it("makes operation ids the extension accepts", () => {
    const id = newOpId();
    expect(isOpId(id)).toBe(true);
    expect(newOpId()).not.toBe(id);
  });

  it("measures base64 exactly", () => {
    for (const text of ["", "a", "ab", "abc", "abcd"]) expect(base64Bytes(Buffer.from(text).toString("base64"))).toBe(text.length);
  });

  it("refuses files that together are too large", () => {
    const chunk = "A".repeat(Math.ceil((20 * 1024 * 1024) / 3) * 4);
    const file = { name: "big.pdf", type: "application/pdf", size: base64Bytes(chunk), data: chunk };
    expect(checkTransferRequest(request({ files: [file] }))).toBeDefined();
    expect(checkTransferRequest(request({ files: [file, file] }))).toBeUndefined();
  });
});

describe("results from the extension", () => {
  const ok = { opId: "op_1", ok: true, state: "ready-for-review", attached: ["a.pdf"], notAttached: [], usedFallback: false, reusedTab: true };

  it("keeps a full success", () => {
    expect(readTransferResult("op_1", ok)).toEqual(ok);
    expect(readTransferResult("op_1", { ...ok, state: "submitted" })).toMatchObject({ ok: true, state: "submitted" });
  });

  it("never turns a partial or foreign answer into a success", () => {
    expect(readTransferResult("op_1", { ...ok, opId: "op_2" })).toEqual({ opId: "op_1", ok: false, error: "failed" });
    expect(readTransferResult("op_1", { opId: "op_1", ok: true, state: "inserted" })).toMatchObject({ ok: false, error: "failed" });
    expect(readTransferResult("op_1", null)).toMatchObject({ ok: false, error: "failed" });
    expect(readTransferResult("op_1", { opId: "op_1", ok: false, error: "rm -rf" })).toMatchObject({ ok: false, error: "failed" });
    expect(readTransferResult("op_1", { opId: "op_1", ok: false, error: "composer-has-draft" })).toMatchObject({ ok: false, error: "composer-has-draft" });
  });

  it("hears only the states the extension reports while working", () => {
    expect(readTransferProgress({ opId: "op_0123456789", state: "attaching" })).toEqual({ opId: "op_0123456789", state: "attaching" });
    expect(readTransferProgress({ opId: "op_0123456789", state: "submitted" })).toBeUndefined();
    expect(readTransferProgress({ opId: "x", state: "attaching" })).toBeUndefined();
  });

  it("has words for every state and every error", () => {
    for (const error of TRANSFER_ERRORS) expect(errorWords(error, "gemini").length, error).toBeGreaterThan(10);
    expect(stateWords("ready-for-review", "perplexity")).toBe("Ready in Perplexity. Review it there, then send it yourself.");
    expect(errorWords("composer-has-draft", "chatgpt")).toContain("won't overwrite it");
  });
});
