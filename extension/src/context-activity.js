// Context detection: what Chrome showed the person, kept so Hubble can offer
// to put related work in the right project and help them pick it up later.
//
//   tab events (background.js) → observe() → one record per page, in
//   chrome.storage.local → the Hubble page pulls what changed
//   (get_context_activity) and decides what to suggest
//
// The rules:
//   - Off until the person chooses (settings.mode "off"). Every event is
//     checked against their choice first (context-sites.js isDetectable):
//     sensitive sites, excluded hosts, private (incognito) windows, Hubble
//     itself and this computer's own addresses are never recorded.
//   - What Chrome reports about any tab — address, title, icon, when — is
//     all that is kept for a page ("metadata"). A conversation's text is read
//     only for an AI app the person switched on AND granted Chrome access to,
//     and only topic words and a hash are kept from it, never the text.
//   - One record per page (activityKeyOf): reloads, title flickers, redirects
//     and the same page in two tabs update one record. Nothing is written
//     unless something about the page actually changed.
//   - Bounded: at most MAX_RECORDS pages, each kept for the person's
//     retention period; days, terms and visits are capped. Nothing runs on a
//     timer of its own; every bit of work is an event Chrome sent.
//   - Survives the worker stopping: the store is chrome.storage.local, the
//     tab in front is in chrome.storage.session, and a pending write is at
//     most WRITE_DELAY_MS old.
//
// Every browser call is injected (`deps`), so all of it is tested without
// Chrome (context-activity.test.js). Nothing here logs a title, an address
// or what a page says.

import { activityKeyOf, activityKindOf, aiProviderOf, cleanExcludedHost, isDetectable } from "./context-sites.js";
import { conversationIdentityOf } from "./ai-pages.js";

export const CONTEXT_SETTINGS_KEY = "hubble_context_settings";
export const CONTEXT_ACTIVITY_KEY = "hubble_context_activity";
export const CONTEXT_FOCUS_KEY = "hubble_context_focus";

export const MAX_RECORDS = 400;
export const MAX_TOMBSTONES = 400;
export const MAX_DAYS = 14;
export const MAX_TERMS = 40;
export const MAX_TITLE_CHARS = 300;
export const MAX_URL_CHARS = 2000;
/** Two activations closer than this are one visit. */
export const VISIT_GAP_MS = 30 * 60 * 1000;
/** Time in front counted for one visit at most: a tab left open overnight is not eight hours of work. */
export const MAX_DWELL_PER_VISIT_MS = 30 * 60 * 1000;
/** lastSeenAt alone is rewritten at most this often. */
export const SEEN_RESOLUTION_MS = 60 * 1000;
/** A conversation is read again at most this often, unless its title changed. */
export const READ_INTERVAL_MS = 10 * 60 * 1000;
export const WRITE_DELAY_MS = 800;
export const PRUNE_INTERVAL_MS = 5 * 60 * 1000;
/** A tab that moves to another address this soon after arriving, keeping its title, was redirected: still one page. */
export const REDIRECT_WINDOW_MS = 10 * 1000;

const AI_PROVIDERS = ["chatgpt", "claude", "gemini", "perplexity"];
const CATEGORIES = ["ai", "docs", "research", "video"];
const RETENTION = [7, 30, 90];

export const DEFAULT_CONTEXT_SETTINGS = Object.freeze({
  version: 1,
  mode: "off",
  categories: ["ai", "docs", "research"],
  excludedHosts: [],
  paused: false,
  readConversations: [],
  retentionDays: 30,
});

