export type DriveFileMetadata = {
  name: string;
  mimeType: string;
};

const DRIVE_FILE_FIELDS = "id,name,mimeType";
const REQUEST_TIMEOUT_MS = 5000;

export async function fetchDriveFileMetadata(
  fileId: string,
  accessToken: string
): Promise<DriveFileMetadata | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);

  try {
    const url = `https://www.googleapis.com/drive/v3/files/${encodeURIComponent(
      fileId
    )}?fields=${encodeURIComponent(DRIVE_FILE_FIELDS)}`;

    const response = await fetch(url, {
      headers: { Authorization: `Bearer ${accessToken}` },
      signal: controller.signal,
    });

    if (!response.ok) return null;

    const data = (await response.json()) as { name?: string; mimeType?: string };
    if (!data.name) return null;

    return { name: data.name, mimeType: data.mimeType ?? "" };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}
