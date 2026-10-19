// The Use in AI runner with every Chrome and page call faked: which tab it
// uses, what it asks the page to do and in what order, what it reports, and
// that it never types or sends twice.
import { describe, expect, it, vi } from "vitest";
import { createTransferRunner, isNewChatTab, OPS_KEY, probeOf, readTransferRequest } from "./ai-transfer.js";

const HUBBLE_TAB = { id: 1, windowId: 10, index: 0, url: "http://localhost:3000/" };
const PDF = { name: "Lecture 4.pdf", type: "application/pdf", size: 3, data: "YWJj" };

function request(patch = {}) {
  return { opId: "op_0123456789abcdef", provider: "chatgpt", mode: "prepare", text: "Context from my project. Summarize it.", files: [], ...patch };
}

/**
 * A fake browser: `open` tabs (by id), a session store, a permission grant,
 * and the page's answers per step — each a function of (tabId, args) or a value.
 */
function world({ tabs = [], granted = true, permissionAnswer = "granted", page = {}, loads = "complete" } = {}) {
  const state = { tabs: new Map(tabs.map((tab) => [tab.id, { status: "complete", windowId: 10, ...tab }])), store: {}, steps: [], reports: [], created: [], activated: [], nextId: 100, granted };
  const answers = {
    probe: { ok: true, empty: true, ours: false },
    attach: (tabId, args) => ({ ok: true, files: args.files.map((file) => ({ name: file.name, attached: true })) }),
    insert: { ok: true },
    submit: { ok: true },
    ...page,
  };
  const deps = {
    tabs: {
      query: vi.fn(async () => [...state.tabs.values()]),
      get: vi.fn(async (id) => {
        const tab = state.tabs.get(id);
        if (!tab) throw new Error(`No tab with id: ${id}.`);
        return tab;
      }),
      create: vi.fn(async (props) => {
        const tab = { id: state.nextId++, windowId: props.windowId ?? 10, url: props.url, status: "loading" };
        state.tabs.set(tab.id, tab);
        state.created.push(props);
        return tab;
      }),
      update: vi.fn(async (id) => state.activated.push(id)),
    },
    windows: { update: vi.fn(async () => {}) },
    hasPermission: vi.fn(async () => state.granted),
    requestPermission: vi.fn(async () => {
      if (permissionAnswer === "granted") state.granted = true;
      return permissionAnswer;
    }),
    waitForTab: vi.fn(async (tabId) => {
      const answer = typeof loads === "function" ? loads(tabId, state) : loads;
      if (answer === "complete") state.tabs.get(tabId).status = "complete";
      return answer;
    }),
    step: vi.fn(async (tabId, name, args) => {
      state.steps.push({ tabId, name, args });
      const answer = answers[name];
      return typeof answer === "function" ? answer(tabId, args, state) : answer;
    }),
    store: {
      get: vi.fn(async (key) => state.store[key]),
      set: vi.fn(async (key, value) => {
        state.store[key] = JSON.parse(JSON.stringify(value));
      }),
    },
    now: () => 1_000_000,
    log: vi.fn(),
    keepAlive: vi.fn(() => vi.fn()),
  };
  const runner = createTransferRunner(deps);
  const run = (req = request()) => runner.run(req, { senderTab: HUBBLE_TAB, report: (s) => state.reports.push(s) });
  return { state, deps, run, steps: () => state.steps.map((entry) => entry.name) };
}

describe("reading the request", () => {
  it("keeps only known fields and re-measures every file", () => {
    const read = readTransferRequest({ ...request({ files: [PDF] }), extra: "dropped" });
    expect(read).toEqual({ ok: true, request: request({ files: [PDF] }) });
    expect(readTransferRequest({ ...request(), files: [{ ...PDF, size: 4 }] }).ok).toBe(false);
    expect(readTransferRequest({ ...request(), provider: "__proto__" }).ok).toBe(false);
    expect(readTransferRequest(null).ok).toBe(false);
  });

  it("recognises only an app's own new-chat page", () => {
    expect(isNewChatTab("chatgpt", "https://chatgpt.com/")).toBe(true);
    expect(isNewChatTab("chatgpt", "https://chatgpt.com/c/6720a1b2-1111")).toBe(false);
    expect(isNewChatTab("claude", "https://claude.ai/new")).toBe(true);
    expect(isNewChatTab("claude", "http://claude.ai/new")).toBe(false);
    expect(isNewChatTab("gemini", "https://gemini.google.com/app")).toBe(true);
    expect(isNewChatTab("gemini", "https://gemini.google.com/app/1a2b3c4d5e6f")).toBe(false);
    expect(isNewChatTab("perplexity", "https://www.perplexity.ai/")).toBe(true);
    expect(isNewChatTab("perplexity", "https://evil.example/?u=https://www.perplexity.ai/")).toBe(false);
  });

  it("identifies Hubble's text by its whitespace-folded start", () => {
    expect(probeOf("  Hello\n\nworld  ")).toBe("Hello world");
    expect(probeOf("x".repeat(100))).toHaveLength(60);
  });
});