/** Stored or sent settings, re-checked: only known values survive; anything else falls back to the default. */
export function readContextSettings(raw) {
  const base = { ...DEFAULT_CONTEXT_SETTINGS, categories: [...DEFAULT_CONTEXT_SETTINGS.categories], excludedHosts: [], readConversations: [] };
  if (!raw || typeof raw !== "object") return base;
  const settings = { ...base };
  if (["off", "auto", "sites"].includes(raw.mode)) settings.mode = raw.mode;
  if (Number.isFinite(raw.decidedAt) && raw.decidedAt > 0) settings.decidedAt = raw.decidedAt;
  if (Array.isArray(raw.categories)) settings.categories = CATEGORIES.filter((category) => raw.categories.includes(category));
  if (Array.isArray(raw.excludedHosts)) {
    settings.excludedHosts = [...new Set(raw.excludedHosts.map(cleanExcludedHost).filter(Boolean))].slice(0, 200);
  }
  settings.paused = raw.paused === true;
  if (settings.paused && Number.isFinite(raw.pausedUntil) && raw.pausedUntil > 0) settings.pausedUntil = raw.pausedUntil;
  if (Array.isArray(raw.readConversations)) settings.readConversations = AI_PROVIDERS.filter((id) => raw.readConversations.includes(id));
  // The Hubble account that opted in (see background.js, context ownership). Only that one is answered.
  if (typeof raw.owner === "string" && /^[A-Za-z0-9-]{8,100}$/.test(raw.owner)) settings.owner = raw.owner;
  if (RETENTION.includes(raw.retentionDays)) settings.retentionDays = raw.retentionDays;
  return settings;
}

/** Whether a pause is in force now (a timed pause ends by itself). */
export function isPaused(settings, now) {
  return settings.paused === true && !(Number.isFinite(settings.pausedUntil) && settings.pausedUntil <= now);
}

/** The person's local calendar day, "2026-10-28". */
export function dayOf(ms) {
  const date = new Date(ms);
  const pad = (value) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

function cleanTitle(value) {
  if (typeof value !== "string") return "";
  // Characters that hide or reorder text never reach Hubble (the same rule as conversation capture).
  return value.replace(/[\u0000-\u001f\u007f​-‏‪-‮⁦-⁩﻿]/g, "").replace(/\s+/g, " ").trim().slice(0, MAX_TITLE_CHARS);
}

function cleanFavicon(value) {
  return typeof value === "string" && /^https?:\/\//i.test(value) && value.length <= 2000 ? value : undefined;
}

/**
 * What Chrome or a site shows instead of the page: an interstitial (no network,
 * a captive portal, a certificate error), a bot check, a rate limit, a 404. The
 * address is the page's, the title is not — seen on real pages in QA
 * (2026-10-29: "Connect to Wi-Fi", "Wikimedia Error", "Page not found").
 */
const NOT_THE_PAGE = /^(privacy error|your connection is not private|this site can.t be reached|site can.t be reached|connect to wi-?fi|no internet|this page isn.t working|dangerous site|security error|page not found|404( not found)?|not found|access denied|forbidden|just a moment.{0,3}|attention required!?.*|wikimedia error|error|untitled)$/i;

function isUsableTitle(title, url) {
  if (!title || NOT_THE_PAGE.test(title)) return false;
  // Chrome reports the address as the title while a page loads.
  const bare = url.replace(/^https?:\/\//, "");
  return title !== url && title !== bare && !bare.startsWith(title);
}

function domainOf(url) {
  try {
    return new URL(url).hostname.toLowerCase().replace(/^www\./, "");
  } catch {
    return "";
  }
}

function emptyStore(epoch) {
  return { version: 1, epoch, seq: 0, records: {}, removed: [] };
}

/** The stored activity, re-checked: a record from an older build or a damaged one is dropped, never trusted. */
export function readActivityStore(raw, newEpoch) {
  if (!raw || typeof raw !== "object" || raw.version !== 1 || typeof raw.epoch !== "string" || !Number.isInteger(raw.seq)) return emptyStore(newEpoch());
  const records = {};
  for (const [key, record] of Object.entries(raw.records ?? {})) {
    if (!record || typeof record !== "object" || record.key !== key || typeof record.url !== "string" || !Number.isInteger(record.seq)) continue;
    if (!Number.isFinite(record.firstSeenAt) || !Number.isFinite(record.lastSeenAt)) continue;
    records[key] = record;
  }
  const removed = Array.isArray(raw.removed) ? raw.removed.filter((entry) => typeof entry?.key === "string" && Number.isInteger(entry?.seq)).slice(-MAX_TOMBSTONES) : [];
  return { version: 1, epoch: raw.epoch, seq: raw.seq, records, removed };
}

const STOPWORDS = new Set(
  (
    "the and for with that this from have has had was were are you your yours our ours their theirs they them then than " +
    "what which who whom whose when where why how can could would should will shall may might must not but also just " +
    "into onto over under about above below after before again more most some such only own same very too any each both " +
    "few other all one two three first second there here these those its it's been being does did doing done make made " +
    "like want need get got use used using well even much many way ways yes okay sure thanks thank please let lets " +
    "know think see look help able really still because while though although however therefore thus hence via per " +
    "etc i'm i've you're you've we're it's that's there's what's don't doesn't didn't can't won't isn't aren't wasn't " +
    "chatgpt claude gemini perplexity said says say answer question questions response responses message example examples " +
    "here's below above following include includes including based provide provides provided give gives given means mean"
  ).split(" ")
);

/** A conversation's topic words: the most-used ordinary words of its text, never the text itself. */
export function conversationTerms(turns) {
  const counts = new Map();
  for (const turn of Array.isArray(turns) ? turns : []) {
    if (typeof turn?.text !== "string") continue;
    // Code says little about the topic and can be most of a reply.
    const prose = turn.text.replace(/```[\s\S]*?```/g, " ").slice(0, 20000).toLowerCase();
    for (const token of prose.split(/[^a-z]+/)) {
      if (token.length < 3 || token.length > 30 || STOPWORDS.has(token)) continue;
      counts.set(token, (counts.get(token) ?? 0) + (turn.role === "user" ? 2 : 1));
    }
  }
  return [...counts.entries()]
    .filter(([, count]) => count >= 2)
    .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
    .slice(0, MAX_TERMS)
    .map(([token]) => token);
}

/** FNV-1a over what was read: equal text, equal hash. */
export function contentHashOf(turns) {
  let hash = 0x811c9dc5;
  let length = 0;
  for (const turn of Array.isArray(turns) ? turns : []) {
    const text = `${turn?.role ?? ""}:${typeof turn?.text === "string" ? turn.text : ""}\n`;
    length += text.length;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 0x01000193) >>> 0;
    }
  }
  return `fnv1a:${hash.toString(16).padStart(8, "0")}:${length}`;
}

