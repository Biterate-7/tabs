import { scopedKey } from "@/lib/storage/namespace";
import { stripWrongTypedTabFields } from "@/lib/tabs/sanitize";
import type { Tab } from "@/lib/tabs/types";
import type { WorkspaceStore } from "./types";

// Base keys. Signed out these are the literal keys used; signed in,
// scopedKey() prefixes them with the account (see
// src/lib/storage/namespace.ts), which is what keeps two accounts sharing a
// browser from sharing each other's data. The legacy single-workspace key is
// scoped too, so a first sign-in starts empty rather than silently
// inheriting whatever the signed-out state had.
const STORAGE_KEY = "tabdump:workspace:v1";
const WORKSPACE_STORE_KEY = "tabdump:workspaces:v1";

export function isStorageAvailable(): boolean {
  try {
    const testKey = "__tabdump_storage_test__";
    window.localStorage.setItem(testKey, "1");
    window.localStorage.removeItem(testKey);
    return true;
  } catch {
    return false;
  }
}

export function loadWorkspace(): Tab[] | null {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !Array.isArray(parsed.tabs)) return null;
    return parsed.tabs as Tab[];
  } catch {
    return null;
  }
}

export function saveWorkspace(tabs: Tab[]): boolean {
  try {
    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify({ version: 1, tabs }));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspaceStorage(): void {
  try {
    window.localStorage.removeItem(scopedKey(STORAGE_KEY));
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}

function isValidTab(value: unknown): value is Tab {
  if (!value || typeof value !== "object") return false;
  const t = value as Record<string, unknown>;
  return (
    typeof t.id === "string" &&
    typeof t.url === "string" &&
    typeof t.normalizedUrl === "string" &&
    typeof t.domain === "string"
  );
}

function isValidWorkspace(value: unknown): value is WorkspaceStore["workspaces"][number] {
  if (!value || typeof value !== "object") return false;
  const w = value as Record<string, unknown>;
  return (
    typeof w.id === "string" &&
    typeof w.name === "string" &&
    Array.isArray(w.tabs) &&
    w.tabs.every(isValidTab) &&
    typeof w.createdAt === "number" &&
    typeof w.updatedAt === "number"
  );
}

export function isValidWorkspaceStore(value: unknown): value is WorkspaceStore {
  if (!value || typeof value !== "object") return false;
  const s = value as Record<string, unknown>;
  return (
    s.version === 1 &&
    typeof s.currentId === "string" &&
    Array.isArray(s.workspaces) &&
    s.workspaces.length > 0 &&
    s.workspaces.every(isValidWorkspace)
  );
}

/**
 * Repairs a store on the way out of storage, in place.
 *
 * `isValidWorkspaceStore` only checks the fields a `Tab` cannot do without;
 * it says nothing about the optional ones. That gap used to be fatal: a
 * single tab carrying `"title": 12345` — from a hand-edited file, or an
 * import taken before the type checks existed — made the entire app fail to
 * start with "This page couldn't load", because `title?.trim()` throws on a
 * number and `?.` only guards null.
 *
 * Repair, never reject: every workspace and every tab is kept, and only the
 * wrong-typed field is removed. Refusing the whole store would turn one bad
 * value into a user losing all their workspaces, which is a worse outcome
 * than the thing being defended against.
 *
 * Tabs whose `url` is an unsafe scheme are deliberately kept too. They are
 * inert — openTab refuses to open them (src/lib/browser/open-tab.ts) — and
 * deleting rows a previous version legitimately stored would be destroying
 * the user's own data to fix a problem that is already contained.
 */
/**
 * Drops a tab's section/group reference when it does not name something in
 * the tab's OWN workspace.
 *
 * A version of moveTabsBetweenWorkspaces carried `sectionId` across a move,
 * so a tab could end up pointing at a section in the workspace it came from.
 * Locally that is almost invisible — the tab simply reads as unsectioned.
 * The server enforces the same invariant with a composite foreign key
 * (tabdump_tabs_section_same_workspace), and since that constraint is
 * deferred it fails at COMMIT, taking the whole push down with it and
 * stranding every tab in the workspace behind a retrying 500.
 *
 * Fixing the move stops new ones; this heals the rows already written, so an
 * affected browser recovers by loading the app rather than needing the user
 * to delete and rebuild a workspace. The tab is never removed — only the
 * reference that cannot resolve, which is what the UI already renders as
 * "no section" anyway.
 */
function dropDanglingEntityRefs(workspace: WorkspaceStore["workspaces"][number]): void {
  const sections = new Set((workspace.sections ?? []).map((section) => section.id));
  const groups = new Set((workspace.groups ?? []).map((group) => group.id));

  for (const tab of workspace.tabs) {
    if (tab.sectionId !== undefined && !sections.has(tab.sectionId)) {
      delete tab.sectionId;
      // The lock named that section. Keeping it would hold the tab out of
      // organization in a workspace whose sections it has no claim on.
      delete tab.sectionLocked;
    }
    if (tab.groupId !== undefined && !groups.has(tab.groupId)) {
      delete tab.groupId;
    }
  }
}

function repairWorkspaceStore(store: WorkspaceStore): WorkspaceStore {
  for (const workspace of store.workspaces) {
    for (const tab of workspace.tabs) stripWrongTypedTabFields(tab);
    dropDanglingEntityRefs(workspace);
  }
  return store;
}

export function loadWorkspaceStore(): WorkspaceStore | null {
  try {
    const raw = window.localStorage.getItem(scopedKey(WORKSPACE_STORE_KEY));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!isValidWorkspaceStore(parsed)) return null;

    // Repair is best-effort, and its failure is not the store's failure.
    //
    // `null` from here does not mean "unusable" to the caller — it means "no
    // store", and migrateToWorkspaceStore answers that by REPLACING
    // everything with a fresh default workspace. So letting a throw in the
    // repair pass escape turned one bad field into the user losing every
    // workspace they had, which is precisely the outcome the note above
    // repairWorkspaceStore says must never happen.
    //
    // It is reachable, not theoretical: isValidWorkspaceStore checks id,
    // name, tabs, createdAt and updatedAt and says nothing about `sections`,
    // so a workspace whose sections is not an array passes validation and
    // then throws while being repaired.
    //
    // An unrepaired store is still a valid one — repair only ever removes
    // values that were already unusable — so returning it keeps the user's
    // data at the cost of leaving a field the repair would have tidied.
    try {
      return repairWorkspaceStore(parsed);
    } catch {
      return parsed;
    }
  } catch {
    return null;
  }
}

/**
 * Reads the signed-out store specifically, ignoring whichever account is
 * currently active. Exists for the one-time "bring your existing
 * workspaces in?" offer (see BringLocalDataDialog), which has to describe
 * data that by definition lives outside the namespace it is offering to
 * copy it into. Read-only — nothing here writes to the signed-out keys.
 */
export function loadAnonymousWorkspaceStore(): WorkspaceStore | null {
  try {
    const raw = window.localStorage.getItem(WORKSPACE_STORE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidWorkspaceStore(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

export function saveWorkspaceStore(store: WorkspaceStore): boolean {
  try {
    window.localStorage.setItem(scopedKey(WORKSPACE_STORE_KEY), JSON.stringify(store));
    return true;
  } catch {
    return false;
  }
}

export function clearWorkspaceStore(): void {
  try {
    window.localStorage.removeItem(scopedKey(WORKSPACE_STORE_KEY));
  } catch {
    // Nothing to clean up if storage is unavailable.
  }
}
