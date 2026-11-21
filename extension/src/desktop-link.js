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
// Before any of these, Hubble proves it holds the link (no token is sent):
//   POST /v1/link/prove    { challenge } → { proofs }   see linkProof below
// And the other direction — Hubble Desktop asking Chrome (open tabs, history,
// opening a session, context detection), which used to go through a page on
// Hubble's website:
//   POST /v1/link/commands Bearer      → { commands: [{ id, action, args }] }   run by background.js
//   POST /v1/link/result   Bearer      { id, ok, result | error }
//   POST /v1/link/nudge    Bearer      "context activity changed" (carries nothing)
// When this extension's worker is asleep, Hubble opens GET /v1/wake in the
// browser; background.js closes that tab and collects.
//
// The token is kept in chrome.storage.local. A token Hubble no longer knows
// (disconnected in Hubble's Settings) answers 401, and is forgotten here.
//
// Pure apart from what it is handed (storage, fetch, sleep, launch), so it is
// tested without Chrome or a desktop app (desktop-link.test.js).

import { DESKTOP_BRIDGE_PORTS, DesktopError, findDesktop, waitForDesktop } from "./desktop.js";

/** chrome.storage.local: `{ token, linkId, pairedAt }` once paired. */
export const LINK_KEY = "hubble_desktop_link";
/** chrome.storage.session: the pairing in progress, for the popup: `{ status, code?, startedAt, error? }`. */
export const PAIR_STATE_KEY = "hubble_pair_state";

/** The requests Hubble Desktop answers. Mirrors LINK_REQUEST_KINDS in extension_link.rs. */
export const LINK_REQUEST_KINDS = ["projects", "capture", "saved", "search", "bundle", "reused", "save-session", "add-sources"];

/**
 * What Hubble Desktop may ask this extension to do ("Commands from Hubble" in
 * extension_link.rs, LINK_COMMAND_ACTIONS). Each is a browser command of
 * browser-commands.js and is validated there again before Chrome is touched.
 */
export const DESKTOP_COMMAND_ACTIONS = Object.freeze([
  "list_browser_tabs",
  "list_browser_windows",
  "get_history",
  "open_url",
  "open_tabs",
  "open_session",
  "get_context_settings",
  "set_context_settings",
  "request_context_access",
  "get_context_activity",
  "forget_context_activity",
  "clear_context_activity",
  "capture_context_conversation",
]);

/** History and tab lists can be large; Hubble takes up to 8 MB per answer. */
export const LINK_RESULT_TIMEOUT_MS = 20000;

const WAKE = /^http:\/\/127\.0\.0\.1:(\d+)\/v1\/wake\/?$/;

/** Hubble Desktop's wake address (`GET /v1/wake` on one of its ports): it opens this when it needs this extension. */
export function isDesktopWakeUrl(url, ports = DESKTOP_BRIDGE_PORTS) {
  const match = typeof url === "string" ? WAKE.exec(url) : null;
  return Boolean(match && ports.includes(Number(match[1])));
}

/** One collected command, checked for shape (the arguments are validated by browser-commands.js). */
function readCommand(value) {
  if (!value || typeof value !== "object") return undefined;
  const { id, action, args } = value;
  if (typeof id !== "string" || !/^[0-9a-f]{1,100}$/.test(id)) return undefined;
  if (!DESKTOP_COMMAND_ACTIONS.includes(action)) return undefined;
  if (args !== undefined && (args === null || typeof args !== "object" || Array.isArray(args))) return undefined;
  return { id, action, args: args ?? {} };
}

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

/**
 * What Hubble answers to a challenge when it holds this link (extension_link.rs,
 * "Hubble proves itself first"): HMAC-SHA-256 keyed by SHA-256 of the token
 * (hex), over "hubble-link-proof:v1:<port>:<challenge>". Only the real Hubble
 * stores that hash, so another program listening on Hubble's port can't make it.
 */
