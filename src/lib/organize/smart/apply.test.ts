import { describe, expect, it } from "vitest";
import { applyCollectionBatch } from "@/lib/collections/batch";
import { restoreWorkspaceCollections } from "@/lib/collections/restore";
import { parseSingleUrl } from "@/lib/tabs/parse";
import { createDefaultWorkspace } from "@/lib/workspace/migration";
import { loadWorkspaceStore, saveWorkspaceStore } from "@/lib/workspace/persistence";
import { itemsFromBrowserTabs, itemsFromSubject } from "./items";
import { proposeSmartOrganization } from "./group";
import { moveItem, renameGroup, setDestination } from "./edit";
import { applySmartToSubjects, describeApplied, smartCollectionOperations, undoSmartToSubjects } from "./apply";
import type { BrowserTabInfo } from "@/lib/browser/protocol";
import type { Collection } from "@/lib/collections/types";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "@/lib/workspace/types";

const NOW = 1_800_000_000_000;
const OPTIONS = { now: NOW, subjectsStarted: true, origin: "extension" as const };

function chrome(urls: [string, string][]): BrowserTabInfo[] {
  return urls.map(([url, title], index) => ({ tabId: index + 1, windowId: 1, url, title, pinned: false, active: false, index }));
}

const source = (url: string, title: string): Tab => ({
  ...parseSingleUrl(url)!,
  id: `saved-${url}`,
  createdAt: 1,
  updatedAt: 1,
  title,
  resource: { kind: "webpage", origin: "manual", status: "ready", addedAt: 1, updatedAt: 1 },
});

function baseStore(): WorkspaceStore {
  return {
    version: 1,
    currentId: "home",
    workspaces: [
      { id: "home", name: "Physics", tabs: [source("https://physics.example/kinematics", "Kinematics")], sections: [], createdAt: 1, updatedAt: 1 },
      { id: "history", name: "History", tabs: [], sections: [], createdAt: 1, updatedAt: 1 },
    ],
  };
}

const OPEN = chrome([
  ["https://a.example/projectile", "Projectile motion lab"],
  ["https://b.example/projectile-calc", "Projectile motion calculator"],
  ["https://c.example/frev", "French Revolution causes"],
  ["https://d.example/frev2", "French Revolution timeline"],
  ["https://d.example/frev2#top", "French Revolution timeline"],
  ["https://e.example/misc", "Weekend plans"],
]);

function proposalFor(store: WorkspaceStore) {
  const { items } = itemsFromBrowserTabs(OPEN, store.workspaces);
  return proposeSmartOrganization(items, { mode: "open-tabs", subjects: store.workspaces });
}

const allTabs = (store: WorkspaceStore) => store.workspaces.flatMap((workspace) => workspace.tabs.map((tab) => `${workspace.name}: ${tab.title}`)).sort();

