// Hubble for Chrome ⇄ Hubble Desktop, paired.
//
// Hubble is a desktop app. Everything this extension used to hand to a
// Hubble tab in the browser — the person's projects for the popup, a saved
// conversation, a search, the context to bring into an AI chat, a session of
// tabs, quick add — now goes to Hubble Desktop on this computer, over the
// loopback bridge (src-tauri/src/extension_link.rs). Nothing goes near a
// server.
//
// Pairing, once:
//   POST /v1/pair { label }            → { pairingId, code }   both the popup and Hubble's window show the code
//   POST /v1/pair/:id/status           → waiting | approved { token, linkId } (once) | denied
// Then every request carries the token, which Hubble only accepts from this
// extension's own origin:
//   POST /v1/link/status   Bearer      → { paired, ready, version }
//   POST /v1/link/request  Bearer      { requestId, kind, args } → { ok, result | error }
//   POST /v1/link/forget   Bearer      (disconnect from this side)
//
// The token is kept in chrome.storage.local. A token Hubble no longer knows
// (disconnected in Hubble's Settings) answers 401, and is forgotten here.
//
// Pure apart from what it is handed (storage, fetch, sleep, launch), so it is
// tested without Chrome or a desktop app (desktop-link.test.js).

import { DesktopError, findDesktop, waitForDesktop } from "./desktop.js";

/** chrome.storage.local: `{ token, linkId, pairedAt }` once paired. */
export const LINK_KEY = "hubble_desktop_link";
/** chrome.storage.session: the pairing in progress, for the popup: `{ status, code?, startedAt, error? }`. */
export const PAIR_STATE_KEY = "hubble_pair_state";

/** The requests Hubble Desktop answers. Mirrors LINK_REQUEST_KINDS in extension_link.rs. */
export const LINK_REQUEST_KINDS = ["projects", "capture", "saved", "search", "bundle", "reused", "save-session", "add-sources"];

/** Hubble waits up to 25 s for its window to answer one request; this outlasts it. */
export const LINK_REQUEST_TIMEOUT_MS = 30000;
/** Status and pairing calls are answered at once. */
export const LINK_QUICK_TIMEOUT_MS = 4000;
/** How long a pairing waits for the person in Hubble (Rust keeps it for 120 s). */
export const PAIR_WAIT_MS = 125000;
export const PAIR_POLL_MS = 1000;

const TOKEN = /^[0-9a-f]{64}$/;

function bridgeUrl(port, path) {
  return `http://127.0.0.1:${port}${path}`;
}

async function post(fetchFn, port, path, { token, body, timeoutMs = LINK_QUICK_TIMEOUT_MS } = {}) {
  const controller = typeof AbortController === "function" ? new AbortController() : undefined;
  const timer = setTimeout(() => controller?.abort(), timeoutMs);
  try {
    const response = await fetchFn(bridgeUrl(port, path), {
      method: "POST",
      cache: "no-store",
      credentials: "omit",
      headers: { "content-type": "application/json", ...(token ? { authorization: `Bearer ${token}` } : {}) },
      body: JSON.stringify(body ?? {}),
      ...(controller ? { signal: controller.signal } : {}),
    });
    let parsed;
    try {
      parsed = await response.json();
    } catch {
      parsed = undefined;
    }
    return { status: response.status, body: parsed };
  } catch (err) {
    throw new DesktopError("desktop-not-responding", err instanceof Error ? err.message : String(err));
  } finally {
    clearTimeout(timer);
  }
}

let requestCounter = 0;
function newLinkRequestId() {
  requestCounter = (requestCounter + 1) % 1_000_000;
  const random = Math.random().toString(36).slice(2, 10);
  return `x-${Date.now().toString(36)}-${requestCounter.toString(36)}-${random}`;
}

/**
 * @param deps.storage  { get(): Promise<link|undefined>, set(link): Promise<void>, clear(): Promise<void> }
 * @param deps.fetch, deps.sleep, deps.now
 * @param deps.launch   () => Promise<boolean>  opens hubble:// (starts Hubble Desktop)
 * @param deps.log
 */
