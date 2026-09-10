import { scopedKey } from "@/lib/storage/namespace";
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

export function loadWorkspaceStore(): WorkspaceStore | null {
  try {
    const raw = window.localStorage.getItem(scopedKey(WORKSPACE_STORE_KEY));
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    return isValidWorkspaceStore(parsed) ? parsed : null;
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