describe("applySmartToSubjects", () => {
  it("adds each group's pages as sources to the right subject, creating only what is missing", () => {
    const before = baseStore();
    let proposal = proposalFor(before);
    const revolution = proposal.groups.find((group) => group.name === "French Revolution")!;
    proposal = setDestination(proposal, revolution.id, { kind: "subject", workspaceId: "history" });

    const applied = applySmartToSubjects(before, proposal, OPTIONS);
    expect(applied.changed).toBe(true);
    expect(allTabs(applied.store)).toEqual([
      "History: French Revolution causes",
      "History: French Revolution timeline",
      "Physics: Kinematics",
      "Projectile motion: Projectile motion calculator",
      "Projectile motion: Projectile motion lab",
    ]);
    // Every new tab is a pending source, so the usual reading pipeline picks it up.
    const added = applied.store.workspaces.flatMap((workspace) => workspace.tabs).filter((tab) => tab.title !== "Kinematics");
    expect(added.every((tab) => tab.resource?.status === "pending" && tab.resource.origin === "extension")).toBe(true);
    // The person stays where they were; the unconfirmed tab went nowhere.
    expect(applied.store.currentId).toBe("home");
    expect(allTabs(applied.store).some((line) => line.includes("Weekend"))).toBe(false);
    expect(applied.results.find((result) => result.name === "French Revolution")).toMatchObject({ targetId: "history", created: false, added: 2, alreadyThere: 1 });
    expect(describeApplied(applied.results, "open-tabs")).toEqual({ title: "Organized 4 pages into 2 subjects (1 new)", details: ["1 already there"] });
    // Original state untouched (pure).
    expect(before).toEqual(baseStore());
  });

  it("is safe to run twice: nothing is duplicated and no second subject is made", () => {
    const first = applySmartToSubjects(baseStore(), proposalFor(baseStore()), OPTIONS).store;
    // Run again against the same open tabs — the pages are now saved, so they are left out by default…
    const again = proposalFor(first);
    expect(again.groups).toEqual([]);
    expect(again.excluded.map((entry) => entry.reason)).toEqual(["already-saved", "already-saved", "already-saved", "already-saved", "already-saved"]);
    // …and even forcing them back in adds nothing new.
    const forced = proposalFor(baseStore());
    const second = applySmartToSubjects(first, forced, OPTIONS);
    expect(second.store.workspaces.map((workspace) => [workspace.name, workspace.tabs.length])).toEqual(first.workspaces.map((workspace) => [workspace.name, workspace.tabs.length]));
    expect(second.results.every((result) => result.added === 0)).toBe(true);
  });

  it("uses an existing subject with the group's name instead of creating a twin", () => {
    let proposal = proposalFor(baseStore());
    const group = proposal.groups.find((entry) => entry.name === "Projectile motion")!;
    proposal = renameGroup(proposal, group.id, "  physics ");
    const applied = applySmartToSubjects(baseStore(), proposal, OPTIONS);
    expect(applied.store.workspaces.filter((workspace) => workspace.name.toLowerCase() === "physics")).toHaveLength(1);
    expect(applied.results.find((result) => result.groupId === group.id)).toMatchObject({ targetId: "home", created: false, added: 2 });
  });

  it("reports a group whose subject disappeared and still applies the others", () => {
    let proposal = proposalFor(baseStore());
    const revolution = proposal.groups.find((group) => group.name === "French Revolution")!;
    proposal = setDestination(proposal, revolution.id, { kind: "subject", workspaceId: "deleted-meanwhile" });
    const applied = applySmartToSubjects(baseStore(), proposal, OPTIONS);
    expect(applied.results.find((result) => result.groupId === revolution.id)).toMatchObject({ error: "destination-missing", added: 0 });
    expect(applied.results.find((result) => result.name === "Projectile motion")).toMatchObject({ added: 2 });
    expect(describeApplied(applied.results, "open-tabs").details).toContain("Couldn't organize “French Revolution”");
  });

  it("changes nothing when every tab is left as is or excluded", () => {
    let proposal = proposalFor(baseStore());
    for (const item of proposal.items) proposal = moveItem(proposal, item.id, { kind: "excluded" });
    const applied = applySmartToSubjects(baseStore(), proposal, OPTIONS);
    expect(applied.changed).toBe(false);
    expect(applied.store).toBe(applied.store);
    expect(applied.results).toEqual([]);
  });

  it("turns the untouched default into the first subject, like New subject does", () => {
    const fresh: WorkspaceStore = { version: 1, currentId: "d", workspaces: [{ ...createDefaultWorkspace(), id: "d" }] };
    const { items } = itemsFromBrowserTabs(OPEN, fresh.workspaces);
    const proposal = proposeSmartOrganization(items, { mode: "open-tabs", subjects: [] });
    const applied = applySmartToSubjects(fresh, proposal, { ...OPTIONS, subjectsStarted: false });
    // The biggest group takes the default's place; the next one is a new subject beside it.
    expect(applied.store.workspaces.map((workspace) => [workspace.id === "d", workspace.name])).toEqual([
      [true, "French Revolution"],
      [false, "Projectile motion"],
    ]);
    expect(applied.receipt.renamedDefault).toMatchObject({ workspaceId: "d", previousName: "General", newName: "French Revolution" });

    const undone = undoSmartToSubjects(applied.store, applied.receipt);
    expect(undone.store.workspaces.map((workspace) => [workspace.id, workspace.name, workspace.tabs.length])).toEqual([["d", "General", 0]]);
  });

  it("survives a save and reload", () => {
    const applied = applySmartToSubjects(baseStore(), proposalFor(baseStore()), OPTIONS);
    window.localStorage.clear();
    expect(saveWorkspaceStore(applied.store)).toBe(true);
    const reloaded = loadWorkspaceStore()!;
    expect(allTabs(reloaded)).toEqual(allTabs(applied.store));
    expect(reloaded.workspaces.flatMap((workspace) => workspace.tabs).filter((tab) => tab.resource).length).toBe(5);
  });
});

