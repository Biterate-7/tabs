// Save to Hubble as a durable job: written before it is delivered, "saved"
// only on Hubble's answer, retried with a bounded backoff, picked up again by
// a fresh worker — and never delivered as two copies. Storage behaves like
// chrome.storage.local (a JSON copy in, a JSON copy out); the clock is ours.
import { describe, expect, it, vi } from "vitest";
import {
  CAPTURE_LEASE_MS,
  CAPTURE_MAX_ATTEMPTS,
  CAPTURE_QUEUE_LIMIT,
  CAPTURE_RETRY_DELAYS_MS,
  createCaptureQueue,
  publicJob,
  readCaptureJobs,
} from "./capture-queue.js";

const CAPTURE = { url: "https://chatgpt.com/c/6720a1b2-1111-2222-3333-444455556666", title: "Integration by parts", turns: [{ role: "user", text: "How?" }, { role: "assistant", text: "Like this." }] };
const KEY = "chatgpt:chat:6720a1b2-1111-2222-3333-444455556666";
const OTHER = "chatgpt:chat:68f0c3d4-aaaa-bbbb-cccc-ddddeeeeffff";
const SAVED = { ok: true, result: { outcome: "added", title: "Integration by parts", turns: 2, truncated: false, project: "Maths" } };

/** chrome.storage.local, as far as the queue can tell: values cross by JSON, and survive the worker. */
function fakeStorage(initial) {
  let value = initial === undefined ? undefined : JSON.stringify(initial);
  return {
    get: vi.fn(async () => (value === undefined ? undefined : JSON.parse(value))),
    set: vi.fn(async (jobs) => {
      value = JSON.stringify(jobs);
    }),
    peek: () => (value === undefined ? [] : JSON.parse(value)),
  };
}

/** One worker's queue over `storage`, with a clock we move. */
function worker(storage, deliver, clock = { now: 1_000_000 }) {
  let ids = 0;
  const scheduled = [];
  const queue = createCaptureQueue({
    storage,
    deliver,
    schedule: (at) => scheduled.push(at),
    newId: () => `cap-${clock.now}-${++ids}`,
    now: () => clock.now,
  });
  return { queue, scheduled, clock };
}

const submit = (queue, over = {}) => queue.submit({ key: KEY, provider: "chatgpt", workspaceId: "maths", projectName: "Maths", capture: CAPTURE, ...over });

describe("a save that goes through", () => {
  it("is written down before it is delivered, and saved only on Hubble's answer", async () => {
    const storage = fakeStorage();
    let seenWhileDelivering;
    const deliver = vi.fn(async () => {
      seenWhileDelivering = storage.peek();
      return SAVED;
    });
    const { queue } = worker(storage, deliver);
    const job = await submit(queue);
    expect(seenWhileDelivering).toEqual([expect.objectContaining({ key: KEY, status: "saving", attempts: 1, capture: CAPTURE })]);
    expect(job).toMatchObject({ status: "saved", result: SAVED.result, attempts: 1 });
    expect(deliver).toHaveBeenCalledWith(expect.objectContaining({ id: job.id, workspaceId: "maths", capture: CAPTURE }), { openIfMissing: true });
    // Once Hubble has it, the extension keeps no copy of the conversation.
    expect(storage.peek()[0]).not.toHaveProperty("capture");
  });
});

