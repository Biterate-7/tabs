// Use in AI's in-page steps against mocked pages shaped like each app's
// composer (ProseMirror for ChatGPT and Claude, Quill for Gemini, a textarea
// and a Lexical-style box for Perplexity). These are fixtures, not the live
// apps: they pin each adapter to the structure it was written for, and every
// failure path to a named reason.
//
// jsdom has no editing engine, clipboard or drag events, so this file gives
// the page the minimum a browser does: execCommand("insertText") types at the
// caret, and DataTransfer/ClipboardEvent/DragEvent carry files. The mocked
// apps then behave like the real ones: a file shows up as a chip with its
// name a moment later; send empties the box.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { hubbleTransferStep } from "./ai-transfer-page.js";

const PDF = { name: "Lecture 4.pdf", type: "application/pdf", data: btoa("%PDF-1.4") };
const TEXT = "## Context from my Hubble project: Physics\n\nHeat engines.\n\n**What I want to do now:** Summarize it.";

class FakeDataTransfer {
  constructor() {
    this.files = [];
    this.data = {};
    this.items = { add: (file) => this.files.push(file) };
  }
  setData(type, value) {
    this.data[type] = value;
  }
  getData(type) {
    return this.data[type] ?? "";
  }
}

let restore = [];
function stub(target, key, value) {
  const had = Object.prototype.hasOwnProperty.call(target, key);
  const previous = target[key];
  target[key] = value;
  restore.push(() => (had ? (target[key] = previous) : delete target[key]));
}

beforeEach(() => {
  stub(window, "DataTransfer", FakeDataTransfer);
  stub(
    window,
    "ClipboardEvent",
    class extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.clipboardData = init.clipboardData;
      }
    }
  );
  stub(
    window,
    "DragEvent",
    class extends Event {
      constructor(type, init = {}) {
        super(type, init);
        this.dataTransfer = init.dataTransfer;
      }
    }
  );
  // Typing at the caret, the way a browser's editing engine does for a contenteditable.
  stub(document, "execCommand", (command, _ui, value) => {
    if (command !== "insertText") return false;
    const anchor = window.getSelection()?.anchorNode;
    const el = anchor && (anchor.nodeType === 1 ? anchor : anchor.parentElement);
    const box = el?.closest?.("[contenteditable='true']");
    if (!box) return false;
    box.querySelector("p.placeholder, p.is-empty")?.remove();
    box.append(document.createTextNode(value));
    box.classList.remove("ql-blank");
    return true;
  });
});

afterEach(() => {
  for (const undo of restore.reverse()) undo();
  restore = [];
  document.body.innerHTML = "";
  document.title = "";
  vi.useRealTimers();
});

/** Lets a file input take a fake FileList (jsdom only accepts its own). */
function acceptFiles(input) {
  Object.defineProperty(input, "files", {
    configurable: true,
    get() {
      return this._files ?? [];
    },
    set(value) {
      this._files = value;
    },
  });
}

/** The mocked app: shows a chip for each file it is given, a moment later, beside the box. */
function showChips(region, files) {
  setTimeout(() => {
    for (const file of files) {
      const chip = document.createElement("div");
      chip.setAttribute("data-testid", "file-chip");
      chip.setAttribute("aria-label", `Remove ${file.name}`);
      chip.textContent = file.name;
      region.append(chip);
    }
  }, 60);
}

function mount(html) {
  document.body.innerHTML = html;
  return document;
}

const CHATGPT = `
  <main>
    <div class="earlier">An older message mentioning nothing.</div>
    <form>
      <input type="file" accept="image/*" id="images" />
      <input type="file" id="files" />
      <div id="prompt-textarea" contenteditable="true" class="ProseMirror"><p class="placeholder" data-placeholder="Ask anything"></p></div>
      <button data-testid="send-button" disabled>Send</button>
    </form>
  </main>`;

const CLAUDE = `
  <fieldset>
    <input data-testid="file-upload" type="file" accept=".pdf,.docx,.txt,.md" />
    <div contenteditable="true" class="ProseMirror"><p class="is-empty" data-placeholder="How can I help you today?"></p></div>
    <button aria-label="Send message">Send</button>
  </fieldset>`;

const GEMINI = `
  <rich-textarea><div class="ql-editor ql-blank" contenteditable="true" role="textbox"></div></rich-textarea>
  <div class="send-button-container"><button class="send-button" aria-label="Send message">Send</button></div>`;