describe("undoSmartToSubjects", () => {
  it("puts the store back exactly as it was", () => {
    const before = baseStore();
    const applied = applySmartToSubjects(before, proposalFor(before), OPTIONS);
    const undone = undoSmartToSubjects(applied.store, applied.receipt);
    expect(undone.store).toEqual(before);
    expect(undone.removed).toBe(4);
    expect(undone.keptSubjects).toEqual([]);
  });

  it("only takes back what it added: later work survives, and a created subject someone used is kept", () => {
    const applied = applySmartToSubjects(baseStore(), proposalFor(baseStore()), OPTIONS);
    const created = applied.store.workspaces.find((workspace) => workspace.name === "Projectile motion")!;
    const later: WorkspaceStore = {
      ...applied.store,
      workspaces: applied.store.workspaces.map((workspace) =>
        workspace.id === created.id ? { ...workspace, tabs: [...workspace.tabs, source("https://later.example/x", "Added by hand later")] } : workspace
      ),
    };
    const undone = undoSmartToSubjects(later, applied.receipt);
    expect(allTabs(undone.store)).toEqual(["Physics: Kinematics", "Projectile motion: Added by hand later"]);
    expect(undone.keptSubjects).toEqual(["Projectile motion"]);
  });

  it("turns an adopted plain tab back into a plain tab", () => {
    const withPlain: WorkspaceStore = {
      ...baseStore(),
      workspaces: baseStore().workspaces.map((workspace) =>
        workspace.id === "history" ? { ...workspace, tabs: [{ ...parseSingleUrl("https://c.example/frev")!, id: "plain-1", title: "French Revolution causes" }] } : workspace
      ),
    };
    let proposal = proposalFor(withPlain);
    // A page saved as a plain tab is left out by default ("Already in History"); the person puts it back in.
    const plainItem = proposal.items.find((entry) => entry.url === "https://c.example/frev")!;
    expect(proposal.excluded).toContainEqual({ itemId: plainItem.id, reason: "already-saved" });
    const timeline = proposal.items.find((entry) => entry.url === "https://d.example/frev2")!;
    const revolution = proposal.groups.find((group) => group.itemIds.includes(timeline.id))!;
    proposal = moveItem(proposal, plainItem.id, { kind: "group", groupId: revolution.id });
    proposal = setDestination(proposal, revolution.id, { kind: "subject", workspaceId: "history" });
    const applied = applySmartToSubjects(withPlain, proposal, OPTIONS);
    expect(applied.store.workspaces.find((workspace) => workspace.id === "history")!.tabs.find((tab) => tab.id === "plain-1")!.resource).toBeDefined();
    const undone = undoSmartToSubjects(applied.store, applied.receipt);
    expect(undone.store.workspaces.find((workspace) => workspace.id === "history")!.tabs).toEqual(withPlain.workspaces.find((workspace) => workspace.id === "history")!.tabs);
    expect(undone.removedTabs.find((entry) => entry.workspaceId === "history")!.tabIds).toContain("plain-1");
  });

  it("after a partial apply, undoes only what landed", () => {
    let proposal = proposalFor(baseStore());
    const revolution = proposal.groups.find((group) => group.name === "French Revolution")!;
    proposal = setDestination(proposal, revolution.id, { kind: "subject", workspaceId: "deleted-meanwhile" });
    const applied = applySmartToSubjects(baseStore(), proposal, OPTIONS);
    expect(applied.results.some((result) => result.error === "destination-missing")).toBe(true);
    const undone = undoSmartToSubjects(applied.store, applied.receipt);
    expect(undone.changed).toBe(true);
    expect(undone.store).toEqual(baseStore());
  });

  it("keeps an added source the person has since moved, noted or starred — and the subject holding it", () => {
    const applied = applySmartToSubjects(baseStore(), proposalFor(baseStore()), OPTIONS);
    const created = applied.store.workspaces.find((workspace) => workspace.name === "Projectile motion")!;
    const lab = created.tabs.find((entry) => entry.title === "Projectile motion lab")!;
    const calc = created.tabs.find((entry) => entry.title === "Projectile motion calculator")!;
    const revolutionTab = applied.store.workspaces.find((workspace) => workspace.name === "French Revolution")!.tabs[0]!;
    // The lab page gets a note; the calculator is left alone; one revolution page is moved into Physics by hand.
    const edited: WorkspaceStore = {
      ...applied.store,
      workspaces: applied.store.workspaces.map((workspace) => {
        if (workspace.id === created.id) return { ...workspace, tabs: workspace.tabs.map((entry) => (entry.id === lab.id ? { ...entry, notes: "for the IA" } : entry)) };
        if (workspace.name === "French Revolution") return { ...workspace, tabs: workspace.tabs.filter((entry) => entry.id !== revolutionTab.id) };
        if (workspace.id === "home") return { ...workspace, tabs: [...workspace.tabs, revolutionTab] };
        return workspace;
      }),
    };
    const undone = undoSmartToSubjects(edited, applied.receipt);
    expect(allTabs(undone.store)).toEqual([`Physics: ${revolutionTab.title}`, "Physics: Kinematics", "Projectile motion: Projectile motion lab"].sort());
    expect(undone.keptTabs).toBe(2);
    expect(undone.keptSubjects).toEqual(["Projectile motion"]);
    const taken = undone.removedTabs.flatMap((entry) => entry.tabIds);
    expect(taken).toContain(calc.id);
    expect(taken).not.toContain(lab.id);
    expect(taken).not.toContain(revolutionTab.id);
  });

  it("keeps a new subject the person renamed or described, even once it is empty again", () => {
    const applied = applySmartToSubjects(baseStore(), proposalFor(baseStore()), OPTIONS);
    const edited: WorkspaceStore = {
      ...applied.store,
      workspaces: applied.store.workspaces.map((workspace) =>
        workspace.name === "Projectile motion"
          ? { ...workspace, name: "Physics IA" }
          : workspace.name === "French Revolution"
            ? { ...workspace, brief: { description: "HL paper 2", updatedAt: 5 } }
            : workspace
      ),
    };
    const undone = undoSmartToSubjects(edited, applied.receipt);
    expect(undone.store.workspaces.map((workspace) => [workspace.name, workspace.tabs.length]).sort()).toEqual([
      ["French Revolution", 0],
      ["History", 0],
      ["Physics IA", 0],
      ["Physics", 1],
    ]);
    expect([...undone.keptSubjects].sort()).toEqual(["French Revolution", "Physics IA"]);
  });

  it("keeps a source the person renamed, pinned to a section, filed or gave content — and an adopted tab given content", () => {
    const withPlain: WorkspaceStore = {
      ...baseStore(),
      workspaces: baseStore().workspaces.map((workspace) =>
        workspace.id === "history" ? { ...workspace, tabs: [{ ...parseSingleUrl("https://c.example/frev")!, id: "plain-1", title: "French Revolution causes" }] } : workspace
      ),
    };
    let proposal = proposalFor(withPlain);
    const plainItem = proposal.items.find((entry) => entry.url === "https://c.example/frev")!;
    const timeline = proposal.items.find((entry) => entry.url === "https://d.example/frev2")!;
    const revolution = proposal.groups.find((group) => group.itemIds.includes(timeline.id))!;
    proposal = moveItem(proposal, plainItem.id, { kind: "group", groupId: revolution.id });
    proposal = setDestination(proposal, revolution.id, { kind: "subject", workspaceId: "history" });
    const applied = applySmartToSubjects(withPlain, proposal, OPTIONS);

    const projectile = applied.store.workspaces.find((workspace) => workspace.name === "Projectile motion")!;
    const lab = projectile.tabs.find((entry) => entry.title === "Projectile motion lab")!;
    const calc = projectile.tabs.find((entry) => entry.title === "Projectile motion calculator")!;
    const history = applied.store.workspaces.find((workspace) => workspace.id === "history")!;
    const timelineTab = history.tabs.find((entry) => entry.url === "https://d.example/frev2")!;
    expect(applied.receipt.addedTitles[lab.id]).toBe("Projectile motion lab");

    // lab renamed; calc pinned to a section by hand; the timeline is filed (caller-protected); the adopted tab got a pasted transcript (caller-protected).
    const edited: WorkspaceStore = {
      ...applied.store,
      workspaces: applied.store.workspaces.map((workspace) => ({
        ...workspace,
        tabs: workspace.tabs.map((entry) =>
          entry.id === lab.id ? { ...entry, title: "Lab write-up sources" } : entry.id === calc.id ? { ...entry, sectionId: "s1", sectionLocked: true } : entry
        ),
      })),
    };
    const undone = undoSmartToSubjects(edited, applied.receipt, { protect: new Set([timelineTab.id, "plain-1"]) });
    expect(undone.keptTabs).toBe(4);
    expect(undone.removed).toBe(0);
    expect(undone.changed).toBe(false);
    expect(undone.store).toBe(edited);
    // Nothing whose content must survive is ever reported as removed (which is what drops stored content).
    expect(undone.removedTabs).toEqual([]);
  });

  it("still takes back an untouched source even when its title was empty when added", () => {
    const store = baseStore();
    const { items } = itemsFromBrowserTabs(chrome([["https://untitled.example/a", ""], ["https://untitled.example/b", ""]]), store.workspaces);
    const proposal = proposeSmartOrganization(items, { mode: "open-tabs", subjects: store.workspaces });
    expect(proposal.groups).toHaveLength(1);
    const applied = applySmartToSubjects(store, proposal, OPTIONS);
    expect(Object.keys(applied.receipt.addedTitles)).toEqual([]);
    expect(undoSmartToSubjects(applied.store, applied.receipt).store).toEqual(store);
  });

  it("does nothing to a store that never had the change (another account, or already undone)", () => {
    const applied = applySmartToSubjects(baseStore(), proposalFor(baseStore()), OPTIONS);
    const other = baseStore();
    const undone = undoSmartToSubjects(other, applied.receipt);
    expect(undone.changed).toBe(false);
    expect(undone.store).toBe(other);
    const once = undoSmartToSubjects(applied.store, applied.receipt);
    expect(undoSmartToSubjects(once.store, applied.receipt).changed).toBe(false);
  });
});