export async function linkProof(token, port, challenge, subtle = globalThis.crypto?.subtle) {
  const encoder = new TextEncoder();
  const hash = new Uint8Array(await subtle.digest("SHA-256", encoder.encode(token)));
  const keyHex = [...hash].map((byte) => byte.toString(16).padStart(2, "0")).join("");
  const key = await subtle.importKey("raw", encoder.encode(keyHex), { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  const mac = new Uint8Array(await subtle.sign("HMAC", key, encoder.encode(`hubble-link-proof:v1:${port}:${challenge}`)));
  return [...mac].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** A proven port is trusted this long before Hubble is asked to prove itself again. */
export const PROOF_TTL_MS = 10000;

function randomChallenge() {
  const bytes = new Uint8Array(16);
  globalThis.crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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
  const { storage, fetch: fetchFn = globalThis.fetch, sleep, now = Date.now, launch, log = () => {}, subtle = globalThis.crypto?.subtle } = deps;
  let proven = { token: undefined, port: undefined, at: 0 };

  /** "yes": the program on `port` proves it holds this link; "no": it answered, without that proof; "unknown": no answer. */
  async function proves(link, port) {
    const challenge = randomChallenge();
    let answer;
    try {
      answer = await post(fetchFn, port, "/v1/link/prove", { body: { challenge } });
    } catch {
      return "unknown";
    }
    if (answer.status !== 200 || !Array.isArray(answer.body?.proofs)) return "unknown";
    return answer.body.proofs.includes(await linkProof(link.token, port, challenge, subtle)) ? "yes" : "no";
  }

  /**
   * The port where Hubble Desktop proves it holds this link — never simply the
   * first port that says "hubble-desktop". The token (and anything read from a
   * page) goes nowhere else. `preferred` is tried first.
   */
  async function provenPort(link, preferred) {
    if (proven.token === link.token && proven.port !== undefined && (preferred === undefined || preferred === proven.port) && now() - proven.at < PROOF_TTL_MS) return proven.port;
    const order = DESKTOP_BRIDGE_PORTS.includes(preferred) ? [preferred, ...DESKTOP_BRIDGE_PORTS.filter((port) => port !== preferred)] : DESKTOP_BRIDGE_PORTS;
    const answers = await Promise.all(order.map((port) => proves(link, port)));
    const port = order.find((_, index) => answers[index] === "yes");
    if (port === undefined) {
      log("link-unproven", {});
      // A Hubble answered and doesn't hold this link (disconnected in its Settings): forget it, as a refused token is.
      // Forgetting reveals nothing, so it is safe even when what answered was another program.
      if (answers.includes("no")) await forgetLocally("not-proven");
      return undefined;
    }
    proven = { token: link.token, port, at: now() };
    return port;
  }

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
    const port = await provenPort(link, desktop.port);
    // Something answers as Hubble, but nothing proves it holds this link: a Hubble that disconnected this extension,
    // an older Hubble, or another program on Hubble's port. The token is not sent; pairing again replaces it.
    if (port === undefined) return { running: true, ready: desktop.ready, paired: false, pairable: true, port: desktop.port, revoked: true };
    try {
      const answer = await post(fetchFn, port, "/v1/link/status", { token: link.token });
      if (answer.status === 401) {
        await forgetLocally("refused");
        return { running: true, ready: desktop.ready, paired: false, pairable: true, port, revoked: true };
      }
      if (answer.status === 200 && answer.body?.paired === true) {
        return { running: true, ready: answer.body.ready === true, paired: true, port, version: typeof answer.body.version === "string" ? answer.body.version : undefined };
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
        const port = await provenPort(link);
        if (port !== undefined) await post(fetchFn, port, "/v1/link/forget", { token: link.token });
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
    const port = await provenPort(link, desktop.port);
    if (port === undefined) return { ok: false, error: "not-paired" };
    let answer;
    try {
      answer = await post(fetchFn, port, "/v1/link/request", { token: link.token, body: { requestId: newLinkRequestId(), kind, args }, timeoutMs: LINK_REQUEST_TIMEOUT_MS });
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

  /** The paired link and the port Hubble Desktop answers on, or `{ error }`. A known `port` is tried first. */
  async function reach(port) {
    const link = await stored();
    if (!link) return { error: "not-paired" };
    const proved = await provenPort(link, port);
    if (proved !== undefined) return { link, port: proved };
    let desktop;
    try {
      desktop = await findDesktop({ fetch: fetchFn });
    } catch {
      desktop = undefined;
    }
    return { error: desktop ? "not-paired" : "desktop-not-running" };
  }

  /**
   * Collects what Hubble Desktop asked this extension to do. Resolves
   * `{ ok: true, commands: [{ id, action, args }], port }` (malformed ones are
   * dropped) or `{ ok: false, error }` — never throws.
   */
  async function collectCommands({ port } = {}) {
    const reached = await reach(port);
    if (reached.error) return { ok: false, error: reached.error };
    let answer;
    try {
      answer = await post(fetchFn, reached.port, "/v1/link/commands", { token: reached.link.token });
    } catch {
      return { ok: false, error: "desktop-not-responding" };
    }
    if (answer.status === 401) {
      await forgetLocally("refused");
      return { ok: false, error: "not-paired" };
    }
    // An older Hubble Desktop has no commands to give.
    if (answer.status === 404) return { ok: true, commands: [], port: reached.port };
    if (answer.status !== 200 || !Array.isArray(answer.body?.commands)) return { ok: false, error: "desktop-not-responding" };
    const commands = answer.body.commands.map(readCommand).filter(Boolean);
    return { ok: true, commands, port: reached.port };
  }

  /** Hands one command's answer back: `{ id, ok: true, result }` or `{ id, ok: false, error }`. Resolves true when Hubble took it. */
  async function sendResult(port, response) {
    const reached = await reach(port);
    if (reached.error) return false;
    const body = response.ok ? { id: response.id, ok: true, result: response.result ?? null } : { id: response.id, ok: false, error: String(response.error ?? "failed").slice(0, 300) };
    try {
      const answer = await post(fetchFn, reached.port, "/v1/link/result", { token: reached.link.token, body, timeoutMs: LINK_RESULT_TIMEOUT_MS });
      if (answer.status === 401) await forgetLocally("refused");
      return answer.status === 200;
    } catch {
      return false;
    }
  }

  /** "Something you may ask about changed" (context detection's activity). Carries nothing. Resolves true when Hubble heard it. */
  async function nudge() {
    const reached = await reach();
    if (reached.error) return false;
    try {
      const answer = await post(fetchFn, reached.port, "/v1/link/nudge", { token: reached.link.token });
      if (answer.status === 401) await forgetLocally("refused");
      return answer.status === 200;
    } catch {
      return false;
    }
  }

  return { status, beginPairing, awaitPairing, forget, request, stored, collectCommands, sendResult, nudge };
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