describe("choosing the tab", () => {
  it("opens the app's new-chat page next to Hubble when none is open, and waits for it", async () => {
    const { state, run, steps } = world();
    const result = await run();
    expect(state.created).toEqual([{ url: "https://chatgpt.com/", active: true, windowId: 10, index: 1 }]);
    expect(steps()).toEqual(["probe", "insert"]);
    expect(result).toEqual({ opId: "op_0123456789abcdef", ok: true, state: "ready-for-review", attached: [], notAttached: [], usedFallback: false, reusedTab: false });
    expect(state.reports).toEqual(["opening-provider", "waiting-for-provider", "inserting"]);
  });

  it("reuses a tab already on a new chat — in Hubble's window first — instead of opening another", async () => {
    const { state, run } = world({
      tabs: [
        { id: 7, url: "https://claude.ai/new", windowId: 99, lastAccessed: 50 },
        { id: 8, url: "https://claude.ai/new", windowId: 10, lastAccessed: 10 },
        { id: 9, url: "https://claude.ai/chat/0b6f6d3e-aaaa-bbbb", windowId: 10, lastAccessed: 99 },
      ],
    });
    const result = await run(request({ provider: "claude" }));
    expect(state.created).toEqual([]);
    expect(state.activated).toEqual([8]);
    expect(state.steps.every((entry) => entry.tabId === 8)).toBe(true);
    expect(result).toMatchObject({ ok: true, reusedTab: true });
  });

  it("never types into a conversation that is already open", async () => {
    const { state, run } = world({ tabs: [{ id: 9, url: "https://gemini.google.com/app/1a2b3c4d5e6f" }] });
    await run(request({ provider: "gemini" }));
    expect(state.created).toHaveLength(1);
    expect(state.steps.some((entry) => entry.tabId === 9)).toBe(false);
  });

  it("leaves a reused tab's draft alone and opens a new chat instead", async () => {
    const { state, run } = world({
      tabs: [{ id: 8, url: "https://www.perplexity.ai/" }],
      page: { probe: (tabId) => (tabId === 8 ? { ok: true, empty: false, ours: false } : { ok: true, empty: true, ours: false }) },
    });
    const result = await run(request({ provider: "perplexity" }));
    expect(result).toMatchObject({ ok: true, reusedTab: false });
    expect(state.created).toHaveLength(1);
    expect(state.steps.filter((entry) => entry.name === "insert").map((entry) => entry.tabId)).toEqual([100]);
  });

  it("stops when a new tab comes up with someone's draft, rather than overwrite it", async () => {
    const { state, run } = world({ page: { probe: { ok: true, empty: false, ours: false } } });
    expect(await run()).toMatchObject({ ok: false, error: "composer-has-draft" });
    expect(state.steps.map((entry) => entry.name)).toEqual(["probe"]);
  });
});

