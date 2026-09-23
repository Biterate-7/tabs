import { describe, expect, it } from "vitest";
import { readInitializeResult } from "./protocol";
import { createJsonRpcPeer, MAX_ACP_LINE_LENGTH } from "./rpc";
import type { AcpCloseReason, AcpTransport } from "./rpc";

function pipe() {
  const sent: string[] = [];
  let deliver: (line: string) => void = () => {};
  let closeWith: (reason: AcpCloseReason) => void = () => {};
  const transport: AcpTransport = {
    send: (line) => sent.push(line),
    onLine: (listener) => {
      deliver = listener;
      return () => {};
    },
    onClose: (listener) => {
      closeWith = listener;
      return () => {};
    },
    close: () => {},
  };
  return { transport, sent, deliver: (line: string) => deliver(line), close: (r: AcpCloseReason) => closeWith(r) };
}

function peer(handlers: Partial<Parameters<typeof createJsonRpcPeer>[0]> = {}) {
  const wire = pipe();
  const timers: (() => void)[] = [];
  const rpc = createJsonRpcPeer({
    transport: wire.transport,
    onRequest: () => ({ result: null }),
    onNotification: () => {},
    setTimer: (callback) => timers.push(callback),
    clearTimer: () => {},
    ...handlers,
  });
  return { rpc, wire, timers };
}

describe("sign-in methods", () => {
  it("offers only the agent's own interactive login, as the real agents advertise them", () => {
    // Recorded from the real Gemini CLI and codex-acp handshakes.
    const gemini = readInitializeResult({
      protocolVersion: 1,
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google", description: "Log in with your Google account" },
        { id: "gemini-api-key", name: "Gemini API key", description: "Use an API key with Gemini Developer API" },
        { id: "vertex-ai", name: "Vertex AI", description: "Use an API key with Vertex AI GenAI API" },
        { id: "gateway", name: "AI API Gateway", description: "Use a custom AI API Gateway" },
      ],
    });
    const codex = readInitializeResult({
      protocolVersion: 1,
      authMethods: [
        { id: "api-key", name: "API Key", description: "Use an API key to authenticate" },
        { id: "chat-gpt", name: "ChatGPT", description: "Use ChatGPT to authenticate" },
      ],
    });
    expect(gemini?.authMethods.map((method) => method.id)).toEqual(["oauth-personal"]);
    expect(codex?.authMethods.map((method) => method.id)).toEqual(["chat-gpt"]);
  });
});

describe("the JSON-RPC peer", () => {
  it("pairs a response with its request", async () => {
    const { rpc, wire } = peer();
    const pending = rpc.request("session/new", { cwd: "C:/x" });
    const request = JSON.parse(wire.sent[0]);
    expect(request).toMatchObject({ jsonrpc: "2.0", method: "session/new", params: { cwd: "C:/x" } });

    wire.deliver(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: { sessionId: "a" } }));
    expect(await pending).toEqual({ ok: true, value: { sessionId: "a" } });
  });

  it("reports a remote error by code and nothing else", async () => {
    const { rpc, wire } = peer();
    const pending = rpc.request("x", {});
    const { id } = JSON.parse(wire.sent[0]);
    wire.deliver(JSON.stringify({ id, error: { code: -32000, message: "Please sign in at https://evil" } }));
    expect(await pending).toEqual({ ok: false, kind: "remote", code: -32000 });
  });

  it("times out an unanswered request", async () => {
    const { rpc, timers } = peer();
    const pending = rpc.request("x", {});
    timers[0]();
    expect(await pending).toEqual({ ok: false, kind: "timeout" });
  });

  it("fails every outstanding request when the transport closes", async () => {
    const { rpc, wire } = peer();
    const a = rpc.request("a", {});
    const b = rpc.request("b", {});
    wire.close("exited");
    expect(await a).toEqual({ ok: false, kind: "closed" });
    expect(await b).toEqual({ ok: false, kind: "closed" });
    expect(rpc.isOpen()).toBe(false);
  });

  it("ignores log lines, garbage and oversized lines", () => {
    const notes: string[] = [];
    const { wire } = peer({ onNotification: (method) => notes.push(method) });
    wire.deliver("Loaded cached credentials.");
    wire.deliver("{not json");
    wire.deliver(`{"method":"session/update","params":{"x":"${"a".repeat(MAX_ACP_LINE_LENGTH)}"}}`);
    wire.deliver(JSON.stringify({ method: "session/update", params: {} }));
    expect(notes).toEqual(["session/update"]);
  });

  it("answers an agent request and never leaks a handler's exception", async () => {
    const { wire } = peer({
      onRequest: () => {
        throw new Error("C:/Users/alice/secret path");
      },
    });
    wire.deliver(JSON.stringify({ id: 7, method: "fs/read_text_file", params: {} }));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const reply = JSON.parse(wire.sent[0]);
    expect(reply).toEqual({ jsonrpc: "2.0", id: 7, error: { code: -32603, message: "Internal error" } });
  });
});
