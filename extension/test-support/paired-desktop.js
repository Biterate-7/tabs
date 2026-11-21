// A running Hubble Desktop that this extension is paired with, for tests: the
// loopback bridge on its first port (src-tauri/src/import_bridge.rs +
// extension_link.rs), as `fetch` sees it. Each paired request is answered by
// `answer` — by default handed to the harness's own Hubble "page" (whatever
// its chrome.tabs.sendMessage mock answers for MSG_PAGE_REQUEST), since
// Hubble Desktop answers the same page-request protocol the website did.
import { vi } from "vitest";
import { MSG_PAGE_REQUEST } from "../src/config.js";
import { LINK_KEY, linkProof } from "../src/desktop-link.js";

export const TEST_LINK = { token: "a".repeat(64), linkId: "link-1", pairedAt: 1 };
/** The tab id requests are attributed to when forwarded to a harness's page mock. */
export const DESKTOP_PAGE_TAB = 42;

export function json(status, body) {
  return { status, ok: status >= 200 && status < 300, json: async () => body };
}

/** chrome.storage.local content for a paired extension. */
export function pairedStorage(extra = {}) {
  return { [LINK_KEY]: TEST_LINK, ...extra };
}

/** Forwards one paired request to the harness's Hubble page mock, as the website's content script did. */
export async function answerThroughPage(request) {
  const answer = await globalThis.chrome.tabs.sendMessage(DESKTOP_PAGE_TAB, { type: MSG_PAGE_REQUEST, payload: request });
  if (!answer || typeof answer.ok !== "boolean") return { ok: false, error: "failed" };
  return answer.ok ? { ok: true, result: answer.result } : { ok: false, error: answer.error };
}

/**
 * @param options.answer   (request) => { ok, result | error } — Hubble Desktop's webview
 * @param options.running  () => boolean — whether Hubble Desktop is up right now
 * @param options.paired   () => boolean — whether it still knows this extension's token
 * @param options.commands commands Hubble Desktop queued for this extension ("Commands from Hubble"); each collected once
 */
export function pairedDesktopFetch({ answer = answerThroughPage, running = () => true, paired = () => true, ready = true, commands = [] } = {}) {
  const requests = [];
  const results = [];
  const queued = [...commands];
  let nudges = 0;
  const fetch = vi.fn(async (url, init = {}) => {
    const { pathname, port } = new URL(url);
    if (port !== "41517" || !running()) throw new TypeError("Failed to fetch");
    const body = init.body ? JSON.parse(init.body) : undefined;
    if (pathname === "/v1/hello") return json(200, { app: "hubble-desktop", protocol: 1, ready, kinds: ["tabs", "conversation"], link: 1 });
    // Hubble proving it holds the link (extension_link.rs): a proof for the token it knows, none once it forgot it.
    if (pathname === "/v1/link/prove") return json(200, { proofs: paired() ? [await linkProof(TEST_LINK.token, Number(port), body.challenge)] : [] });
    if (pathname.startsWith("/v1/link/") && !paired()) return json(401, { ok: false, reason: "not-paired" });
    if (pathname === "/v1/link/status") return json(200, { paired: true, linkId: TEST_LINK.linkId, ready, version: "0.3.0" });
    if (pathname === "/v1/link/request") {
      requests.push(body);
      return json(200, await answer(body));
    }
    if (pathname === "/v1/link/commands") return json(200, { commands: queued.splice(0) });
    if (pathname === "/v1/link/result") {
      results.push(body);
      return json(200, { ok: true });
    }
    if (pathname === "/v1/link/nudge") {
      nudges += 1;
      return json(200, { ok: true });
    }
    return json(404, { ok: false, reason: "not-found" });
  });
  fetch.requests = requests;
  fetch.results = results;
  fetch.queue = (...more) => queued.push(...more);
  Object.defineProperty(fetch, "nudges", { get: () => nudges });
  return fetch;
}
