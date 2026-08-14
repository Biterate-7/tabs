import type { DriveFileMetadata } from "./drive-metadata";

export type { DriveFileMetadata };

export type ResolveTitlesResult = {
  authenticated: boolean;
  metadataByFileId: Map<string, DriveFileMetadata | null>;
};

const cache = new Map<string, DriveFileMetadata | null>();

export async function resolveGoogleFileTitles(fileIds: string[]): Promise<ResolveTitlesResult> {
  if (fileIds.length === 0) {
    return { authenticated: true, metadataByFileId: new Map() };
  }

  const uncached = fileIds.filter((id) => !cache.has(id));
  if (uncached.length === 0) {
    return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
  }

  try {
    const response = await fetch("/api/google/drive-metadata", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ fileIds: uncached }),
    });

    if (!response.ok) {
      return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
    }

    const data = (await response.json()) as {
      authenticated: boolean;
      results: Record<string, DriveFileMetadata | null>;
    };

    if (!data.authenticated) {
      return { authenticated: false, metadataByFileId: pickFromCache(fileIds) };
    }

    for (const [fileId, metadata] of Object.entries(data.results)) {
      cache.set(fileId, metadata);
    }

    return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
  } catch {
    return { authenticated: true, metadataByFileId: pickFromCache(fileIds) };
  }
}

function pickFromCache(fileIds: string[]): Map<string, DriveFileMetadata | null> {
  const out = new Map<string, DriveFileMetadata | null>();
  for (const id of fileIds) {
    if (cache.has(id)) out.set(id, cache.get(id) ?? null);
  }
  return out;
}

export function __resetGoogleTitleCacheForTests(): void {
  cache.clear();
}