/** A copy of `record` without the named fields. */
function without(record, ...fields) {
  const copy = { ...record };
  for (const field of fields) delete copy[field];
  return copy;
}

/** A record as the Hubble page is sent it: what it needs, nothing internal. */
function publicRecord(record) {
  return without(record, "seq", "readTitle");
}

/**
 * @param deps.storage          { get(key), set(key, value) } — chrome.storage.local
 * @param deps.sessionStorage   the same over chrome.storage.session (cleared when Chrome closes); optional
 * @param deps.now              () => epoch ms
 * @param deps.newEpoch         () => a fresh unique string
 * @param deps.hubbleOrigin     Hubble's origin: never recorded
 * @param deps.hasHostPermission(provider) => Promise<boolean>
 * @param deps.readConversation(tabId) => Promise<read result of readConversationFromPage | undefined>
 * @param deps.getTab(tabId)    => Promise<tab | undefined>
 * @param deps.schedule(fn, ms) => cancel()   (setTimeout in the worker)
 * @param deps.notify()         tell open Hubble pages something changed
 * @param deps.log(stage, data) counts and reasons only
 */
export function createActivityCollector(deps) {
  let store;
  let settingsCache;
  let chain = Promise.resolve();
  let writeTimer;
  let lastPruneAt = 0;
  const reads = new Set();
  const titleTimers = new Map();
  // The page each tab last showed, to tell a redirect (Wikipedia's Pigovian_tax → Pigouvian_tax) from a new page.
  const lastKeyByTab = new Map();

  // One operation at a time: every change is read-modify-write of the same document.
  function serial(task) {
    const run = chain.then(task, task);
    chain = run.catch(() => {});
    return run;
  }

  async function loadStore() {
    if (!store) {
      let raw;
      try {
        raw = await deps.storage.get(CONTEXT_ACTIVITY_KEY);
      } catch {
        raw = undefined;
      }
      store = readActivityStore(raw, deps.newEpoch);
    }
    return store;
  }

  async function settings() {
    if (!settingsCache) {
      let raw;
      try {
        raw = await deps.storage.get(CONTEXT_SETTINGS_KEY);
      } catch {
        raw = undefined;
      }
      settingsCache = readContextSettings(raw);
    }
    return settingsCache;
  }

  async function writeNow() {
    if (writeTimer) {
      writeTimer();
      writeTimer = undefined;
    }
    if (!store) return;
    try {
      await deps.storage.set(CONTEXT_ACTIVITY_KEY, store);
    } catch (err) {
      deps.log?.("context-write-failed", { detail: err instanceof Error ? err.message : "unknown" });
    }
  }

  function scheduleWrite() {
    if (writeTimer) return;
    writeTimer = deps.schedule(() => {
      writeTimer = undefined;
      void serial(writeNow).then(() => deps.notify?.());
    }, WRITE_DELAY_MS);
  }

  function touch(record) {
    store.seq += 1;
    record.seq = store.seq;
    store.records[record.key] = record;
  }

  function remove(key) {
    if (!store.records[key]) return;
    delete store.records[key];
    store.seq += 1;
    store.removed.push({ key, seq: store.seq });
    if (store.removed.length > MAX_TOMBSTONES) store.removed = store.removed.slice(-MAX_TOMBSTONES);
  }

  /** Retention and the size cap. Returns whether anything went. */
  function prune(current, now) {
    let changed = false;
    const cutoff = now - current.retentionDays * 24 * 60 * 60 * 1000;
    for (const record of Object.values(store.records)) {
      const detectable = isDetectable(record.url, { ...current, mode: current.mode === "off" ? "auto" : current.mode, paused: false }, { hubbleOrigin: deps.hubbleOrigin, now });
      // Older than the person keeps activity, or now excluded by them: it goes.
      if (record.lastSeenAt < cutoff || !detectable) {
        remove(record.key);
        changed = true;
      }
    }
    const records = Object.values(store.records);
    if (records.length > MAX_RECORDS) {
      records.sort((a, b) => a.lastSeenAt - b.lastSeenAt);
      for (const record of records.slice(0, records.length - MAX_RECORDS)) remove(record.key);
      changed = true;
    }
    return changed;
  }

  /** Dwell: closes the visit of the tab that was in front, and remembers which one is now. */
  async function moveFocus(nextKey, now) {
    const focusStore = deps.sessionStorage ?? deps.storage;
    let focus;
    try {
      focus = await focusStore.get(CONTEXT_FOCUS_KEY);
    } catch {
      focus = undefined;
    }
    let changed = false;
    if (focus && typeof focus.key === "string" && Number.isFinite(focus.since) && focus.key !== nextKey) {
      const record = store.records[focus.key];
      // Never more than the page has existed for Hubble, and never from a time that hasn't happened.
      const spent = record && focus.since <= now ? Math.min(now - focus.since, MAX_DWELL_PER_VISIT_MS, Math.max(0, now - record.firstSeenAt)) : 0;
      if (record && spent >= 1000) {
        record.dwellMs = Math.min((record.dwellMs ?? 0) + spent, 24 * 60 * 60 * 1000);
        touch(record);
        changed = true;
      }
    }
    // Nothing in front before or now (detection off, or a page it skips): nothing to write.
    if ((focus?.key ?? undefined) !== nextKey) {
      try {
        await focusStore.set(CONTEXT_FOCUS_KEY, nextKey ? { key: nextKey, since: now } : null);
      } catch {
        // Dwell is approximate by design; a lost focus record costs one visit's time.
      }
    }
    return changed;
  }

  /**
   * One tab event. `activated`: the person switched to it (a visit and a
   * change of focus). `inFront`: it is the tab in front — a page that loads
   * in the tab the person is already on (following a link, typing an address)
   * gets the focus without any switch. Anything that may not be recorded is
   * ignored without a trace — not even its address is looked at further.
   */
  function observe(tab, { activated = false, inFront = activated } = {}) {
    return serial(async () => {
      const now = deps.now();
      const current = await settings();
      await loadStore();
      const url = typeof tab?.url === "string" ? tab.url : "";
      const eligible =
        tab && !tab.incognito && url.length > 0 && url.length <= MAX_URL_CHARS && isDetectable(url, current, { hubbleOrigin: deps.hubbleOrigin, now });
      const key = eligible ? activityKeyOf(url) : undefined;
      let changed = inFront ? await moveFocus(key, now) : false;
      if (!key) {
        if (changed) scheduleWrite();
        return undefined;
      }

      const title = cleanTitle(tab.title);
      const favicon = cleanFavicon(tab.favIconUrl);
      const day = dayOf(now);
      const existing = store.records[key];
      // Redirected within the tab a moment ago, still the same page: the record it started as becomes this one.
      const previous = Number.isInteger(tab.id) ? lastKeyByTab.get(tab.id) : undefined;
      let carried;
      if (!existing && previous && previous.key !== key && now - previous.at <= REDIRECT_WINDOW_MS) {
        const old = store.records[previous.key];
        if (old && old.visits === 1 && now - old.firstSeenAt <= REDIRECT_WINDOW_MS && (old.title === "" || old.title === title)) {
          carried = old;
          remove(previous.key);
          changed = true;
        }
      }
      if (Number.isInteger(tab.id)) {
        lastKeyByTab.set(tab.id, { key, at: now });
        if (lastKeyByTab.size > 500) lastKeyByTab.delete(lastKeyByTab.keys().next().value);
      }
      let record;
      if (!existing) {
        const provider = aiProviderOf(url);
        record = {
          key,
          url,
          title: isUsableTitle(title, url) ? title : "",
          domain: domainOf(url),
          kind: activityKindOf(url),
          ...(provider ? { provider } : {}),
          ...(favicon ? { favicon } : {}),
          firstSeenAt: carried?.firstSeenAt ?? now,
          lastSeenAt: now,
          visits: 1,
          dwellMs: carried?.dwellMs ?? 0,
          days: carried ? [...new Set([...carried.days, day])] : [day],
          capture: { status: isUsableTitle(title, url) ? "metadata" : "detected", method: "tab-metadata", ...(activityKindOf(url) === "document" ? { gap: "not-readable" } : {}) },
          seq: 0,
        };
        touch(record);
        changed = true;
      } else {
        record = { ...existing, capture: { ...existing.capture }, days: [...existing.days] };
        let material = false;
        if (record.url !== url) {
          record.url = url;
          material = true;
        }
        if (isUsableTitle(title, url) && title !== record.title) {
          record.title = title;
          if (record.capture.status === "detected") record.capture.status = "metadata";
          material = true;
        }
        if (favicon && favicon !== record.favicon) {
          record.favicon = favicon;
          material = true;
        }
        if (activated && now - record.lastSeenAt >= VISIT_GAP_MS) {
          record.visits = Math.min(record.visits + 1, 10000);
          material = true;
        }
        if (!record.days.includes(day)) {
          record.days = [...record.days, day].slice(-MAX_DAYS);
          material = true;
        }
        if (material || now - record.lastSeenAt >= SEEN_RESOLUTION_MS) {
          record.lastSeenAt = now;
          touch(record);
          changed = true;
        }
      }
      // Retention is a matter of days: checked every few minutes, not on every event. The size cap always holds.
      if (now - lastPruneAt >= PRUNE_INTERVAL_MS || Object.keys(store.records).length > MAX_RECORDS) {
        lastPruneAt = now;
        if (prune(current, now)) changed = true;
      }
      if (changed) scheduleWrite();
      return store.records[key] ? publicRecord(store.records[key]) : undefined;
    });
  }

  /** Title updates arrive in bursts (a reply streaming in): only the last one in a short quiet spell is recorded. */
  function observeTitleChange(tabId, delayMs = 1500) {
    titleTimers.get(tabId)?.();
    titleTimers.set(
      tabId,
      deps.schedule(() => {
        titleTimers.delete(tabId);
        void deps.getTab(tabId).then((tab) => tab && observe(tab));
      }, delayMs)
    );
  }

  /**
   * Reads the conversation in `tab` when the person allowed it for this app
   * (Settings) and Chrome granted the access. Keeps topic words, a hash and a
   * count; the text itself is dropped as soon as they are computed.
   */
  async function maybeReadConversation(tab) {
    const identity = typeof tab?.url === "string" ? conversationIdentityOf(tab.url) : undefined;
    if (!identity || tab.incognito || !Number.isInteger(tab.id)) return "not-a-conversation";
    const key = `conversation:${identity.key}`;
    const current = await settings();
    const now = deps.now();
    if (!isDetectable(tab.url, current, { hubbleOrigin: deps.hubbleOrigin, now })) return "not-detectable";
    await loadStore();
    const record = store.records[key];
    if (!record) return "not-recorded";
    if (reads.has(key)) return "already-reading";

    const enabled = current.readConversations.includes(identity.provider);
    const granted = enabled && (await deps.hasHostPermission(identity.provider).catch(() => false));
    if (!enabled || !granted) {
      const gap = enabled ? "no-permission" : "not-enabled";
      if (record.capture.gap !== gap || record.terms) {
        await serial(async () => {
          const latest = store.records[key];
          if (!latest) return;
          touch({ ...without(latest, "terms"), capture: { status: "metadata", method: "tab-metadata", gap } });
          scheduleWrite();
        });
      }
      return gap;
    }
    const fresh = record.capture.attemptedAt && now - record.capture.attemptedAt < READ_INTERVAL_MS && record.readTitle === record.title;
    if (fresh) return "fresh";

    reads.add(key);
    try {
      let read;
      try {
        read = await deps.readConversation(tab.id);
      } catch {
        read = undefined;
      }
      // The tab moved to another conversation while it was read: what came back may be either's.
      const after = await deps.getTab(tab.id).catch(() => undefined);
      if (!after?.url || conversationIdentityOf(after.url)?.key !== identity.key || (typeof read?.url === "string" && conversationIdentityOf(read.url)?.key !== identity.key)) {
        deps.log?.("context-read-moved", { provider: identity.provider });
        return "moved";
      }
      const ok = read?.ok === true && Array.isArray(read.turns) && read.turns.length > 0;
      const gap = ok ? undefined : read?.reason === "no-messages" ? "layout" : read?.reason === "empty-conversation" ? "empty" : "read-failed";
      deps.log?.("context-read", { provider: identity.provider, ok, turns: ok ? read.turns.length : 0, ...(gap ? { gap } : {}) });
      await serial(async () => {
        const latest = store.records[key];
        if (!latest) return;
        const attemptedAt = deps.now();
        if (ok) {
          const partial = read.partial === true || read.olderNotLoaded === true || read.truncated === true;
          touch({
            ...latest,
            ...(cleanTitle(read.title) && !latest.title ? { title: cleanTitle(read.title) } : {}),
            readTitle: latest.title,
            terms: conversationTerms(read.turns),
            capture: { status: partial ? "partial" : "content", method: "page-read", readAt: attemptedAt, attemptedAt, turnCount: read.turns.length, contentHash: contentHashOf(read.turns) },
          });
        } else {
          // A failed read never takes away what an earlier read found; it says the latest attempt failed.
          const hadContent = latest.capture.status === "content" || latest.capture.status === "partial";
          touch({
            ...latest,
            readTitle: latest.title,
            capture: hadContent ? { ...latest.capture, attemptedAt } : { status: "unavailable", method: "page-read", attemptedAt, gap },
          });
        }
        scheduleWrite();
      });
      return ok ? "read" : gap;
    } finally {
      reads.delete(key);
    }
  }

  /**
   * What changed after `since` in `epoch`. A different epoch (the activity
   * was cleared, or this is a fresh install) or a gap the tombstones no
   * longer cover answers with everything and `reset: true`.
   */
  function list({ since, epoch } = {}) {
    return serial(async () => {
      await loadStore();
      const sameEpoch = epoch === store.epoch && Number.isInteger(since) && since >= 0 && since <= store.seq;
      const oldestTombstone = store.removed[0]?.seq ?? store.seq;
      const reset = !sameEpoch || (store.removed.length >= MAX_TOMBSTONES && since < oldestTombstone);
      const records = Object.values(store.records)
        .filter((record) => reset || record.seq > since)
        .map(publicRecord);
      const removed = reset ? [] : store.removed.filter((entry) => entry.seq > since).map((entry) => entry.key);
      return { epoch: store.epoch, seq: store.seq, reset, records, removed };
    });
  }

  /**
   * The person's new choices. Excluding a host drops what was kept for it;
   * switching an app's reading off drops its words. `replace`: these are the
   * whole settings (a different account's first choice), not a change.
   */
  function updateSettings(next, { replace = false } = {}) {
    return serial(async () => {
      const previous = await settings();
      const cleaned = readContextSettings(replace ? next : { ...previous, ...next });
      settingsCache = cleaned;
      try {
        await deps.storage.set(CONTEXT_SETTINGS_KEY, cleaned);
      } catch (err) {
        settingsCache = previous;
        throw err;
      }
      await loadStore();
      let changed = prune(cleaned, deps.now());
      for (const record of Object.values(store.records)) {
        if (record.provider && record.terms && !cleaned.readConversations.includes(record.provider)) {
          touch({ ...without(record, "terms"), capture: { status: "metadata", method: "tab-metadata", gap: "not-enabled" } });
          changed = true;
        }
      }
      if (changed) {
        await writeNow();
        deps.notify?.();
      }
      return cleaned;
    });
  }

  /** Chrome's grants changed: an app whose access is gone keeps no words read from it. */
  function permissionsChanged(granted) {
    return serial(async () => {
      await loadStore();
      let changed = false;
      for (const record of Object.values(store.records)) {
        if (record.provider && record.terms && !granted.includes(record.provider)) {
          touch({ ...without(record, "terms"), capture: { status: "metadata", method: "tab-metadata", gap: "no-permission" } });
          changed = true;
        }
      }
      if (changed) {
        await writeNow();
        deps.notify?.();
      }
      return changed;
    });
  }

  /** The person removed these from Hubble's activity. */
  function forget(keys) {
    return serial(async () => {
      await loadStore();
      let count = 0;
      for (const key of keys) {
        if (store.records[key]) {
          remove(key);
          count += 1;
        }
      }
      if (count > 0) await writeNow();
      return { forgotten: count };
    });
  }

  /** Everything detected goes, and the epoch changes so every Hubble page starts over. Settings are kept. */
  function clear() {
    return serial(async () => {
      store = emptyStore(deps.newEpoch());
      await writeNow();
      try {
        await (deps.sessionStorage ?? deps.storage).set(CONTEXT_FOCUS_KEY, null);
      } catch {
        // Focus is approximate; nothing it holds is kept anyway once the record is gone.
      }
      return { epoch: store.epoch };
    });
  }

  return {
    settings: () => serial(settings),
    updateSettings,
    observe,
    observeTitleChange,
    maybeReadConversation,
    list,
    forget,
    clear,
    permissionsChanged,
    flush: () => serial(writeNow),
  };
}