export function createDesktopLink(deps) {
  const { storage, fetch: fetchFn = globalThis.fetch, sleep, now = Date.now, launch, log = () => {} } = deps;

  async function stored() {
    try {
      const link = await storage.get();
      return link && TOKEN.test(link.token) && typeof link.linkId === "string" ? link : undefined;
    } catch {
      return undefined;
    }
  }

  async function forgetLocally(reason) {
    log("link-forgotten-locally", { reason });
    try {
      await storage.clear();
    } catch {
      // Nothing stored to clear.
    }
  }

  /**
   * Where things stand: is Hubble Desktop running (and its window up), and
   * is this extension paired with it? A stored token Hubble refuses is
   * forgotten here.
   */
  async function status() {
    const link = await stored();
    let desktop;
    try {
      desktop = await findDesktop({ fetch: fetchFn });
    } catch {
      desktop = undefined;
    }
    if (!desktop) return { running: false, paired: Boolean(link) };
    if (!link) return { running: true, ready: desktop.ready, paired: false, pairable: true, port: desktop.port };
    try {
      const answer = await post(fetchFn, desktop.port, "/v1/link/status", { token: link.token });
      if (answer.status === 401) {
        await forgetLocally("refused");
        return { running: true, ready: desktop.ready, paired: false, pairable: true, port: desktop.port, revoked: true };
      }
      if (answer.status === 200 && answer.body?.paired === true) {
        return { running: true, ready: answer.body.ready === true, paired: true, port: desktop.port, version: typeof answer.body.version === "string" ? answer.body.version : undefined };
      }
      // An older Hubble Desktop with no link: it can still take tabs, but can't pair.
      return { running: true, ready: desktop.ready, paired: false, pairable: false, port: desktop.port };
    } catch {
      return { running: true, ready: desktop.ready, paired: Boolean(link), port: desktop.port };
    }
  }

  /** Starts pairing: resolves `{ pairingId, code, port }`, or `{ error }`. */
  async function beginPairing(label) {
    let desktop;
    try {
      desktop = await findDesktop({ fetch: fetchFn });
    } catch {
      desktop = undefined;
    }
    if (!desktop) return { error: "desktop-not-running" };
    try {
      const answer = await post(fetchFn, desktop.port, "/v1/pair", { body: { label: typeof label === "string" ? label.slice(0, 60) : undefined } });
      if (answer.status === 201 && typeof answer.body?.pairingId === "string" && /^\d{6}$/.test(answer.body?.code ?? "")) {
        log("pair-begun", {});
        return { pairingId: answer.body.pairingId, code: answer.body.code, port: desktop.port };
      }
      if (answer.status === 429) return { error: "desktop-busy" };
      if (answer.status === 404 || answer.status === 405) return { error: "desktop-too-old" };
      return { error: "desktop-not-responding" };
    } catch {
      return { error: "desktop-not-responding" };
    }
  }

  /**
   * Waits for the person's answer in Hubble's window. Resolves
   * `{ status: "approved" | "denied" | "expired" | "failed" }`; an approval
   * is stored before it resolves. `onTick` keeps the caller's worker awake.
   */
  async function awaitPairing({ pairingId, port }, { onTick, waitMs = PAIR_WAIT_MS } = {}) {
    const deadline = now() + waitMs;
    for (;;) {
      let answer;
      try {
        answer = await post(fetchFn, port, `/v1/pair/${encodeURIComponent(pairingId)}/status`);
      } catch {
        answer = undefined;
      }
      const body = answer?.body;
      if (answer?.status === 200 && body?.status === "approved") {
        if (!TOKEN.test(body.token ?? "") || typeof body.linkId !== "string") return { status: "failed" };
        await storage.set({ token: body.token, linkId: body.linkId, pairedAt: now() });
        log("paired", { linkId: body.linkId });
        return { status: "approved" };
      }
      if (answer?.status === 200 && body?.status === "denied") return { status: "denied" };
      if (answer?.status === 404) return { status: "expired" };
      if (now() >= deadline) return { status: "expired" };
      await onTick?.();
      await sleep(PAIR_POLL_MS);
    }
  }

  /** Disconnects: Hubble forgets the token, then so does this extension. */
  async function forget() {
    const link = await stored();
    if (link) {
      try {
        const desktop = await findDesktop({ fetch: fetchFn });
        if (desktop) await post(fetchFn, desktop.port, "/v1/link/forget", { token: link.token });
      } catch {
        // Not running: Hubble's Settings can still disconnect it there.
      }
    }
    await forgetLocally("disconnected");
  }

  /**
   * One request to Hubble Desktop. Resolves `{ ok: true, result }` or
   * `{ ok: false, error }` — never throws. `launch: true` starts Hubble when it
   * isn't running (only for something the person just asked for).
   *
   * Errors: "not-paired", "desktop-not-running", "desktop-not-responding",
   * "not-ready" (its window is still starting — ask again), "timed-out", or
   * Hubble's own answer ("project-missing", …).
   */
  async function request(kind, args = {}, { launch: mayLaunch = false, onTick } = {}) {
    if (!LINK_REQUEST_KINDS.includes(kind)) return { ok: false, error: "invalid" };
    const link = await stored();
    if (!link) return { ok: false, error: "not-paired" };
    let desktop;
    try {
      desktop = await findDesktop({ fetch: fetchFn });
    } catch {
      desktop = undefined;
    }
    if (!desktop && mayLaunch && launch) {
      const launched = await launch().catch(() => false);
      desktop = launched ? await waitForDesktop({ fetch: fetchFn, sleep, now, onTick }) : undefined;
      log("link-launch", { kind, launched, found: Boolean(desktop) });
    }
    if (!desktop) return { ok: false, error: "desktop-not-running" };
    let answer;
    try {
      answer = await post(fetchFn, desktop.port, "/v1/link/request", { token: link.token, body: { requestId: newLinkRequestId(), kind, args }, timeoutMs: LINK_REQUEST_TIMEOUT_MS });
    } catch {
      return { ok: false, error: "desktop-not-responding" };
    }
    if (answer.status === 401) {
      await forgetLocally("refused");
      return { ok: false, error: "not-paired" };
    }
    if (answer.status === 429) return { ok: false, error: "desktop-busy" };
    if (answer.status !== 200 || !answer.body || typeof answer.body.ok !== "boolean") return { ok: false, error: "desktop-not-responding" };
    return answer.body.ok ? { ok: true, result: answer.body.result } : { ok: false, error: typeof answer.body.error === "string" ? answer.body.error : "failed" };
  }

  return { status, beginPairing, awaitPairing, forget, request, stored };
}