describe("a transient failure", () => {
  it("is retried with backoff until it is delivered, under the same capture id each time", async () => {
    const storage = fakeStorage();
    const answers = [{ ok: false, error: "no-response" }, { ok: false, error: "timeout" }, SAVED];
    const deliver = vi.fn(async () => answers.shift());
    const { queue, scheduled, clock } = worker(storage, deliver);

    const first = await submit(queue);
    expect(first).toMatchObject({ status: "queued", error: "no-response", attempts: 1, nextAttemptAt: clock.now + CAPTURE_RETRY_DELAYS_MS[0] });
    expect(scheduled.at(-1)).toBe(clock.now + CAPTURE_RETRY_DELAYS_MS[0]);

    // Not due yet: nothing happens.
    expect(await queue.flush()).toEqual([]);
    clock.now += CAPTURE_RETRY_DELAYS_MS[0];
    const [second] = await queue.flush();
    expect(second).toMatchObject({ status: "queued", error: "timeout", attempts: 2, nextAttemptAt: clock.now + CAPTURE_RETRY_DELAYS_MS[1] });
    clock.now += CAPTURE_RETRY_DELAYS_MS[1];
    const [third] = await queue.flush();
    expect(third).toMatchObject({ status: "saved", attempts: 3 });

    const ids = deliver.mock.calls.map(([job]) => job.id);
    expect(new Set(ids).size).toBe(1);
    expect(deliver.mock.calls.map(([, options]) => options.openIfMissing)).toEqual([true, false, false]);
  });

  it("stops after a bounded number of attempts and says it failed — never saved", async () => {
    const deliver = vi.fn(async () => ({ ok: false, error: "no-response" }));
    const { queue, clock } = worker(fakeStorage(), deliver);
    let job = await submit(queue);
    while (job.status === "queued") {
      clock.now = job.nextAttemptAt;
      [job] = await queue.flush();
    }
    expect(job).toMatchObject({ status: "failed", error: "no-response", attempts: CAPTURE_MAX_ATTEMPTS });
    expect(deliver).toHaveBeenCalledTimes(CAPTURE_MAX_ATTEMPTS);
    expect(publicJob(job).retryable).toBe(true);
    // Nothing more is scheduled for it.
    clock.now += 10 * 60 * 1000;
    expect(await queue.flush()).toEqual([]);
  });

  it("waits for Hubble to open instead of spending attempts while it is closed, then goes in", async () => {
    const answers = [{ ok: false, error: "timeout" }, { ok: false, error: "no-hubble-tab" }, SAVED];
    const deliver = vi.fn(async () => answers.shift());
    const { queue, clock } = worker(fakeStorage(), deliver);
    const first = await submit(queue);
    clock.now = first.nextAttemptAt;
    const [waiting] = await queue.flush();
    expect(waiting).toMatchObject({ status: "queued", error: "no-hubble-tab", attempts: 1 });
    expect(waiting).not.toHaveProperty("nextAttemptAt");
    // No timer retries it…
    clock.now += 60 * 60 * 1000;
    expect(await queue.flush()).toEqual([]);
    // …a Hubble page saying it is up does.
    const [saved] = await queue.flush({ reason: "hubble-ready" });
    expect(saved).toMatchObject({ status: "saved", attempts: 2 });
  });

  it("retries a project Hubble's page didn't have when Hubble's newest report does (that page hadn't caught up)", async () => {
    const answers = [{ ok: false, error: "project-missing" }, SAVED];
    const queue = createCaptureQueue({ storage: fakeStorage(), deliver: async () => answers.shift(), isProjectKnown: async (id) => id === "maths", newId: () => "cap-1", now: () => 5 });
    expect(await submit(queue)).toMatchObject({ status: "queued", error: "project-missing" });
    const gone = createCaptureQueue({ storage: fakeStorage(), deliver: async () => ({ ok: false, error: "project-missing" }), isProjectKnown: async () => false, newId: () => "cap-2", now: () => 5 });
    expect(await submit(gone)).toMatchObject({ status: "failed", error: "project-missing" });
  });
});

describe("a failure that is an answer", () => {
  it("fails at once, without retries, and never shows as saved", async () => {
    for (const error of ["project-missing", "storage-failed", "invalid"]) {
      const deliver = vi.fn(async () => ({ ok: false, error }));
      const { queue, scheduled } = worker(fakeStorage(), deliver);
      const job = await submit(queue);
      expect(job).toMatchObject({ status: "failed", error });
      expect(deliver).toHaveBeenCalledTimes(1);
      expect(scheduled).toEqual([]);
    }
  });

  it("can be retried by the person as a fresh start, with the same capture id", async () => {
    const answers = [{ ok: false, error: "storage-failed" }, SAVED];
    const deliver = vi.fn(async () => answers.shift());
    const { queue } = worker(fakeStorage(), deliver);
    const failed = await submit(queue);
    expect(failed.status).toBe("failed");
    const retried = await queue.retry(failed.id);
    expect(retried).toMatchObject({ status: "saved", attempts: 1 });
    expect(deliver.mock.calls[1][0].id).toBe(failed.id);
    expect(deliver.mock.calls[1][1]).toEqual({ openIfMissing: true });
  });

  it("refuses to retry what Hubble refused outright", () => {
    expect(publicJob({ id: "a", key: KEY, status: "failed", workspaceId: "m", attempts: 1, error: "invalid", updatedAt: 1 }).retryable).toBe(false);
  });
});