describe("the app's page", () => {
  it.each([
    ["timeout", "provider-not-loaded"],
    ["removed", "tab-closed"],
  ])("a tab that ends %s fails as %s", async (loads, error) => {
    const { run } = world({
      loads: (tabId, state) => {
        if (loads === "removed") state.tabs.delete(tabId);
        return loads;
      },
    });
    expect(await run()).toMatchObject({ ok: false, error });
  });

  it("says the app wants a sign-in when it sends the new chat to its sign-in page", async () => {
    const { run } = world({ loads: (tabId, state) => ((state.tabs.get(tabId).url = "https://claude.ai/login"), "complete") });
    expect(await run(request({ provider: "claude" }))).toMatchObject({ ok: false, error: "sign-in-required" });
  });

  it("says so when the app redirects to its account provider", async () => {
    const { run } = world({ loads: (tabId, state) => ((state.tabs.get(tabId).url = "https://accounts.google.com/signin"), "complete") });
    expect(await run(request({ provider: "gemini" }))).toMatchObject({ ok: false, error: "sign-in-required" });
  });

  it.each(["no-composer", "sign-in-required", "provider-check"])("passes on the page's %s", async (reason) => {
    const { run, steps } = world({ page: { probe: { ok: false, reason } } });
    expect(await run()).toMatchObject({ ok: false, error: reason });
    expect(steps()).toEqual(["probe"]);
  });

  it("treats a step Chrome swallowed (a null result) as a failure, never a success", async () => {
    const { run } = world({ page: { insert: null } });
    expect(await run()).toMatchObject({ ok: false, error: "not-inserted" });
  });

  it("maps a closed tab during a step", async () => {
    const { deps, run } = world();
    deps.step.mockImplementation(async () => {
      throw new Error("No tab with id: 100.");
    });
    expect(await run()).toMatchObject({ ok: false, error: "tab-closed" });
  });
});

describe("permission", () => {
  it("asks for the app's origins once, then carries on", async () => {
    const { deps, state, run } = world({ granted: false });
    expect(await run(request({ provider: "gemini" }))).toMatchObject({ ok: true });
    expect(deps.requestPermission).toHaveBeenCalledWith("gemini", ["https://gemini.google.com/*"], "op_0123456789abcdef");
    expect(state.reports[0]).toBe("waiting-for-permission");
  });

  it.each([
    ["denied", "permission-denied"],
    ["timeout", "permission-timeout"],
  ])("stops with nothing opened when the person answers %s", async (answer, error) => {
    const { state, run } = world({ granted: false, permissionAnswer: answer });
    expect(await run()).toMatchObject({ ok: false, error });
    expect(state.created).toEqual([]);
    expect(state.steps).toEqual([]);
  });
});

describe("files", () => {
  it("attaches first, then types the message that names them", async () => {
    const { state, run, steps } = world();
    const result = await run(request({ files: [PDF], fallbackText: "All as text." }));
    expect(steps()).toEqual(["probe", "attach", "insert"]);
    expect(state.steps[1].args.files).toEqual([PDF]);
    expect(state.steps[2].args.text).toBe("Context from my project. Summarize it.");
    expect(result).toMatchObject({ ok: true, attached: ["Lecture 4.pdf"], notAttached: [], usedFallback: false });
  });

  it("types the all-text version when a file didn't attach, and says which", async () => {
    const { state, run } = world({ page: { attach: { ok: true, files: [{ name: "Lecture 4.pdf", attached: false, reason: "not-shown" }] } } });
    const result = await run(request({ files: [PDF], fallbackText: "All as text." }));
    expect(state.steps.at(-1)).toMatchObject({ name: "insert", args: { text: "All as text.", probe: "All as text." } });
    expect(result).toMatchObject({ ok: true, usedFallback: true, attached: [], notAttached: [{ name: "Lecture 4.pdf", reason: "ChatGPT didn't show it as attached" }] });
  });

  it("says the app wanted a sign-in to attach", async () => {
    const { run } = world({ page: { attach: { ok: true, files: [{ name: "Lecture 4.pdf", attached: false, reason: "sign-in-to-attach" }] } } });
    expect(await run(request({ provider: "perplexity", files: [PDF], fallbackText: "All as text." }))).toMatchObject({ ok: true, usedFallback: true, notAttached: [{ name: "Lecture 4.pdf", reason: "Perplexity asked you to sign in to attach files" }] });
  });

  it("fails rather than type a message that names a missing file, when there is no text version", async () => {
    const { run, steps } = world({ page: { attach: { ok: true, files: [{ name: "Lecture 4.pdf", attached: false, reason: "no-way-to-attach" }] } } });
    expect(await run(request({ files: [PDF] }))).toMatchObject({ ok: false, error: "attach-failed", notAttached: [{ name: "Lecture 4.pdf", reason: "ChatGPT offered no way to attach it here" }] });
    expect(steps()).toEqual(["probe", "attach"]);
  });
});

