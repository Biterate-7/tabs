import { describe, expect, it } from "vitest";
import { composeNote } from "./compose";
import { addProjectNote, cleanTags, readProjectNote, readProjectNotes, removeProjectNotes, updateProjectNote } from "./notes";
import type { WorkspaceStore } from "@/lib/workspace/types";

const NOW = 1_800_000_000_000;
let ids = 0;
const newId = () => `n${++ids}`;

function store(): WorkspaceStore {
  return { version: 1, currentId: "w", workspaces: [{ id: "w", name: "History IA", tabs: [], createdAt: 1, updatedAt: 1 }] };
}

describe("composeNote", () => {
  it("titles a note from its first line and keeps the body for the content store", () => {
    const composed = composeNote(store().workspaces[0]!, { kind: "note", text: "Thesis: alliances mattered less than timetables.\n\nMore later.", origin: "manual", tags: ["thesis", "Thesis", " wwi "] }, NOW, newId);
    expect(composed).toMatchObject({ ok: true, duplicate: false, note: { kind: "note", title: "Thesis: alliances mattered less than timetables.", origin: "manual", tags: ["thesis", "wwi"] } });
    if (composed.ok && !composed.duplicate) expect(composed.content.text).toContain("More later.");
  });

  it("keeps an excerpt's AI app and an http(s) source address, and drops an unsafe one", () => {
    const safe = composeNote(store().workspaces[0]!, { kind: "excerpt", text: "A quoted answer", origin: "paste", provider: "claude", sourceUrl: "https://claude.ai/chat/0b6f6d3e-aaaa" }, NOW, newId);
    expect(safe.ok && safe.note).toMatchObject({ kind: "excerpt", provider: "claude", sourceUrl: "https://claude.ai/chat/0b6f6d3e-aaaa" });
    const unsafe = composeNote(store().workspaces[0]!, { kind: "excerpt", text: "Another", origin: "paste", sourceUrl: "javascript:alert(1)" }, NOW, newId);
    expect(unsafe.ok && unsafe.note.sourceUrl).toBeUndefined();
  });

  it("refuses an empty note, and recognises the same text saved twice", () => {
    expect(composeNote(store().workspaces[0]!, { kind: "note", text: " \n​ ", origin: "manual" }, NOW, newId)).toEqual({ ok: false, reason: "empty" });
    const first = composeNote(store().workspaces[0]!, { kind: "note", text: "Same words", origin: "manual" }, NOW, newId);
    if (!first.ok || first.duplicate) throw new Error("expected a new note");
    const saved = addProjectNote(store(), "w", first.note, NOW);
    expect(composeNote(saved.workspaces[0]!, { kind: "note", text: "Same words", origin: "paste" }, NOW, newId)).toMatchObject({ ok: true, duplicate: true, note: { id: first.note.id } });
  });
});

describe("project notes in the store", () => {
  it("adds, renames, re-tags and removes notes in one project only", () => {
    const composed = composeNote(store().workspaces[0]!, { kind: "note", text: "Body", origin: "manual" }, NOW, newId);
    if (!composed.ok || composed.duplicate) throw new Error("expected a new note");
    let next = addProjectNote(store(), "w", composed.note, NOW);
    next = updateProjectNote(next, "w", composed.note.id, { title: "Renamed", tags: ["a"] }, NOW + 1);
    expect(next.workspaces[0]!.notes![0]).toMatchObject({ title: "Renamed", tags: ["a"], updatedAt: NOW + 1 });
    expect(removeProjectNotes(next, "w", [composed.note.id], NOW + 2).workspaces[0]!.notes ?? []).toEqual([]);
    expect(addProjectNote(store(), "elsewhere", composed.note, NOW)).toEqual(store());
  });

  it("re-reads stored notes strictly: malformed ones dropped, duplicates kept once", () => {
    const good = { id: "n", kind: "note", title: "T", origin: "manual", createdAt: 1, contentHash: "0123456789abcdef", chars: 3 };
    expect(readProjectNote(good)).toEqual({ ...good, updatedAt: 1 });
    expect(readProjectNote({ ...good, kind: "agent_task" })).toBeUndefined();
    expect(readProjectNote({ ...good, contentHash: "nope" })).toBeUndefined();
    expect(readProjectNote({ ...good, provider: "grok" })).not.toHaveProperty("provider");
    expect(readProjectNotes([good, good, "junk", { ...good, id: "m" }]).map((note) => note.id)).toEqual(["n", "m"]);
    expect(cleanTags(["x\u0000y", 42, "", "X Y"])).toEqual(["x y"]);
  });
});