describe("duplicates", () => {
  it("never delivers one conversation twice at once: a second Save while it is on its way is refused", async () => {
    let release;
    const deliver = vi.fn(() => new Promise((resolve) => (release = () => resolve(SAVED))));
    const { queue } = worker(fakeStorage(), deliver);
    const first = submit(queue);
    await vi.waitFor(() => expect(deliver).toHaveBeenCalledTimes(1));
    expect(await submit(queue)).toEqual({ error: "already-saving" });
    // Nor does a flush (a Hubble page reporting in) pick it up again.
    expect(await queue.flush({ reason: "hubble-ready" })).toEqual([]);
    release();
    expect(await first).toMatchObject({ status: "saved" });
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it("replaces a waiting save of the same conversation with the fresh read: one job, never two", async () => {
    const answers = [{ ok: false, error: "no-response" }, SAVED];
    const deliver = vi.fn(async () => answers.shift());
    const storage = fakeStorage();
    const { queue } = worker(storage, deliver);
    const first = await submit(queue);
    const longer = { ...CAPTURE, turns: [...CAPTURE.turns, { role: "user", text: "And then?" }] };
    const second = await submit(queue, { capture: longer });
    expect(second).toMatchObject({ status: "saved" });
    expect(second.id).not.toBe(first.id);
    expect(storage.peek().filter((job) => job.key === KEY)).toHaveLength(1);
    expect(deliver.mock.calls[1][0].capture).toEqual(longer);
  });

  it("two conversations saved at the same moment are both kept: neither write loses the other", async () => {
    const storage = fakeStorage();
    const { queue } = worker(storage, async () => SAVED);
    const [a, b] = await Promise.all([submit(queue), submit(queue, { key: OTHER })]);
    expect([a.status, b.status]).toEqual(["saved", "saved"]);
    expect(storage.peek().map((job) => job.key).sort()).toEqual([KEY, OTHER].sort());
  });
});

describe("a worker that stops", () => {
  it("leaves a job a fresh worker delivers once its lease has run out — exactly once", async () => {
    const storage = fakeStorage();
    const clock = { now: 2_000_000 };
    // The first worker is stopped mid-delivery: its delivery never answers.
    const stopped = worker(storage, () => new Promise(() => {}), clock);
    void submit(stopped.queue);
    await vi.waitFor(() => expect(storage.peek()[0]?.status).toBe("saving"));
    const id = storage.peek()[0].id;

    // A new worker while the lease still holds: it does not deliver a second copy.
    const deliver = vi.fn(async () => SAVED);
    const early = worker(storage, deliver, clock);
    await early.queue.reconcile();
    expect(await early.queue.flush()).toEqual([]);
    expect(deliver).not.toHaveBeenCalled();

    // Once the lease has run out, the fresh worker picks it up.
    clock.now += CAPTURE_LEASE_MS + 1;
    const fresh = worker(storage, deliver, clock);
    const reconciled = await fresh.queue.reconcile();
    expect(reconciled[0]).toMatchObject({ id, status: "queued", error: "interrupted" });
    const [saved] = await fresh.queue.flush();
    expect(saved).toMatchObject({ id, status: "saved" });
    expect(deliver).toHaveBeenCalledTimes(1);
    expect(deliver.mock.calls[0][0].id).toBe(id);
  });

  it("keeps a job waiting for its retry across a browser restart, and schedules it", async () => {
    const storage = fakeStorage();
    const clock = { now: 3_000_000 };
    const before = worker(storage, async () => ({ ok: false, error: "timeout" }), clock);
    const job = await submit(before.queue);
    const after = worker(storage, async () => SAVED, clock);
    await after.queue.reconcile();
    expect(after.scheduled).toEqual([job.nextAttemptAt]);
    clock.now = job.nextAttemptAt;
    expect((await after.queue.flush())[0]).toMatchObject({ id: job.id, status: "saved" });
  });

  it("ignores stored records it doesn't recognise", () => {
    expect(readCaptureJobs([{ id: "x" }, null, { id: "a", key: KEY, workspaceId: "m", status: "queued", capture: { turns: [] } }])).toHaveLength(1);
    expect(readCaptureJobs("nope")).toEqual([]);
  });
});

describe("bounds", () => {
  it("refuses a save when too many are already waiting, rather than growing without end", async () => {
    const { queue } = worker(fakeStorage(), async () => ({ ok: false, error: "no-response" }));
    for (let index = 0; index < CAPTURE_QUEUE_LIMIT; index += 1) await submit(queue, { key: `chatgpt:chat:${index}0000000` });
    expect(await submit(queue, { key: "chatgpt:chat:overflow00" })).toEqual({ error: "queue-full" });
  });

  it("a project deleted in Hubble fails the saves still waiting to go into it", async () => {
    const storage = fakeStorage();
    const { queue } = worker(storage, async () => ({ ok: false, error: "no-response" }));
    await submit(queue);
    await submit(queue, { key: OTHER, workspaceId: "physics" });
    await queue.projectsDeleted(["maths"]);
    expect(storage.peek().map((job) => [job.workspaceId, job.status, job.error])).toEqual([
      ["maths", "failed", "project-missing"],
      ["physics", "queued", "no-response"],
    ]);
  });
});

describe("a context save bound to an account", () => {
  it("carries its owner, and is dropped with its text when the browser is signed in as someone else", async () => {
    const storage = fakeStorage();
    const deliver = vi.fn(async (job) => (job.owner === "user:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" ? { ok: false, error: "identity-changed" } : { ok: true, result: {} }));
    const { queue } = worker(storage, deliver);
    const job = await submit(queue, { owner: "user:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa" });
    expect(job.status).toBe("failed");
    expect(job.error).toBe("identity-changed");
    const stored = await storage.get();
    expect(stored[0].owner).toBe("user:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
    // Its text goes at once: never retried, never handed to the next account's Hubble page.
    expect(stored[0].capture).toBeUndefined();
    expect(JSON.stringify(stored)).not.toContain(CAPTURE.turns[0].text);
  });

  it("an ordinary Save to Hubble (no owner) is unchanged", async () => {
    const storage = fakeStorage();
    const { queue } = worker(storage, async () => ({ ok: true, result: {} }));
    const job = await submit(queue);
    expect(job.status).toBe("saved");
    expect((await storage.get())[0].owner).toBeUndefined();
  });
});
