// Save to Hubble on the web, as a job that outlives the popup and the service
// worker.
//
//   read the page (background.js) → submit() writes a "queued" job to
//   chrome.storage.local → one delivery to the Hubble page → "saved" only on
//   the page's answer that the conversation is on disk; a transient failure
//   goes back to "queued" with a bounded backoff; anything else is "failed"
//
// Before this a capture lived only in the popup's message port and the
// worker's memory: a popup closed by Chrome, a worker evicted mid-save, or a
// Hubble page that answered late lost the conversation without a word, and
// nothing was ever retried.
//
// The rules:
//   - A job is written before it is delivered, so a worker that stops at any
//     point leaves a job a fresh worker picks up (reconcile).
//   - "saving" holds a lease. A lease that runs out is a delivery whose worker
//     died; reconcile puts it back in the queue. One worker delivers a job at
//     a time, never two (the `delivering` set).
//   - Each job has its own capture id, sent with every delivery: the page
//     answers a repeated id with the first answer, and its content rule
//     (lib/conversations/save.ts: same conversation, same text → unchanged)
//     covers a page reloaded in between. So a retry after a lost answer can
//     never make a second copy.
//   - One job per conversation (its identity key). Saving it again replaces a
//     job that is waiting with the fresh read; one that is being delivered is
//     not interrupted ("already-saving").
//   - Bounded: at most CAPTURE_MAX_ATTEMPTS deliveries before "failed" (the
//     person can still retry), a cap on waiting jobs and their size, and old
//     finished jobs pruned. Nothing retries forever; nothing runs when nothing
//     waits.
//
// Every browser call is injected (`deps`), so the whole lifecycle — restart,
// lease expiry, backoff, duplicates — is tested without Chrome
// (capture-queue.test.js). background.js supplies the real ones. Nothing here
// logs what a conversation says.

export const CAPTURE_RETRY_DELAYS_MS = [2000, 5000, 15000, 60000, 300000];
export const CAPTURE_MAX_ATTEMPTS = CAPTURE_RETRY_DELAYS_MS.length + 1;
// Longer than one delivery can take (page ready wait + the content script's answer timeout + a tab load).
export const CAPTURE_LEASE_MS = 60000;
export const CAPTURE_QUEUE_LIMIT = 10;
export const CAPTURE_QUEUE_CHARS = 6_000_000;
export const CAPTURE_KEEP_SAVED_MS = 10 * 60 * 1000;
export const CAPTURE_KEEP_FAILED_MS = 24 * 60 * 60 * 1000;

// Failures that say nothing about the conversation: Hubble wasn't open, was
// loading, or didn't answer. Worth trying again. Everything else is an answer.
const TRANSIENT = new Set(["no-hubble-tab", "hubble-unreachable", "no-response", "timeout", "not-ready", "failed", "interrupted"]);

export function isTransientCaptureError(error) {
  return TRANSIENT.has(error);
}

// What the person can retry by hand once a job has failed: anything but a capture Hubble refused outright.
const NOT_RETRYABLE = new Set(["invalid", "empty", "no-messages", "empty-conversation", "queue-full"]);

function charsOf(capture) {
  if (!Array.isArray(capture?.turns)) return 0;
  return capture.turns.reduce((sum, turn) => sum + (typeof turn?.text === "string" ? turn.text.length : 0), 0);
}

/** A job as stored, re-checked: storage is the extension's own, but it can hold a record from an older build. */
export function readCaptureJob(raw) {
  if (!raw || typeof raw !== "object") return undefined;
  if (typeof raw.id !== "string" || !raw.id || typeof raw.key !== "string" || !raw.key || typeof raw.workspaceId !== "string" || !raw.workspaceId) return undefined;
  if (!["queued", "saving", "saved", "failed"].includes(raw.status)) return undefined;
  if ((raw.status === "queued" || raw.status === "saving") && !Array.isArray(raw.capture?.turns)) return undefined;
  return raw;
}