const PERPLEXITY_TEXTAREA = `
  <div class="ask"><textarea placeholder="Ask anything…"></textarea><input type="file" multiple /><button aria-label="Submit">Go</button></div>`;

describe("probe", () => {
  it("finds an empty message box", async () => {
    mount(CHATGPT);
    expect(await hubbleTransferStep("probe", { probe: "x", waitMs: 0 }, document, "https://chatgpt.com/")).toEqual({ ok: true, empty: true, ours: false });
  });

  it("tells someone's draft apart from Hubble's own earlier text", async () => {
    mount(CLAUDE);
    document.querySelector(".ProseMirror").textContent = "my half-written question";
    expect(await hubbleTransferStep("probe", { probe: "## Context", waitMs: 0 }, document, "https://claude.ai/new")).toEqual({ ok: true, empty: false, ours: false });
    document.querySelector(".ProseMirror").textContent = TEXT;
    expect(await hubbleTransferStep("probe", { probe: "## Context from my Hubble project: Physics", waitMs: 0 }, document, "https://claude.ai/new")).toMatchObject({ ours: true });
  });

  it("waits for a box that renders late", async () => {
    mount("<main></main>");
    setTimeout(() => mount(GEMINI), 300);
    expect(await hubbleTransferStep("probe", { waitMs: 3000 }, document, "https://gemini.google.com/app")).toMatchObject({ ok: true, empty: true });
  });

  it("skips a hidden box", async () => {
    mount(`<div aria-hidden="true"><textarea placeholder="hidden"></textarea></div>`);
    expect(await hubbleTransferStep("probe", { waitMs: 0 }, document, "https://www.perplexity.ai/")).toEqual({ ok: false, reason: "no-composer" });
  });

  it.each([
    ["a sign-in page", "<main><input type='email' /></main>", "", "https://claude.ai/login", "sign-in-required"],
    ["a sign-in form instead of a box", "<main><input type='password' /></main>", "", "https://chatgpt.com/", "sign-in-required"],
    ["a security check", "<div id='challenge-form'></div>", "Just a moment...", "https://claude.ai/new", "provider-check"],
    ["nothing it recognises", "<main>Hello</main>", "", "https://gemini.google.com/app", "no-composer"],
    ["another site", CHATGPT, "", "https://example.com/", "unsupported"],
  ])("names %s", async (_label, html, title, href, reason) => {
    mount(html);
    document.title = title;
    expect(await hubbleTransferStep("probe", { waitMs: 0 }, document, href)).toEqual({ ok: false, reason });
  });
});

describe("insert", () => {
  it.each([
    ["ChatGPT (ProseMirror)", CHATGPT, "https://chatgpt.com/", "#prompt-textarea"],
    ["Claude (ProseMirror)", CLAUDE, "https://claude.ai/new", ".ProseMirror"],
    ["Gemini (Quill)", GEMINI, "https://gemini.google.com/app", ".ql-editor"],
  ])("%s: types at the caret and reads the whole text back", async (_label, html, href, selector) => {
    mount(html);
    expect(await hubbleTransferStep("insert", { text: TEXT, probe: "## Context from my Hubble project: Physics" }, document, href)).toEqual({ ok: true });
    expect(document.querySelector(selector).textContent).toBe(TEXT);
  });

  it("Perplexity (textarea): sets the value the way the framework notices", async () => {
    mount(PERPLEXITY_TEXTAREA);
    const box = document.querySelector("textarea");
    const heard = vi.fn();
    box.addEventListener("input", heard);
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://www.perplexity.ai/")).toEqual({ ok: true });
    expect(box.value).toBe(TEXT);
    expect(heard).toHaveBeenCalled();
  });

  it("Perplexity (Lexical): types line by line with the editor's own soft line break, keeping the message's breaks", async () => {
    mount(`<div id="ask-input" contenteditable="true" role="textbox" data-lexical-editor="true"></div>`);
    const box = document.querySelector("#ask-input");
    const breaks = [];
    // Lexical ignores execCommand's line breaks and inserts one only for a beforeinput insertLineBreak.
    box.addEventListener("beforeinput", (event) => {
      breaks.push(event.inputType);
      if (event.inputType === "insertLineBreak") box.append(document.createElement("br"));
    });
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://www.perplexity.ai/")).toEqual({ ok: true });
    expect(breaks).toEqual(["insertLineBreak", "insertLineBreak", "insertLineBreak", "insertLineBreak"]);
    expect(box.querySelectorAll("br")).toHaveLength(4);
  });

  it("falls back to a paste for an editor that ignores execCommand — only into an empty box", async () => {
    mount(`<div id="ask-input" contenteditable="true" role="textbox"></div>`);
    document.execCommand = () => false;
    const box = document.querySelector("#ask-input");
    box.addEventListener("paste", (event) => setTimeout(() => (box.textContent = event.clipboardData.getData("text/plain")), 30));
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://www.perplexity.ai/")).toEqual({ ok: true });
    expect(box.textContent).toBe(TEXT);
  });

  it("never types over someone's draft", async () => {
    mount(CLAUDE);
    const box = document.querySelector(".ProseMirror");
    box.textContent = "my own words";
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://claude.ai/new")).toEqual({ ok: false, reason: "composer-has-draft" });
    expect(box.textContent).toBe("my own words");
  });

  it("doesn't type twice: its own whole text is done, a cut-short copy is a failure", async () => {
    mount(GEMINI);
    const box = document.querySelector(".ql-editor");
    box.textContent = TEXT;
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://gemini.google.com/app")).toEqual({ ok: true, already: true });
    box.textContent = TEXT.slice(0, 85);
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://gemini.google.com/app")).toEqual({ ok: false, reason: "not-inserted" });
    expect(box.textContent).toBe(TEXT.slice(0, 85));
  });

  it("reports text that never shows up as not inserted", async () => {
    mount(`<div contenteditable="true" class="ProseMirror"></div>`);
    document.execCommand = () => true; // claims success, types nothing
    expect(await hubbleTransferStep("insert", { text: TEXT, waitMs: 200 }, document, "https://claude.ai/new")).toEqual({ ok: false, reason: "not-inserted" });
  });

  it("says when there is no box", async () => {
    mount("<main></main>");
    expect(await hubbleTransferStep("insert", { text: TEXT }, document, "https://chatgpt.com/")).toEqual({ ok: false, reason: "no-composer" });
  });
});