describe("smartCollectionOperations", () => {
  const workspace = {
    id: "bio",
    name: "Biology",
    tabs: ["Mitosis stages", "Mitosis vs meiosis", "Enzyme kinetics", "Enzyme inhibition", "Enzymes overview"].map((title, index) => ({
      ...parseSingleUrl(`https://site${index}.example/page`)!,
      id: `t${index}`,
      title,
    })),
    sections: [],
    createdAt: 1,
    updatedAt: 1,
  };
  const other: Collection = { id: "other-col", workspaceId: "elsewhere", name: "Enzymes", tabIds: ["x"], createdAt: 1, updatedAt: 1 };
  const enzymes: Collection = { id: "col-1", workspaceId: "bio", name: "Enzymes", tabIds: ["t4"], createdAt: 1, updatedAt: 1 };

  function plan(collections: Collection[]) {
    const { items } = itemsFromSubject(workspace, collections);
    return proposeSmartOrganization(items, { mode: "subject", workspace, collections });
  }

  it("creates a collection for a new group and adds to the matching existing one, through the store's batch", () => {
    const collections = [enzymes, other];
    const proposal = plan(collections);
    const { operations, results } = smartCollectionOperations(proposal, workspace, collections);
    expect(operations).toEqual([
      { kind: "create_collection", name: "Mitosis", tabIds: ["t0", "t1"] },
      { kind: "add_tabs_to_collection", collectionId: "col-1", tabIds: ["t2", "t3"] },
    ]);
    const batch = applyCollectionBatch(collections, { workspaceId: "bio", tabIds: new Set(workspace.tabs.map((tab) => tab.id)) }, operations, NOW);
    expect(batch.ok).toBe(true);
    if (!batch.ok) return;
    const own = batch.collections.filter((collection) => collection.workspaceId === "bio");
    expect(own.map((collection) => [collection.name, collection.tabIds])).toEqual([
      ["Enzymes", ["t4", "t2", "t3"]],
      ["Mitosis", ["t0", "t1"]],
    ]);
    // Another subject's collection with the same name is never touched.
    expect(batch.collections.find((collection) => collection.id === "other-col")).toEqual(other);
    expect(describeApplied(results, "subject").title).toBe("Organized 4 tabs into 2 collections (1 new)");

    // Undo through the store's own guarded restore.
    const restored = restoreWorkspaceCollections(batch.collections, "bio", collections.filter((c) => c.workspaceId === "bio"), own);
    expect(restored?.collections.filter((collection) => collection.workspaceId === "bio")).toEqual([enzymes]);
  });

  it("undo is refused, changing nothing, once the person has edited a collection it made", () => {
    const collections = [enzymes];
    const { operations } = smartCollectionOperations(plan(collections), workspace, collections);
    const batch = applyCollectionBatch(collections, { workspaceId: "bio", tabIds: new Set(workspace.tabs.map((tab) => tab.id)) }, operations, NOW);
    if (!batch.ok) throw new Error("batch failed");
    const after = batch.collections.filter((collection) => collection.workspaceId === "bio");
    const renamed = batch.collections.map((collection) => (collection.name === "Mitosis" ? { ...collection, name: "Cell division" } : collection));
    expect(restoreWorkspaceCollections(renamed, "bio", [enzymes], after)).toBeNull();
  });

  it("is idempotent: running it again on the result proposes nothing new", () => {
    const collections = [enzymes];
    const first = smartCollectionOperations(plan(collections), workspace, collections);
    const batch = applyCollectionBatch(collections, { workspaceId: "bio", tabIds: new Set(workspace.tabs.map((tab) => tab.id)) }, first.operations, NOW);
    if (!batch.ok) throw new Error("batch failed");
    const again = plan(batch.collections);
    expect(again.groups).toEqual([]);
    expect(smartCollectionOperations(again, workspace, batch.collections).operations).toEqual([]);
  });

  it("folds two groups with one name into one collection and skips tabs that left the subject", () => {
    let proposal = plan([]);
    const [first, second] = proposal.groups;
    proposal = renameGroup(proposal, second!.id, first!.name.toUpperCase());
    const gone = { ...workspace, tabs: workspace.tabs.filter((tab) => tab.id !== "t0") };
    const { operations, results } = smartCollectionOperations(proposal, gone, []);
    expect(operations).toHaveLength(1);
    expect(operations[0]).toMatchObject({ kind: "create_collection", name: first!.name });
    expect(results.reduce((sum, result) => sum + result.failed, 0)).toBe(1);
  });
});