export function readCaptureJobs(raw) {
  return Array.isArray(raw) ? raw.map(readCaptureJob).filter(Boolean) : [];
}

/** What the popup is told about a job: its state, never the conversation. */
export function publicJob(job) {
  if (!job) return undefined;
  return {
    id: job.id,
    key: job.key,
    status: job.status,
    workspaceId: job.workspaceId,
    attempts: job.attempts,
    ...(job.projectName ? { projectName: job.projectName } : {}),
    ...(job.error ? { error: job.error } : {}),
    ...(job.nextAttemptAt ? { nextAttemptAt: job.nextAttemptAt } : {}),
    ...(job.result ? { result: job.result } : {}),
    ...(job.status === "failed" ? { retryable: !NOT_RETRYABLE.has(job.error) } : {}),
    updatedAt: job.updatedAt,
  };
}

/**
 * @param deps.storage   { get: () => Promise<unknown>, set: (jobs) => Promise<void> }  chrome.storage.local, by background.js
 * @param deps.deliver   (job, { openIfMissing }) => Promise<{ ok: true, result } | { ok: false, error }>
 * @param deps.schedule  (at) => void      wake flush() at `at` (a timer, and an alarm in case the worker stops first)
 * @param deps.isProjectKnown  (workspaceId) => Promise<boolean>  the extension's newest project snapshot names it
 * @param deps.newId, deps.now, deps.log
 */