describe("attach", () => {
  it("ChatGPT: uses the file input that takes the file (not the image-only one) and waits for its chip", async () => {
    mount(CHATGPT);
    const images = document.querySelector("#images");
    const files = document.querySelector("#files");
    acceptFiles(images);
    acceptFiles(files);
    const imageChange = vi.fn();
    images.addEventListener("change", imageChange);
    files.addEventListener("change", () => showChips(document.querySelector("form"), files.files));
    expect(await hubbleTransferStep("attach", { files: [PDF], waitMs: 2000 }, document, "https://chatgpt.com/")).toEqual({ ok: true, files: [{ name: "Lecture 4.pdf", attached: true }] });
    expect(imageChange).not.toHaveBeenCalled();
    const sent = files.files[0];
    expect(sent.name).toBe("Lecture 4.pdf");
    expect(sent.type).toBe("application/pdf");
    expect(await sent.text()).toBe("%PDF-1.4");
  });

  it("Claude: its own file input, filtered by accept", async () => {
    mount(CLAUDE);
    const input = document.querySelector("input[type=file]");
    acceptFiles(input);
    input.addEventListener("change", () => showChips(document.querySelector("fieldset"), input.files));
    const answer = await hubbleTransferStep("attach", { files: [PDF, { name: "photo.exe", type: "application/octet-stream", data: btoa("MZ") }], waitMs: 1500 }, document, "https://claude.ai/new");
    expect(answer.files[0]).toEqual({ name: "Lecture 4.pdf", attached: true });
    // No input takes an .exe; a paste and a drop were tried, and nothing showed: said, not guessed.
    expect(answer.files[1]).toEqual({ name: "photo.exe", attached: false, reason: "not-shown" });
  });

  it("Gemini: a paste into the box, since it keeps no file input on the page", async () => {
    mount(GEMINI);
    const box = document.querySelector(".ql-editor");
    box.addEventListener("paste", (event) => event.clipboardData.files.length && showChips(document.querySelector("rich-textarea"), event.clipboardData.files));
    expect(await hubbleTransferStep("attach", { files: [PDF], waitMs: 2000 }, document, "https://gemini.google.com/app")).toEqual({ ok: true, files: [{ name: "Lecture 4.pdf", attached: true }] });
  });

  it("a drop, when neither an input nor a paste takes it", async () => {
    mount(PERPLEXITY_TEXTAREA);
    const region = document.querySelector(".ask");
    region.addEventListener("drop", (event) => showChips(region, event.dataTransfer.files));
    expect(await hubbleTransferStep("attach", { files: [PDF], waitMs: 1500 }, document, "https://www.perplexity.ai/")).toEqual({ ok: true, files: [{ name: "Lecture 4.pdf", attached: true }] });
  });

  it("stops at the app's sign-in prompt (signed out), and says so for every file, without trying further", async () => {
    mount(PERPLEXITY_TEXTAREA);
    const input = document.querySelector("input[type=file]");
    acceptFiles(input);
    const dropped = vi.fn();
    document.querySelector(".ask").addEventListener("drop", dropped);
    input.addEventListener("change", () =>
      setTimeout(() => {
        const dialog = document.createElement("div");
        dialog.setAttribute("role", "dialog");
        dialog.textContent = "Sign in to upload files";
        document.body.append(dialog);
      }, 50)
    );
    const second = { ...PDF, name: "Notes.pdf" };
    expect(await hubbleTransferStep("attach", { files: [PDF, second], waitMs: 2000 }, document, "https://www.perplexity.ai/")).toEqual({
      ok: true,
      files: [
        { name: "Lecture 4.pdf", attached: false, reason: "sign-in-to-attach" },
        { name: "Notes.pdf", attached: false, reason: "sign-in-to-attach" },
      ],
    });
    expect(dropped).not.toHaveBeenCalled();
  });

  it("a name already on the page (an earlier message) never counts as the file arriving", async () => {
    mount(CHATGPT);
    document.querySelector(".earlier").textContent = "Earlier I asked about Lecture 4.pdf";
    expect(await hubbleTransferStep("attach", { files: [PDF], waitMs: 1500 }, document, "https://chatgpt.com/")).toEqual({ ok: true, files: [{ name: "Lecture 4.pdf", attached: false, reason: "not-shown" }] });
  });
});