describe("sending", () => {
  it("never presses send when the person chose Prepare message", async () => {
    const { run, steps } = world();
    expect(await run(request({ mode: "prepare" }))).toMatchObject({ state: "ready-for-review" });
    expect(steps()).not.toContain("submit");
  });

  it("presses send only when asked, and reports sent only when the page saw it go", async () => {
    const { state, run, steps } = world();
    expect(await run(request({ mode: "send" }))).toMatchObject({ ok: true, state: "submitted" });
    expect(steps()).toEqual(["probe", "insert", "submit"]);
    expect(state.steps[2].args).toMatchObject({ probe: probeOf(request().text) });
    expect(state.reports.at(-1)).toBe("submitting");
  });

  it("leaves the message ready for review, and says why, when sending didn't happen", async () => {
    const { run } = world({ page: { submit: { ok: false, reason: "send-disabled" } } });
    expect(await run(request({ mode: "send", provider: "claude" }))).toMatchObject({ ok: true, state: "ready-for-review", submitProblem: "Claude's send button stayed off (a file may still be uploading)" });
  });
});

describe("repeats", () => {
  it("answers a finished transfer again without typing or sending twice", async () => {
    const { state, run } = world();
    const first = await run(request({ mode: "send" }));
    const steps = state.steps.length;
    const again = await run(request({ mode: "send" }));
    expect(again).toEqual(first);
    expect(state.steps.length).toBe(steps);
    expect(state.created).toHaveLength(1);
    expect(state.store[OPS_KEY]["op_0123456789abcdef"]).toMatchObject({ status: "done", tabId: 100 });
  });

  it("refuses the same transfer while it is still running", async () => {
    let release;
    const { run } = world({ page: { insert: () => new Promise((resolve) => (release = () => resolve({ ok: true }))) } });
    const first = run();
    await vi.waitFor(() => expect(release).toBeDefined());
    expect(await run()).toMatchObject({ ok: false, error: "already-running" });
    release();
    expect(await first).toMatchObject({ ok: true });
  });

  it("tries again in the same tab after a failure, without opening another", async () => {
    let fail = true;
    const { state, run } = world({ page: { insert: () => (fail ? { ok: false, reason: "not-inserted" } : { ok: true }) } });
    expect(await run()).toMatchObject({ ok: false, error: "not-inserted" });
    fail = false;
    expect(await run()).toMatchObject({ ok: true });
    expect(state.created).toHaveLength(1);
  });

  it("doesn't type or attach again when an earlier try's whole text is already in the box", async () => {
    const { state, run, steps } = world({ page: { probe: { ok: true, empty: false, ours: true }, insert: { ok: true, already: true } } });
    expect(await run(request({ files: [PDF], fallbackText: "All as text." }))).toMatchObject({ ok: true, state: "ready-for-review", usedFallback: false });
    expect(steps()).toEqual(["probe", "insert"]);
    expect(state.steps[1].args.waitMs).toBe(0);
  });

  it("recognises the all-text version an earlier failed attach left in the box", async () => {
    const { run } = world({ page: { probe: { ok: true, empty: false, ours: true }, insert: (tabId, args) => (args.text === "All as text." ? { ok: true, already: true } : { ok: false, reason: "not-inserted" }) } });
    expect(await run(request({ files: [PDF], fallbackText: "All as text." }))).toMatchObject({ ok: true, usedFallback: true });
  });

  it("fails rather than call a cut-short earlier copy ready", async () => {
    const { run } = world({ page: { probe: { ok: true, empty: false, ours: true }, insert: { ok: false, reason: "not-inserted" } } });
    expect(await run()).toMatchObject({ ok: false, error: "not-inserted" });
  });

  it("keeps the worker awake while it runs, and lets go after", async () => {
    const stop = vi.fn();
    const { deps, run } = world();
    deps.keepAlive.mockReturnValue(stop);
    await run();
    expect(deps.keepAlive).toHaveBeenCalledTimes(1);
    expect(stop).toHaveBeenCalledTimes(1);
  });

  it("logs counts and states, never the message or files", async () => {
    const { deps, run } = world();
    await run(request({ files: [PDF], fallbackText: "secret fallback" }));
    const logged = JSON.stringify(deps.log.mock.calls);
    expect(logged).not.toContain("Summarize");
    expect(logged).not.toContain("YWJj");
    expect(logged).not.toContain("secret");
  });
});