export function createCaptureQueue(deps) {
  const { storage, deliver, schedule = () => {}, isProjectKnown = async () => false, newId, now = Date.now, log = () => {} } = deps;
  // The working copy, loaded from storage once per worker and written through on every change.
  let jobs;
  // Read-modify-write, one at a time: two saves finishing together must not write over each other.
  let chain = Promise.resolve();
  // Deliveries this worker is making right now.
  const delivering = new Set();

  function locked(fn) {
    const run = chain.then(fn, fn);
    chain = run.catch(() => {});
    return run;
  }

  async function load() {
    if (jobs) return jobs;
    try {
      jobs = readCaptureJobs(await storage.get());
    } catch (err) {
      log("capture-queue-load-failed", { detail: err instanceof Error ? err.message : String(err) });
      jobs = [];
    }
    return jobs;
  }

  function prune(list, at) {
    return list
      .map((job) => {
        // Waited a whole day for a Hubble page that never came: said so, rather than kept waiting forever.
        if (job.status !== "queued" || at - job.createdAt < CAPTURE_KEEP_FAILED_MS) return job;
        const expired = { ...job, status: "failed", error: "expired", updatedAt: at };
        delete expired.nextAttemptAt;
        return expired;
      })
      .filter((job) => {
        if (job.status === "saved") return at - job.updatedAt < CAPTURE_KEEP_SAVED_MS;
        if (job.status === "failed") return at - job.updatedAt < CAPTURE_KEEP_FAILED_MS;
        return true;
      });
  }

  async function save(list) {
    jobs = prune(list, now());
    try {
      await storage.set(jobs);
    } catch (err) {
      // Not durable this time (storage full or unavailable); the copy in memory still delivers.
      log("capture-queue-persist-failed", { detail: err instanceof Error ? err.message : String(err) });
    }
  }

  // A job with no `nextAttemptAt` is waiting for a Hubble page to open, not for a time: nothing is scheduled for it.
  function wakeForNext(list) {
    const next = list.filter((job) => job.status === "queued" && Number.isFinite(job.nextAttemptAt)).map((job) => job.nextAttemptAt);
    if (next.length > 0) schedule(Math.min(...next));
  }

  /** Whether the save of conversation `key` is being delivered right now (by this worker, or one whose lease is live). */
  function inFlight(job, at) {
    return job.status === "saving" && (delivering.has(job.id) || (job.leaseUntil ?? 0) > at);
  }

  /**
   * One delivery of job `id`. Resolves with the job as it stands afterwards.
   * `force` delivers a failed job too (the person pressed Retry), as a fresh start.
   */
  async function attempt(id, { openIfMissing = false, force = false } = {}) {
    const claimed = await locked(async () => {
      const list = await load();
      const job = list.find((entry) => entry.id === id);
      if (!job || delivering.has(id)) return { job, deliver: false };
      if (job.status === "saved" || (job.status === "failed" && !force) || inFlight(job, now())) return { job, deliver: false };
      const at = now();
      const next = { ...job, status: "saving", attempts: force ? 1 : job.attempts + 1, leaseUntil: at + CAPTURE_LEASE_MS, updatedAt: at };
      delete next.nextAttemptAt;
      delivering.add(id);
      await save(list.map((entry) => (entry.id === id ? next : entry)));
      return { job: next, deliver: true };
    });
    if (!claimed.deliver) return claimed.job;

    const job = claimed.job;
    let outcome;
    try {
      outcome = await deliver(job, { openIfMissing });
    } catch (err) {
      outcome = { ok: false, error: "failed", detail: err instanceof Error ? err.message : String(err) };
    }
    if (!outcome || typeof outcome !== "object") outcome = { ok: false, error: "no-response" };

    // A project Hubble's page doesn't have, that the newest report from Hubble does: that page hadn't caught up yet.
    const missingButKnown = !outcome.ok && outcome.error === "project-missing" && (await isProjectKnown(job.workspaceId).catch(() => false));

    return locked(async () => {
      delivering.delete(id);
      const list = await load();
      const current = list.find((entry) => entry.id === id);
      // Replaced or removed while it was on its way: the newer job is what counts now.
      if (!current) return undefined;
      const at = now();
      let next;
      if (outcome.ok) {
        next = { ...current, status: "saved", result: outcome.result ?? {}, updatedAt: at };
        // Saved: the text is in Hubble now, so the extension's copy goes.
        delete next.capture;
        delete next.error;
      } else if (outcome.error === "no-hubble-tab" && !openIfMissing) {
        // Hubble was closed since: this was no attempt at all. It waits for a Hubble page to say it is up (flush "hubble-ready").
        next = { ...current, status: "queued", error: outcome.error, attempts: Math.max(0, current.attempts - 1), updatedAt: at };
        delete next.nextAttemptAt;
      } else if ((isTransientCaptureError(outcome.error) || missingButKnown) && current.attempts < CAPTURE_MAX_ATTEMPTS) {
        next = { ...current, status: "queued", error: outcome.error, nextAttemptAt: at + CAPTURE_RETRY_DELAYS_MS[current.attempts - 1], updatedAt: at };
      } else {
        next = { ...current, status: "failed", error: outcome.error ?? "failed", updatedAt: at };
        // Asked for by an account the browser is no longer signed in as: its text goes now, never to be retried for another.
        if (outcome.error === "identity-changed") delete next.capture;
      }
      delete next.leaseUntil;
      const updated = list.map((entry) => (entry.id === id ? next : entry));
      await save(updated);
      log("capture-job", { id, status: next.status, attempt: next.attempts, ...(next.error ? { error: next.error } : {}) });
      wakeForNext(updated);
      return { ...next, ...(outcome.hubbleTabId !== undefined ? { hubbleTabId: outcome.hubbleTabId } : {}) };
    });
  }

  return {
    /**
     * A conversation just read from its page, to save into `workspaceId`.
     * Persists the job, then makes the first delivery (opening Hubble when no
     * tab has it — the person just asked). Resolves with the job afterwards,
     * or `{ error }` when it could not be queued at all.
     */
    async submit({ key, provider, workspaceId, projectName, capture, truncated = false, notes, owner }) {
      const queued = await locked(async () => {
        const list = await load();
        const at = now();
        const existing = list.find((job) => job.key === key);
        if (existing && inFlight(existing, at)) return { error: "already-saving" };
        const others = list.filter((job) => job.key !== key);
        const waiting = others.filter((job) => job.status === "queued" || job.status === "saving");
        const chars = waiting.reduce((sum, job) => sum + charsOf(job.capture), 0) + charsOf(capture);
        if (waiting.length >= CAPTURE_QUEUE_LIMIT || chars > CAPTURE_QUEUE_CHARS) return { error: "queue-full" };
        const job = {
          id: newId(),
          key,
          provider,
          workspaceId,
          ...(projectName ? { projectName } : {}),
          capture,
          truncated: truncated === true,
          ...(notes && Object.keys(notes).length > 0 ? { notes } : {}),
          // A context save's verified owner (context-identity.js): delivered only while that account is signed in.
          ...(typeof owner === "string" && owner ? { owner } : {}),
          status: "queued",
          attempts: 0,
          createdAt: at,
          updatedAt: at,
        };
        await save([...others, job]);
        return { job };
      });
      if (queued.error) return { error: queued.error };
      return (await attempt(queued.job.id, { openIfMissing: true })) ?? { error: "failed" };
    },

    /** The person pressed Retry: deliver now, opening Hubble if needed, with a fresh set of attempts if it had failed. */
    async retry(id) {
      return attempt(id, { openIfMissing: true, force: true });
    },

    /**
     * Delivers every waiting job that is due — or every waiting job, when a
     * Hubble page has just said it is up (`reason: "hubble-ready"`): the
     * reason they were waiting is gone. Never opens Hubble on its own.
     */
    async flush({ reason = "timer" } = {}) {
      const list = await locked(load);
      const at = now();
      const due = list.filter(
        (job) => job.status === "queued" && !delivering.has(job.id) && (reason === "hubble-ready" || (Number.isFinite(job.nextAttemptAt) && job.nextAttemptAt <= at))
      );
      const results = [];
      // One at a time: they go to the same page, and a burst helps nobody.
      for (const job of due) results.push(await attempt(job.id));
      if (due.length === 0) wakeForNext(list);
      return results;
    },

    /**
     * A fresh worker: any "saving" job whose lease ran out was being delivered
     * by a worker that no longer exists, so it waits again (due now). Then the
     * next wake-up is scheduled.
     */
    async reconcile() {
      const list = await locked(async () => {
        const loaded = await load();
        const at = now();
        let changed = false;
        const next = loaded.map((job) => {
          if (job.status !== "saving" || delivering.has(job.id) || (job.leaseUntil ?? 0) > at) return job;
          changed = true;
          log("capture-job-interrupted", { id: job.id, attempt: job.attempts });
          const back = { ...job, status: job.attempts < CAPTURE_MAX_ATTEMPTS ? "queued" : "failed", error: "interrupted", nextAttemptAt: at, updatedAt: at };
          delete back.leaseUntil;
          return back;
        });
        if (changed || next.length !== prune(next, at).length) await save(next);
        return jobs;
      });
      wakeForNext(list);
      return list;
    },

    /** Projects deleted in Hubble: a job still waiting to go into one of them never will. */
    async projectsDeleted(ids) {
      if (!ids?.length) return;
      const gone = new Set(ids);
      await locked(async () => {
        const list = await load();
        const at = now();
        let changed = false;
        const next = list.map((job) => {
          if (job.status !== "queued" || !gone.has(job.workspaceId)) return job;
          changed = true;
          const failed = { ...job, status: "failed", error: "project-missing", updatedAt: at };
          delete failed.nextAttemptAt;
          return failed;
        });
        if (changed) await save(next);
      });
    },

    /** The job for conversation `key`, as the popup may see it. */
    async forConversation(key) {
      const list = await locked(load);
      return publicJob(list.find((job) => job.key === key));
    },

    async all() {
      return locked(load);
    },
  };
}
