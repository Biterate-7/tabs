import { loadCollectionState } from "@/lib/collections/persistence"
import { loadDependencyState } from "@/lib/dependencies/persistence"
import { getProjectContents } from "@/lib/resources/content-store"
import { NAMESPACE_PREFIX, getStorageNamespace, setStorageNamespace } from "@/lib/storage/namespace"
import { buildWorkspaceExport, serializeWorkspaceExport } from "@/lib/workspace/json-export"
import { isValidWorkspaceStore, loadWorkspaceStore } from "@/lib/workspace/persistence"
import type { ResourceContent } from "@/lib/resources/types"

/**
 * Projects people made with Hubble on the web, before Hubble became a
 * desktop app — still in this browser's storage for the website's origin.
 *
 * The website no longer runs the app, but nothing it stored was deleted:
 * localStorage and IndexedDB for this origin still hold every project, note
 * and saved text, per account namespace (src/lib/storage/namespace.ts). This
 * module finds that data and writes it out in Hubble's own export format
 * (json-export.ts, version 1) — the format Hubble Desktop's
 * Settings → Projects → Import projects reads and validates (json-import.ts), so a
 * project moves to the app losslessly: projects, links, notes, collections,
 * dependencies and the saved text of conversations, pages and files.
 *
 * Read-only. Nothing here writes to, clears or migrates the browser's
 * copy, so a failed or abandoned move costs nothing.
 */

const SIGNED_OUT_KEY = "tabdump:workspaces:v1"
const NAMESPACED_KEY = new RegExp(`^${NAMESPACE_PREFIX.replace(/:/g, ":")}([^:]{1,200}):workspaces:v1$`)

export type BrowserProjects = {
  /** The account namespace the projects are kept under; null for projects made while signed out. */
  namespace: string | null
  /** How many projects hold anything. */
  projects: number
  /** Links and notes across them. */
  items: number
}

function readStore(key: string) {
  try {
    const raw = window.localStorage.getItem(key)
    if (!raw) return null
    const parsed: unknown = JSON.parse(raw)
    return isValidWorkspaceStore(parsed) ? parsed : null
  } catch {
    return null
  }
}

/** Every set of web-era projects in this browser that holds something, signed-out first. Empty when there are none (or storage can't be read). */
export function findBrowserProjects(): BrowserProjects[] {
  if (typeof window === "undefined") return []
  const namespaces: (string | null)[] = [null]
  try {
    for (let index = 0; index < window.localStorage.length; index++) {
      const match = window.localStorage.key(index)?.match(NAMESPACED_KEY)
      if (match) namespaces.push(match[1]!)
    }
  } catch {
    return []
  }
  const found: BrowserProjects[] = []
  for (const namespace of namespaces) {
    const store = readStore(namespace ? `${NAMESPACE_PREFIX}${namespace}:workspaces:v1` : SIGNED_OUT_KEY)
    if (!store) continue
    const filled = store.workspaces.filter((workspace) => workspace.tabs.length > 0 || (workspace.notes?.length ?? 0) > 0)
    if (filled.length === 0) continue
    found.push({
      namespace,
      projects: filled.length,
      items: filled.reduce((sum, workspace) => sum + workspace.tabs.length + (workspace.notes?.length ?? 0), 0),
    })
  }
  return found
}

/**
 * One account's web-era projects as a Hubble export file (JSON text), with
 * their saved text. The namespace is switched only for the duration of the
 * read and always restored.
 */
export async function exportBrowserProjects(namespace: string | null): Promise<{ text: string; projects: number; textUnreadable: string[] }> {
  const previous = getStorageNamespace()
  setStorageNamespace(namespace)
  try {
    const store = loadWorkspaceStore()
    if (!store) throw new Error("no-projects")
    const contents = new Map<string, Map<string, ResourceContent>>()
    // A project whose saved text can't be read still exports its links and notes; its name is reported, never hidden.
    const textUnreadable: string[] = []
    for (const workspace of store.workspaces) {
      try {
        contents.set(workspace.id, await getProjectContents(workspace.id))
      } catch {
        textUnreadable.push(workspace.name)
      }
    }
    const data = buildWorkspaceExport([...store.workspaces], loadDependencyState().dependencies, loadCollectionState().collections, contents)
    return { text: serializeWorkspaceExport(data), projects: store.workspaces.length, textUnreadable }
  } finally {
    setStorageNamespace(previous)
  }
}