describe("submit", () => {
  function typed(html, selector) {
    mount(html);
    document.querySelector(selector).textContent = TEXT;
  }

  it("waits for the send button to come on (a file still uploading), presses it, and sees the box empty", async () => {
    typed(CHATGPT, "#prompt-textarea");
    const button = document.querySelector("[data-testid=send-button]");
    setTimeout(() => (button.disabled = false), 300);
    button.addEventListener("click", () => setTimeout(() => (document.querySelector("#prompt-textarea").textContent = ""), 50));
    expect(await hubbleTransferStep("submit", { probe: "## Context from my Hubble project: Physics", waitMs: 3000 }, document, "https://chatgpt.com/")).toEqual({ ok: true });
  });

  it("presses the box's own button, never another form's", async () => {
    mount(`<form id="edit"><button aria-label="Send message" id="other">Send</button></form>${CLAUDE}`);
    document.querySelector(".ProseMirror").textContent = TEXT;
    const other = vi.fn();
    document.querySelector("#other").addEventListener("click", other);
    document.querySelector("fieldset button").addEventListener("click", () => (document.querySelector(".ProseMirror").textContent = ""));
    expect(await hubbleTransferStep("submit", { probe: "## Context from my Hubble project", waitMs: 500 }, document, "https://claude.ai/new")).toEqual({ ok: true });
    expect(other).not.toHaveBeenCalled();
  });

  it("refuses to send a box that doesn't hold Hubble's message", async () => {
    typed(GEMINI, ".ql-editor");
    const click = vi.fn();
    document.querySelector(".send-button").addEventListener("click", click);
    expect(await hubbleTransferStep("submit", { probe: "something else entirely", waitMs: 200 }, document, "https://gemini.google.com/app")).toEqual({ ok: false, reason: "not-ours" });
    expect(click).not.toHaveBeenCalled();
  });

  it.each([
    ["no send button", `<div class="ask"><textarea placeholder="Ask"></textarea></div>`, "no-send-button"],
    ["a send button that stays off", `<div class="ask"><textarea placeholder="Ask"></textarea><button aria-label="Submit" disabled>Go</button></div>`, "send-disabled"],
  ])("%s: says so, and the message stays for review", async (_label, html, reason) => {
    mount(html);
    document.querySelector("textarea").value = TEXT;
    expect(await hubbleTransferStep("submit", { probe: "## Context from my Hubble project", waitMs: 300 }, document, "https://www.perplexity.ai/")).toEqual({ ok: false, reason });
    expect(document.querySelector("textarea").value).toBe(TEXT);
  });

  it("a press the app ignores is not a send", async () => {
    typed(CLAUDE, ".ProseMirror");
    expect(await hubbleTransferStep("submit", { probe: "## Context from my Hubble project", waitMs: 200, confirmMs: 300 }, document, "https://claude.ai/new")).toEqual({ ok: false, reason: "not-submitted" });
  });
});