/** The pairing in progress or just finished, as the popup words it. */
export function describePairState(state) {
  switch (state?.status) {
    case "starting":
      return { text: "Asking Hubble Desktop…", tone: "progress" };
    case "waiting":
      return { text: `In Hubble Desktop, check the code is ${formatCode(state.code)} and choose Connect.`, tone: "progress" };
    case "approved":
      return { text: "Connected to Hubble Desktop.", tone: "success" };
    case "denied":
      return { text: "Hubble Desktop didn't connect. Try again if you meant to.", tone: "error" };
    case "expired":
      return { text: "Hubble Desktop wasn't answered in time. Try again.", tone: "error" };
    case "failed":
      switch (state.error) {
        case "desktop-not-running":
          return { text: "Open Hubble Desktop first, then connect.", tone: "error" };
        case "desktop-too-old":
          return { text: "Update Hubble Desktop to connect it to Chrome.", tone: "error" };
        case "desktop-busy":
          return { text: "Hubble Desktop is answering another request. Try again in a moment.", tone: "error" };
        default:
          return { text: "Couldn't reach Hubble Desktop. Try again.", tone: "error" };
      }
    default:
      return undefined;
  }
}

export function formatCode(code) {
  return typeof code === "string" && /^\d{6}$/.test(code) ? `${code.slice(0, 3)} ${code.slice(3)}` : "";
}
