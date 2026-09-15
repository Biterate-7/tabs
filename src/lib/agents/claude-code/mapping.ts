import { scopedKey } from "@/lib/storage/namespace";
import { isValidTimestamp } from "@/lib/timestamps";

/**
 * Which TabDump workspace a Claude Code project belongs to.
 *
 * The mapping is **explicit and nothing else**. TabDump never guesses a
 * session's workspace from the currently selected one, from a similar-looking
 * name, from a git branch, or from tabs that happen to resemble the project.
 * A wrong guess here would file someone's work under the wrong project and
 * link it to unrelated tabs, and there is no signal on the machine that could
 * make such a guess reliable — so the user says, once, and TabDump remembers.
 *
 * Account-scoped through the same `scopedKey` mechanism every other TabDump
 * domain uses, so one account's mappings are invisible to another.
 */

const STORAGE_KEY = "tabdump:claude-code-mapping:v1";

export type ProjectMapping = {
  /** Absolute project path exactly as Claude Code reported it in `cwd`. */
  projectPath: string;
  workspaceId: string;
  createdAt: number;
};

export type ProjectMappingState = {
  version: 1;
  mappings: ProjectMapping[];
};

export function defaultMappingState(): ProjectMappingState {
  return { version: 1, mappings: [] };
}

/**
 * Compares project paths.
 *
 * Case-insensitive and separator-insensitive because Windows reports the same
 * directory as `C:\Users\x` and `C:/Users/x` depending on who is writing, and
 * a mapping that silently failed to match on that basis would look exactly
 * like a session refusing to attach for no reason. Trailing separators are
 * dropped for the same reason.
 *
 * This is normalisation of one identifier, not fuzzy matching: two different
 * directories never compare equal.
 */
export function projectKey(projectPath: string): string {
  return projectPath.replace(/[\\/]+/g, "/").replace(/\/+$/, "").toLowerCase();
}

export function findWorkspaceForProject(
  state: ProjectMappingState,
  projectPath: string
): string | undefined {
  const key = projectKey(projectPath);
  return state.mappings.find((mapping) => projectKey(mapping.projectPath) === key)?.workspaceId;
}

/**
 * Maps a project to a workspace, replacing any previous mapping for it.
 *
 * One project maps to exactly one workspace: a project in two workspaces
 * would make "which run owns this session" ambiguous, and Phase 11 gives a
 * run exactly one workspace anyway.
 */
export function setProjectMapping(
  state: ProjectMappingState,
  projectPath: string,
  workspaceId: string,
  now: number
): ProjectMappingState {
  const path = projectPath.trim();
  const workspace = workspaceId.trim();
  if (!path || !workspace) return state;

  const key = projectKey(path);
  const others = state.mappings.filter((mapping) => projectKey(mapping.projectPath) !== key);

  return {
    ...state,
    mappings: [...others, { projectPath: path, workspaceId: workspace, createdAt: now }],
  };
}

export function removeProjectMapping(
  state: ProjectMappingState,
  projectPath: string
): ProjectMappingState {
  const key = projectKey(projectPath);
  const kept = state.mappings.filter((mapping) => projectKey(mapping.projectPath) !== key);
  return kept.length === state.mappings.length ? state : { ...state, mappings: kept };
}

/** Drops mappings whose workspace has since been deleted, so a stale one cannot attach a run to nothing. */
export function pruneProjectMappings(
  state: ProjectMappingState,
  validWorkspaceIds: Set<string>
): ProjectMappingState {
  const kept = state.mappings.filter((mapping) => validWorkspaceIds.has(mapping.workspaceId));
  return kept.length === state.mappings.length ? state : { ...state, mappings: kept };
}

/** Never throws — unreadable mapping state degrades to "nothing is mapped yet". */
export function loadProjectMappings(): ProjectMappingState {
  try {
    const raw = window.localStorage.getItem(scopedKey(STORAGE_KEY));
    if (!raw) return defaultMappingState();

    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object") return defaultMappingState();

    const record = parsed as Record<string, unknown>;
    if (record.version !== 1 || !Array.isArray(record.mappings)) return defaultMappingState();

    const mappings: ProjectMapping[] = [];
    const seen = new Set<string>();
    for (const entry of record.mappings) {
      if (!entry || typeof entry !== "object") continue;
      const { projectPath, workspaceId, createdAt } = entry as Record<string, unknown>;
      if (typeof projectPath !== "string" || !projectPath) continue;
      if (typeof workspaceId !== "string" || !workspaceId) continue;

      const key = projectKey(projectPath);
      if (seen.has(key)) continue;
      seen.add(key);

      mappings.push({
        projectPath,
        workspaceId,
        createdAt: isValidTimestamp(createdAt) ? createdAt : 0,
      });
    }

    return { version: 1, mappings };
  } catch {
    return defaultMappingState();
  }
}

export function saveProjectMappings(state: ProjectMappingState): boolean {
  try {
    window.localStorage.setItem(scopedKey(STORAGE_KEY), JSON.stringify(state));
    return true;
  } catch {
    return false;
  }
}

export const CLAUDE_MAPPING_STORAGE_KEY = STORAGE_KEY;
